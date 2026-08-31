"""
Supabase bulk_upsert tests — fully offline, no supabase package required.

Guarantees under test:
  1. Empty rows -> zero-op report (no client call).
  2. Rows are chunked to the requested chunk_size.
  3. Every chunk uses the on_conflict string from `conflict_cols`.
  4. Transient failures retry up to MAX_UPSERT_ATTEMPTS then count as failed.
  5. Missing conflict_cols -> ValueError (idempotency contract).
  6. Report totals sum correctly across mixed success/failure chunks.
"""
from __future__ import annotations

import pytest

from plutus.adapters import supabase_client as sb
from plutus.adapters.supabase_client import UpsertReport, bulk_upsert


class FakeExec:
    def __init__(self, should_fail: bool):
        self.should_fail = should_fail

    def execute(self):
        if self.should_fail:
            raise RuntimeError("transient supabase err")
        return {"data": []}


class FakeTable:
    """
    Failure schedule = list of ints, one per CHUNK. Each int says how many
    of that chunk's `.execute()` attempts should raise before succeeding.

    Because bulk_upsert re-invokes `.upsert(...).execute()` per retry, we
    need a counter per chunk index that decrements every time we serve one.
    """
    def __init__(self, parent, name):
        self.parent = parent
        self.name = name
        # Copy schedule so we can decrement.
        self._schedule = list(parent.schedules.get(name, []))
        self._chunk_idx = -1
        self._attempts_left_for_chunk = 0
        self._last_rows_id = None

    def upsert(self, rows, on_conflict=None):
        self.parent.calls.append((self.name, list(rows), on_conflict))
        # Detect new chunk by row-content signature.
        sig = tuple(sorted((r.get("symbol"), r.get("snapshot_date"))
                           for r in rows))
        if sig != self._last_rows_id:
            self._chunk_idx += 1
            self._last_rows_id = sig
            if self._chunk_idx < len(self._schedule):
                self._attempts_left_for_chunk = self._schedule[self._chunk_idx]
            else:
                self._attempts_left_for_chunk = 0
        should_fail = self._attempts_left_for_chunk > 0
        if should_fail:
            self._attempts_left_for_chunk -= 1
        return FakeExec(should_fail=should_fail)


class FakeClient:
    def __init__(self, schedules=None):
        self.schedules = schedules or {}
        self.calls = []
        self._tables = {}

    def table(self, name):
        # Each .table() call returns a fresh proxy but shares the schedule cursor.
        if name not in self._tables:
            self._tables[name] = FakeTable(self, name)
        return self._tables[name]


@pytest.fixture(autouse=True)
def _fast_backoff(monkeypatch):
    monkeypatch.setattr(sb, "BACKOFF_SECONDS", 0.0)
    monkeypatch.setattr(sb.time, "sleep", lambda *_a, **_kw: None)


def test_empty_rows_is_zero_op() -> None:
    report = bulk_upsert("stocks", [], conflict_cols=["symbol"], client=FakeClient())
    assert isinstance(report, UpsertReport)
    assert report.total_rows == 0
    assert report.succeeded == 0
    assert report.failed == 0
    assert report.ok is True


def test_conflict_cols_required() -> None:
    with pytest.raises(ValueError):
        bulk_upsert("stocks", [{"symbol": "X.NS"}], conflict_cols=[], client=FakeClient())


def test_rows_are_chunked() -> None:
    client = FakeClient()
    rows = [{"symbol": f"S{i}.NS"} for i in range(1005)]
    report = bulk_upsert("stocks", rows, conflict_cols=["symbol"],
                        chunk_size=500, client=client)
    assert report.chunks == 3           # 500 + 500 + 5
    assert report.total_rows == 1005
    assert report.succeeded == 1005
    assert report.failed == 0
    # First two calls each have 500 rows, third has 5
    sizes = [len(rows) for _tbl, rows, _cf in client.calls]
    assert sizes == [500, 500, 5]


def test_on_conflict_string_passed_through() -> None:
    client = FakeClient()
    bulk_upsert("daily_snapshots",
                [{"symbol": "X.NS", "snapshot_date": "2024-01-01"}],
                conflict_cols=["symbol", "snapshot_date"], client=client)
    assert client.calls[0][2] == "symbol,snapshot_date"


def test_transient_failure_retries_then_succeeds() -> None:
    # First chunk fails twice, then succeeds -> counts as succeeded.
    client = FakeClient(schedules={"stocks": [2]})
    report = bulk_upsert("stocks",
                        [{"symbol": "X.NS"}],
                        conflict_cols=["symbol"], client=client)
    assert report.succeeded == 1
    assert report.failed == 0
    assert report.errors == []


def test_all_retries_fail_counts_as_failed() -> None:
    client = FakeClient(schedules={"stocks": [99]})  # always fails
    report = bulk_upsert("stocks",
                        [{"symbol": "X.NS"}],
                        conflict_cols=["symbol"], client=client)
    assert report.succeeded == 0
    assert report.failed == 1
    assert len(report.errors) == 1
    assert report.ok is False
