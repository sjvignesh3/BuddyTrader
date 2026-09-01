"""Quarterly worker tests — no screener.in network, no Supabase."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional

import pytest

from plutus.adapters.result import Result
from plutus.adapters.supabase_client import UpsertReport
from plutus.sync.quarterly import (
    QuarterlySyncWorker,
    apply_manual_overrides,
)


def _ok_fetch(sym):
    """Screener-bundle-shaped payload (see ScreenerClient.fetch_bundle)."""
    return Result.success({
        "symbol": sym,
        "quarterly": [
            {"quarter_label": "Jun 2024",
             "quarter_end_date": date(2024, 6, 30),
             "sales": Decimal("9000"), "opm_pct": Decimal("25"),
             "pbt": Decimal("2200"), "net_profit": Decimal("1800")},
            {"quarter_label": "Sep 2024",
             "quarter_end_date": date(2024, 9, 30),
             "sales": Decimal("10000"), "opm_pct": Decimal("26"),
             "pbt": Decimal("2500"), "net_profit": Decimal("2000")},
        ],
        "ratios": {"roce": Decimal("30.0"), "roe": Decimal("25.0"),
                   "net_debt_to_equity": Decimal("0.10"),
                   "pledged_pct": Decimal("0.00"),
                   "pe_5yr_avg": Decimal("22.0"), "pb_5yr_avg": Decimal("4.0"),
                   "_raw_map": {"ROCE": "30.0"}},
        "shareholding": {"promoter_holding_pct": Decimal("50.0"),
                         "institutional_pct": Decimal("30.0"),
                         "public_holding_pct": Decimal("20.0")},
    }, symbol=sym, attempts=1)


def _fail_fetch(sym):
    if sym == "BROKEN.NS":
        return Result.failure("boom", symbol=sym, attempts=3)
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


class TestQuarterlyWorker:
    def test_happy_run_all(self):
        up = _FakeUpsert()
        w = QuarterlySyncWorker(fetch_quarterly=_ok_fetch, upsert=up)
        rep = w.run_all(["RELIANCE.NS"], as_of=date(2024, 10, 1))
        assert rep.symbols_ok == 1
        assert rep.symbols_failed == 0
        assert rep.rows_written == 2   # two quarterly rows

        snap_call = next(c for c in up.calls if c["table"] == "fundamentals")
        assert snap_call["conflict_cols"] == ["symbol", "quarter_end_date"]
        row = snap_call["rows"][0]
        assert row["symbol"] == "RELIANCE.NS"
        assert isinstance(row["sales"], Decimal)

        # sync_jobs bookkeeping
        job_call = next(c for c in up.calls if c["table"] == "sync_jobs")
        assert job_call["conflict_cols"] == ["job_type", "as_of_date"]

    def test_per_symbol_failure_isolated(self):
        up = _FakeUpsert()
        w = QuarterlySyncWorker(fetch_quarterly=_fail_fetch, upsert=up)
        rep = w.run_all(["A.NS", "BROKEN.NS", "B.NS"])
        assert rep.symbols_ok == 2
        assert rep.symbols_failed == 1
        assert any("boom" in (s.error or "") for s in rep.per_symbol)

    def test_dry_run_writes_nothing(self):
        up = _FakeUpsert()
        w = QuarterlySyncWorker(fetch_quarterly=_ok_fetch, upsert=up)
        rep = w.run_all(["A.NS"], dry_run=True)
        assert up.calls == []
        assert rep.rows_written == 0
        assert rep.sync_job_id is None

    def test_upsert_failure_recorded(self):
        up = _FakeUpsert(fail_table="fundamentals")
        w = QuarterlySyncWorker(fetch_quarterly=_ok_fetch, upsert=up)
        rep = w.run_all(["A.NS"])
        assert rep.upsert_errors == ["simulated"]
        assert rep.rows_written == 0


class TestManualOverrides:
    def test_roundtrip(self):
        up = _FakeUpsert()
        rows = [
            {"symbol": "RELIANCE.NS", "quarter_end_date": "2024-09-30",
             "roce": "18.4", "roe": "12.1", "promoter_pledging_pct": "0.0"},
        ]
        result = apply_manual_overrides(rows, upsert=up)
        assert result["rows_written"] == 1
        assert result["errors"] == []
        call = up.calls[0]
        assert call["table"] == "fundamentals"
        assert call["conflict_cols"] == ["symbol", "quarter_end_date"]
        row = call["rows"][0]
        assert row["roce"] == Decimal("18.4")
        assert row["roe"] == Decimal("12.1")
        assert row["promoter_holding_source"] == "manual"
        assert row["data_source"] == "manual_csv"
        assert row["quarter_end_date"] == date(2024, 9, 30)

    def test_bad_row_captured(self):
        up = _FakeUpsert()
        result = apply_manual_overrides(
            [{"nope": "no symbol here"}], upsert=up)
        assert result["rows_written"] == 0
        assert result["errors"]
        assert up.calls == []

    def test_empty_input(self):
        up = _FakeUpsert()
        result = apply_manual_overrides([], upsert=up)
        assert result == {"rows_written": 0, "errors": []}
        assert up.calls == []
