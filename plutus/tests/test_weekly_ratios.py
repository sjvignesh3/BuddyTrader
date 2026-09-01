"""Weekly Screener ratios worker — offline tests."""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Dict, List, Optional

from plutus.adapters.result import Result
from plutus.adapters.supabase_client import UpsertReport
from plutus.sync.weekly_ratios import (
    RATIOS_TABLE,
    WeeklyRatiosWorker,
    row_from_ratios,
)


def _ok_fetch(sym):
    return Result.success({
        "current_pe": Decimal("16.2"),
        "current_pb": Decimal("8.00"),
        "market_cap_cr": Decimal("869924"),
        "current_price": Decimal("2369"),
        "book_value": Decimal("296"),
        "_raw_map": {"ROCE": "63.0"},
    }, symbol=sym, attempts=1)


def _fail_fetch(sym):
    if sym == "BROKEN.NS":
        return Result.failure("boom", symbol=sym, attempts=1)
    return _ok_fetch(sym)


@dataclass
class _FakeUpsert:
    calls: List[Dict[str, Any]] = field(default_factory=list)
    fail_table: Optional[str] = None

    def __call__(self, table, rows, *, conflict_cols, client=None):
        self.calls.append({"table": table, "rows": list(rows),
                           "conflict_cols": list(conflict_cols)})
        if table == self.fail_table:
            return UpsertReport(table=table, total_rows=len(rows),
                                succeeded=0, failed=len(rows), chunks=1,
                                latency_ms=1, errors=["simulated"])
        return UpsertReport(table=table, total_rows=len(rows),
                            succeeded=len(rows), failed=0, chunks=1,
                            latency_ms=1, errors=[])


class TestRowFromRatios:
    def test_crore_to_absolute(self):
        row = row_from_ratios("TCS.NS", _ok_fetch("TCS.NS").value)
        assert row["market_cap"] == Decimal("8699240000000.00")  # 8,69,924 Cr
        assert row["pe"] == Decimal("16.2")
        assert row["pb"] == Decimal("8.00")
        assert row["symbol"] == "TCS.NS"
        assert row["raw_ratios"] == {"ROCE": "63.0"}

    def test_empty_ratios_returns_none(self):
        assert row_from_ratios("X.NS", {}) is None
        assert row_from_ratios("X.NS", {"_raw_map": {}}) is None


class TestWorker:
    def test_happy_run(self):
        up = _FakeUpsert()
        w = WeeklyRatiosWorker(fetch_ratios=_ok_fetch, upsert=up)
        rep = w.run_all(["TCS.NS", "RELIANCE.NS"])
        assert rep.symbols_ok == 2
        assert rep.symbols_failed == 0
        assert rep.rows_written == 2
        call = next(c for c in up.calls if c["table"] == RATIOS_TABLE)
        assert call["conflict_cols"] == ["symbol"]
        job = next(c for c in up.calls if c["table"] == "sync_jobs")
        assert job["rows"][0]["job_type"] == "weekly_ratios"

    def test_per_symbol_isolation(self):
        up = _FakeUpsert()
        w = WeeklyRatiosWorker(fetch_ratios=_fail_fetch, upsert=up)
        rep = w.run_all(["A.NS", "BROKEN.NS", "B.NS"])
        assert rep.symbols_ok == 2
        assert rep.symbols_failed == 1

    def test_dry_run_writes_nothing(self):
        up = _FakeUpsert()
        w = WeeklyRatiosWorker(fetch_ratios=_ok_fetch, upsert=up)
        rep = w.run_all(["A.NS"], dry_run=True)
        assert up.calls == []
        assert rep.rows_written == 0
        assert rep.sync_job_id is None

    def test_upsert_failure_recorded(self):
        up = _FakeUpsert(fail_table=RATIOS_TABLE)
        w = WeeklyRatiosWorker(fetch_ratios=_ok_fetch, upsert=up)
        rep = w.run_all(["A.NS"])
        assert rep.upsert_errors == ["simulated"]

    def test_auth_failure_aborts_early(self):
        # Default fetcher + no credentials (conftest strips them) -> the
        # pre-flight login fails and every symbol is marked failed without
        # a single fetch or sleep.
        up = _FakeUpsert()
        w = WeeklyRatiosWorker(upsert=up)
        rep = w.run_all(["A.NS", "B.NS"])
        assert rep.symbols_failed == 2
        assert all("screener auth" in (s.error or "") for s in rep.per_symbol)
        assert not any(c["table"] == RATIOS_TABLE for c in up.calls)
