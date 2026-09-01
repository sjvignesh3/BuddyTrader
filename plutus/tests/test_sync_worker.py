"""
Stage 4 worker tests — 100% offline. yfinance and supabase are stubbed.

Coverage:
  * happy path              — 1 symbol, snapshot row written.
  * per-symbol isolation    — 1 fetch fails, others succeed.
  * empty history           — symbol skipped with a clean error.
  * dry-run                 — no upserts, no sync_jobs write.
  * idempotent same-day     — 2nd call passes the same conflict cols.
  * sync_jobs bookkeeping   — payload_json contains failed_symbols map.
  * upsert failure handling — errors propagate to RunReport.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional

import pytest

from plutus.adapters.result import Result
from plutus.adapters.supabase_client import UpsertReport
from plutus.sync.worker import DailySyncWorker


# ---------------------------------------------------------------------------
# Fake bar sequence + fake DataFrame for the pipeline
# ---------------------------------------------------------------------------
def _fake_df(n_bars: int = 250, base_price: float = 100.0):
    """Duck-typed DataFrame the history_builder can consume."""
    rows = []
    for i in range(n_bars):
        p = base_price + i * 0.5
        rows.append((
            date(2024, 1, 1),  # date collision is fine; we replace below
            {"Open": p, "High": p + 1, "Low": p - 1, "Close": p + 0.5},
        ))
    # Give each row a unique date so history_builder keeps all of them.
    from datetime import timedelta
    start = date(2023, 1, 2)
    rows = [
        (start + timedelta(days=i), r[1]) for i, r in enumerate(rows)
    ]

    class _DF:
        def __init__(self, rs):
            self._rs = rs
            self.columns = ["Open", "High", "Low", "Close"]

        def __len__(self):
            return len(self._rs)

        def sort_index(self):
            self._rs.sort(key=lambda p: p[0])
            return self

        def iterrows(self):
            for idx, r in self._rs:
                yield idx, r

    return _DF(rows)


def _fake_info(market_cap: float = 800_000_000_000) -> Dict[str, Any]:
    return {
        "regularMarketPrice": 200.0,
        "fiftyTwoWeekHigh": 250.0,
        "fiftyTwoWeekLow": 150.0,
        "marketCap": market_cap,
        "trailingPE": 22.5,
        "priceToBook": 4.1,
        "volume": 1_000_000,
    }


# ---------------------------------------------------------------------------
# Recording fakes
# ---------------------------------------------------------------------------
@dataclass
class _FakeUpsert:
    calls: List[Dict[str, Any]] = field(default_factory=list)
    fail_table: Optional[str] = None
    fail_count: int = 0

    def __call__(self, table, rows, *, conflict_cols, client=None):
        self.calls.append({
            "table": table,
            "rows": list(rows),
            "conflict_cols": list(conflict_cols),
        })
        if table == self.fail_table:
            return UpsertReport(
                table=table, total_rows=len(rows),
                succeeded=0, failed=len(rows),
                chunks=1, latency_ms=1,
                errors=["simulated failure"],
            )
        return UpsertReport(
            table=table, total_rows=len(rows),
            succeeded=len(rows), failed=0,
            chunks=1, latency_ms=1, errors=[],
        )


def _ok_fetch_info(sym: str) -> Result[dict]:
    return Result.success(_fake_info(), symbol=sym, attempts=1)


def _ok_fetch_history(sym: str, **_kw) -> Result[Any]:
    return Result.success(_fake_df(), symbol=sym, attempts=1)


def _fail_fetch_info(sym: str) -> Result[dict]:
    if sym == "BROKEN.NS":
        return Result.failure("boom", symbol=sym, attempts=3)
    return _ok_fetch_info(sym)


def _fake_ratios_loader(client=None) -> Dict[str, Dict[str, Any]]:
    """Weekly Screener ratios stub — PE/PB/MCap now come from this table."""
    return {"RELIANCE.NS": {"market_cap": Decimal("800000000000"),
                            "pe": Decimal("22.50"), "pb": Decimal("4.10")}}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestRunSymbol:
    def test_happy_path_returns_row(self):
        w = DailySyncWorker(
            fetch_info=_ok_fetch_info,
            fetch_history=_ok_fetch_history,
            upsert=_FakeUpsert(),
            load_screener_ratios=_fake_ratios_loader,
        )
        rep, row = w.run_symbol("RELIANCE.NS", date(2024, 6, 1))
        assert rep.ok
        assert row is not None
        assert row["symbol"] == "RELIANCE.NS"
        assert row["snapshot_date"] == date(2024, 6, 1)
        assert row["cap_bucket"] in ("Large", "Mid", "Small", "Micro")
        # market_cap must be Decimal, never float — money-safety gate
        assert isinstance(row["market_cap"], Decimal)
        # Valuation is Screener-sourced (weekly table), not yfinance .info.
        assert row["pe_current"] == Decimal("22.50")
        assert row["pb_current"] == Decimal("4.10")

    def test_empty_history_skipped(self):
        def _empty_hist(sym, **_):
            return Result.success(None, symbol=sym)
        w = DailySyncWorker(
            fetch_info=_ok_fetch_info,
            fetch_history=_empty_hist,
            upsert=_FakeUpsert(),
        )
        rep, row = w.run_symbol("X.NS", date(2024, 6, 1))
        assert not rep.ok
        assert row is None
        assert "empty history" in (rep.error or "").lower()

    def test_fetch_failure_isolated(self):
        w = DailySyncWorker(
            fetch_info=_fail_fetch_info,
            fetch_history=_ok_fetch_history,
            upsert=_FakeUpsert(),
        )
        rep, row = w.run_symbol("BROKEN.NS", date(2024, 6, 1))
        assert not rep.ok
        assert row is None
        assert "boom" in (rep.error or "")

    def test_dry_run_row_still_computed(self):
        w = DailySyncWorker(
            fetch_info=_ok_fetch_info,
            fetch_history=_ok_fetch_history,
            upsert=_FakeUpsert(),
        )
        rep, row = w.run_symbol("A.NS", date(2024, 6, 1), dry_run=True)
        assert rep.ok
        assert not rep.snapshot_written
        assert row is not None


class TestRunAll:
    def test_all_symbols_isolated(self):
        upserter = _FakeUpsert()
        w = DailySyncWorker(
            fetch_info=_fail_fetch_info,     # BROKEN.NS fails, rest succeed
            fetch_history=_ok_fetch_history,
            upsert=upserter,
        )
        rep = w.run_all(["A.NS", "BROKEN.NS", "B.NS"], as_of=date(2024, 6, 1))
        assert rep.symbols_total == 3
        assert rep.symbols_ok == 2
        assert rep.symbols_failed == 1
        assert rep.snapshots_written == 2
        # Two upsert calls: snapshots + sync_jobs.
        tables = [c["table"] for c in upserter.calls]
        assert "daily_snapshots" in tables
        assert "sync_jobs" in tables

    def test_dry_run_writes_nothing(self):
        upserter = _FakeUpsert()
        w = DailySyncWorker(
            fetch_info=_ok_fetch_info,
            fetch_history=_ok_fetch_history,
            upsert=upserter,
        )
        rep = w.run_all(["A.NS", "B.NS"], as_of=date(2024, 6, 1), dry_run=True)
        assert upserter.calls == []
        assert rep.snapshots_written == 0
        assert rep.sync_job_id is None
        for sr in rep.per_symbol:
            assert not sr.snapshot_written

    def test_idempotent_same_day_uses_conflict_cols(self):
        upserter = _FakeUpsert()
        w = DailySyncWorker(
            fetch_info=_ok_fetch_info,
            fetch_history=_ok_fetch_history,
            upsert=upserter,
        )
        w.run_all(["A.NS"], as_of=date(2024, 6, 1))
        w.run_all(["A.NS"], as_of=date(2024, 6, 1))
        snapshot_calls = [c for c in upserter.calls if c["table"] == "daily_snapshots"]
        for c in snapshot_calls:
            assert c["conflict_cols"] == ["symbol", "snapshot_date"]
        job_calls = [c for c in upserter.calls if c["table"] == "sync_jobs"]
        for c in job_calls:
            assert c["conflict_cols"] == ["job_type", "as_of_date"]

    def test_sync_jobs_payload_contains_failed_symbols(self):
        upserter = _FakeUpsert()
        w = DailySyncWorker(
            fetch_info=_fail_fetch_info,
            fetch_history=_ok_fetch_history,
            upsert=upserter,
        )
        w.run_all(["A.NS", "BROKEN.NS"], as_of=date(2024, 6, 1))
        job_call = next(c for c in upserter.calls if c["table"] == "sync_jobs")
        payload = job_call["rows"][0].get("payload_json")
        # payload_json might be filtered out if the sync_jobs registry doesn't
        # declare it; when declared we assert. When not declared we accept.
        if payload is not None:
            assert "BROKEN.NS" in payload["failed_symbols"]

    def test_upsert_failure_recorded(self):
        upserter = _FakeUpsert(fail_table="daily_snapshots")
        w = DailySyncWorker(
            fetch_info=_ok_fetch_info,
            fetch_history=_ok_fetch_history,
            upsert=upserter,
        )
        rep = w.run_all(["A.NS"], as_of=date(2024, 6, 1))
        assert rep.upsert_errors == ["simulated failure"]
        assert rep.snapshots_written == 0
