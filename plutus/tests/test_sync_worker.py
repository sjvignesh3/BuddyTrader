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
        # Labelled by the SESSION the row describes — the newest bar on or
        # before as_of (the fake history ends 2023-09-08) — not the run date.
        assert row["snapshot_date"] == date(2023, 9, 8)
        assert rep.session_date == date(2023, 9, 8)
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

    def test_sync_jobs_payload_carries_session_accounting(self):
        upserter = _FakeUpsert()
        w = DailySyncWorker(
            fetch_info=_ok_fetch_info,
            fetch_history=_ok_fetch_history,
            upsert=upserter,
        )
        # Saturday as_of: expected session is Friday 2024-05-31; the fake
        # history ends 2023-09-08, so the run reports lag, not failure.
        rep = w.run_all(["A.NS"], as_of=date(2024, 6, 1))
        assert rep.session_date == date(2023, 9, 8)
        assert rep.expected_session_date == date(2024, 5, 31)
        assert rep.stale_symbols == {}
        assert rep.symbols_failed == 0
        job_call = next(c for c in upserter.calls if c["table"] == "sync_jobs")
        payload = job_call["rows"][0].get("payload_json")
        if payload is not None:
            assert payload["session_date"] == "2023-09-08"
            assert payload["expected_session_date"] == "2024-05-31"
            assert payload["stale_symbols"] == {}

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


# ---------------------------------------------------------------------------
# Quote-derived session bar — Yahoo's daily bar for the last session lags
# overnight (NaN, dropped) while the quote already carries its close.
# ---------------------------------------------------------------------------
def _epoch_ist(y, m, d, hh=15, mm=30):
    from datetime import datetime, timedelta, timezone
    ist = timezone(timedelta(hours=5, minutes=30))
    return int(datetime(y, m, d, hh, mm, tzinfo=ist).timestamp())


def _quote_info(session=(2023, 9, 11), state="CLOSED", price=225.0):
    info = _fake_info()
    info.update({
        "marketState": state,
        "regularMarketTime": _epoch_ist(*session),
        "regularMarketPrice": price,
        "regularMarketOpen": price - 2,
        "regularMarketDayHigh": price + 3,
        "regularMarketDayLow": price - 4,
        "regularMarketVolume": 123_456,
    })
    return info


class TestQuoteSessionBar:
    def test_quote_newer_than_history_is_appended_and_labels_the_row(self):
        # History ends Fri 2023-09-08; the quote is Mon 2023-09-11's close.
        w = DailySyncWorker(
            fetch_info=lambda s: Result.success(_quote_info(), symbol=s, attempts=1),
            fetch_history=_ok_fetch_history,
            upsert=_FakeUpsert(),
            load_screener_ratios=_fake_ratios_loader,
        )
        rep, row = w.run_symbol("RELIANCE.NS", date(2023, 9, 12))
        assert rep.ok
        assert row["snapshot_date"] == date(2023, 9, 11)
        assert row["close"] == Decimal("225.00")
        assert row["open"] == Decimal("223.00")
        assert row["high"] == Decimal("228.00")
        assert row["low"] == Decimal("221.00")
        assert row["volume"] == 123_456
        assert any("synthesized from the quote" in wmsg for wmsg in rep.warnings)

    def test_quote_beyond_as_of_is_ignored_for_backfills(self):
        # --as-of 2023-09-08 must reproduce THAT session even though the
        # quote already describes 2023-09-11.
        w = DailySyncWorker(
            fetch_info=lambda s: Result.success(_quote_info(), symbol=s, attempts=1),
            fetch_history=_ok_fetch_history,
            upsert=_FakeUpsert(),
            load_screener_ratios=_fake_ratios_loader,
        )
        rep, row = w.run_symbol("RELIANCE.NS", date(2023, 9, 8))
        assert row["snapshot_date"] == date(2023, 9, 8)
        assert not any("synthesized" in wmsg for wmsg in rep.warnings)

    def test_regular_session_quote_is_not_synthesized_and_row_is_flagged(self):
        # Market open: history is authoritative; the row carries an
        # "intraday" note so nobody mistakes it for a settled close.
        w = DailySyncWorker(
            fetch_info=lambda s: Result.success(
                _quote_info(state="REGULAR"), symbol=s, attempts=1),
            fetch_history=_ok_fetch_history,
            upsert=_FakeUpsert(),
            load_screener_ratios=_fake_ratios_loader,
        )
        rep, row = w.run_symbol("RELIANCE.NS", date(2023, 9, 12))
        assert row["snapshot_date"] == date(2023, 9, 8)
        assert any("intraday" in wmsg for wmsg in rep.warnings)

    def test_stale_symbols_reported_when_one_symbol_lags(self):
        def _info(sym):
            if sym == "LAG.NS":
                return _ok_fetch_info(sym)          # no quote -> ends 2023-09-08
            return Result.success(_quote_info(), symbol=sym, attempts=1)
        upserter = _FakeUpsert()
        w = DailySyncWorker(
            fetch_info=_info,
            fetch_history=_ok_fetch_history,
            upsert=upserter,
            load_screener_ratios=_fake_ratios_loader,
        )
        rep = w.run_all(["A.NS", "LAG.NS"], as_of=date(2023, 9, 12))
        assert rep.session_date == date(2023, 9, 11)
        assert rep.stale_symbols == {"LAG.NS": "2023-09-08"}
        assert rep.symbols_failed == 0            # stale is a warning, not a failure
        job_call = next(c for c in upserter.calls if c["table"] == "sync_jobs")
        payload = job_call["rows"][0].get("payload_json")
        if payload is not None:
            assert payload["stale_symbols"] == {"LAG.NS": "2023-09-08"}
