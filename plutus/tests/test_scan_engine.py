"""
Stage 6 scan engine — end-to-end tests with dependency-injected snapshot
loader and upsert. Zero network, zero DB.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional

import pytest

from plutus.adapters.supabase_client import UpsertReport
from plutus.scan.engine import ScanEngine, _build_scan_result_row, _json_safe
from plutus.scan.base import STATUS_BUY_ZONE, STATUS_NO_SIGNAL


# ---------------------------------------------------------------------------
# Fake snapshots + fakes
# ---------------------------------------------------------------------------
def _snap(sym, below_dma, dist_low, stock_id=1, has_rally=False):
    return {
        "symbol": sym,
        "stock_id": stock_id,
        "snapshot_date": date(2024, 6, 1),
        "close": Decimal("100"),
        "dma_200": Decimal("150"),
        "below_200dma_pct": Decimal(str(below_dma)),
        "high_52w": Decimal("200"),
        "low_52w": Decimal("90"),
        "distance_from_52w_low_pct": Decimal(str(dist_low)),
        "distance_from_52w_high_pct": Decimal("50"),
        "has_valid_20pct_rally": has_rally,
        "last_rally_pct": Decimal("22") if has_rally else Decimal("0"),
        "last_rally_low": Decimal("80"),
        "last_rally_high": Decimal("100"),
        "last_rally_start_date": None,
        "last_rally_end_date": None,
        "days_since_last_rally": None,
    }


def _snapshots(pool_code, snapshot_date):
    return [
        _snap("A.NS", below_dma=Decimal("15"), dist_low=Decimal("0.3"), stock_id=101),  # buy zone envelope + 52w
        _snap("B.NS", below_dma=Decimal("10"), dist_low=Decimal("2.0"), stock_id=102),  # opportunity both
        _snap("C.NS", below_dma=Decimal("2"),  dist_low=Decimal("20"),  stock_id=103, has_rally=True),  # rally valid
        _snap("D.NS", below_dma=Decimal("1"),  dist_low=Decimal("30"),  stock_id=104),  # no signals
    ]


@dataclass
class _FakeUpsert:
    calls: List[Dict[str, Any]] = field(default_factory=list)
    fail_table: Optional[str] = None

    def __call__(self, table, rows, *, conflict_cols, client=None):
        self.calls.append({
            "table": table,
            "rows": list(rows),
            "conflict_cols": list(conflict_cols),
        })
        if table == self.fail_table:
            return UpsertReport(table=table, total_rows=len(rows),
                                succeeded=0, failed=len(rows),
                                chunks=1, latency_ms=1,
                                errors=["simulated"])
        return UpsertReport(table=table, total_rows=len(rows),
                            succeeded=len(rows), failed=0,
                            chunks=1, latency_ms=1, errors=[])


@dataclass
class _FakeInsertScan:
    """Assigns incrementing ids and remembers rows."""
    counter: int = 0
    rows: List[Dict[str, Any]] = field(default_factory=list)

    def __call__(self, row):
        self.rows.append(dict(row))
        self.counter += 1
        return str(self.counter)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestScanEngineHappyPath:
    def test_engine_evaluates_and_writes(self):
        upserter = _FakeUpsert()
        inserter = _FakeInsertScan()
        eng = ScanEngine(
            fetch_snapshots=_snapshots,
            upsert=upserter,
            insert_scan=inserter,
        )
        report = eng.run(
            pool_code="F40",
            snapshot_date=date(2024, 6, 1),
            strategy_ids=["envelope_200dma", "week52_high_low", "rally_20_percent"],
        )
        assert report.total_stocks == 4
        # A: BZ + BZ + INVALID  (2 opps)
        # B: OPP + OPP + INVALID (2)
        # C: NO_SIGNAL + NO_SIGNAL + VALID (1)
        # D: NO_SIGNAL x 3 (0)
        assert report.opportunities_count == 5
        assert report.scan_id == "1"
        assert report.result_rows_written == 12  # 4 stocks * 3 strategies
        # scan row was inserted first
        assert len(inserter.rows) == 1
        scan_row = inserter.rows[0]
        assert scan_row["pool_code"] == "F40"
        assert scan_row["triggered_by"] == "manual"
        assert scan_row["total_stocks"] == 4
        # scan_results upserted with the right conflict cols
        sr_calls = [c for c in upserter.calls if c["table"] == "scan_results"]
        assert len(sr_calls) == 1
        assert sr_calls[0]["conflict_cols"] == ["scan_id", "symbol", "strategy_id"]
        # each result row has scan_id populated
        for r in sr_calls[0]["rows"]:
            assert r["scan_id"] == "1"

    def test_dry_run_writes_nothing(self):
        upserter = _FakeUpsert()
        inserter = _FakeInsertScan()
        eng = ScanEngine(
            fetch_snapshots=_snapshots,
            upsert=upserter,
            insert_scan=inserter,
        )
        report = eng.run(
            pool_code="F40",
            snapshot_date=date(2024, 6, 1),
            strategy_ids=["envelope_200dma"],
            dry_run=True,
        )
        assert report.total_stocks == 4
        assert report.dry_run is True
        assert report.scan_id is None
        assert report.result_rows_written == 0
        assert upserter.calls == []
        assert inserter.rows == []

    def test_no_snapshots_returns_empty_report(self):
        upserter = _FakeUpsert()
        inserter = _FakeInsertScan()
        eng = ScanEngine(
            fetch_snapshots=lambda p, d: [],
            upsert=upserter,
            insert_scan=inserter,
        )
        report = eng.run(
            pool_code="F40",
            snapshot_date=date(2024, 6, 1),
            strategy_ids=["envelope_200dma"],
        )
        assert report.total_stocks == 0
        assert report.opportunities_count == 0


class TestScanEngineIdempotency:
    def test_second_run_uses_same_conflict_key(self):
        upserter = _FakeUpsert()
        inserter = _FakeInsertScan()
        eng = ScanEngine(
            fetch_snapshots=_snapshots,
            upsert=upserter,
            insert_scan=inserter,
        )
        eng.run(pool_code="F40", snapshot_date=date(2024, 6, 1),
                strategy_ids=["envelope_200dma"])
        eng.run(pool_code="F40", snapshot_date=date(2024, 6, 1),
                strategy_ids=["envelope_200dma"])
        # scan insert called twice with same conflict tuple
        assert len(inserter.rows) == 2
        for row in inserter.rows:
            assert row["pool_code"] == "F40"
            assert row["snapshot_date"] == "2024-06-01"
            assert row["triggered_by"] == "manual"


class TestScanEngineErrorIsolation:
    def test_strategy_exception_becomes_error_row(self, monkeypatch):
        upserter = _FakeUpsert()
        inserter = _FakeInsertScan()

        # Monkeypatch the envelope strategy to blow up on symbol B.NS.
        from plutus.scan.strategies import envelope
        orig = envelope.EnvelopeStrategy.evaluate

        def _bad(self, snap, cfg):
            if snap.get("symbol") == "B.NS":
                raise RuntimeError("boom")
            return orig(self, snap, cfg)
        monkeypatch.setattr(envelope.EnvelopeStrategy, "evaluate", _bad)

        eng = ScanEngine(
            fetch_snapshots=_snapshots,
            upsert=upserter,
            insert_scan=inserter,
        )
        report = eng.run(
            pool_code="F40",
            snapshot_date=date(2024, 6, 1),
            strategy_ids=["envelope_200dma"],
        )
        errs = [r for r in report.per_result if r.error]
        assert len(errs) == 1
        assert errs[0].symbol == "B.NS"
        # Other 3 symbols still evaluated successfully.
        clean = [r for r in report.per_result if not r.error]
        assert len(clean) == 3

    def test_upsert_failure_recorded_not_raised(self):
        upserter = _FakeUpsert(fail_table="scan_results")
        inserter = _FakeInsertScan()
        eng = ScanEngine(
            fetch_snapshots=_snapshots,
            upsert=upserter,
            insert_scan=inserter,
        )
        report = eng.run(
            pool_code="F40",
            snapshot_date=date(2024, 6, 1),
            strategy_ids=["envelope_200dma"],
        )
        assert report.upsert_errors == ["simulated"]
        assert report.result_rows_written == 0


class TestScanEngineFundamentalsMerge:
    def test_fundamentals_merged_into_snapshot(self):
        def _snaps(_p, _d):
            return [{
                "symbol": "X",
                "stock_id": 1,
                "close": Decimal("100"),
                "dma_200": Decimal("150"),
                "below_200dma_pct": Decimal("2"),
                "distance_from_52w_low_pct": Decimal("30"),
                "distance_from_52w_high_pct": Decimal("30"),
                "low_52w": Decimal("90"),
                "high_52w": Decimal("200"),
                # pe_current / pb_current live on daily_snapshots (Tier A).
                "pe_current": Decimal("18"),
                "pb_current": Decimal("2.5"),
                "has_valid_20pct_rally": False,
                "last_rally_pct": Decimal("0"),
                "last_rally_low": None,
                "last_rally_high": None,
                "last_rally_start_date": None,
                "last_rally_end_date": None,
                "days_since_last_rally": None,
            }]

        def _funds(symbols):
            return {"X": {
                "pe_current": Decimal("18"),
                "pe_5y_avg": Decimal("22"),
                "pb_current": Decimal("2.5"),
                "pb_5y_avg": Decimal("3.0"),
                "roce": Decimal("20"),
                "roe": Decimal("20"),
                "net_debt_to_equity": Decimal("0.15"),
                "promoter_pledging_pct": Decimal("0"),
                # Quarter aggregates (the 11-check score's ATH/YoY rules).
                "latest_q_sales": Decimal("100"),
                "latest_q_pbt": Decimal("20"),
                "latest_q_net_profit": Decimal("15"),
                "ath_q_sales": Decimal("100"),
                "ath_q_pbt": Decimal("20"),
                "ath_q_net_profit": Decimal("15"),
                "yoy_q_net_profit": Decimal("12"),
                "prev_q_net_profit": Decimal("14"),
            }}

        upserter = _FakeUpsert()
        inserter = _FakeInsertScan()
        eng = ScanEngine(
            fetch_snapshots=_snaps,
            fetch_fundamentals=_funds,
            upsert=upserter,
            insert_scan=inserter,
        )
        report = eng.run(
            pool_code="F40",
            snapshot_date=date(2024, 6, 1),
            strategy_ids=["fundamental_screener"],
        )
        # 1 stock, all 11 checks pass → 11 points, PASS is an opportunity.
        assert report.opportunities_count == 1
        assert report.per_result[0].status == "PASS"
        assert report.per_result[0].score == 11


class TestQuarterAggregates:
    def test_yoy_matches_same_month_last_year(self):
        from plutus.scan.engine import _quarter_aggregates
        rows = [  # newest first — quarterly cadence with a matching Jun 2023
            {"quarter_end_date": date(2024, 6, 30), "quarter_label": "Jun 2024",
             "sales": Decimal("100"), "pbt": Decimal("20"), "net_profit": Decimal("15")},
            {"quarter_end_date": date(2024, 3, 31), "quarter_label": "Mar 2024",
             "sales": Decimal("90"), "pbt": Decimal("18"), "net_profit": Decimal("18")},
            {"quarter_end_date": date(2023, 12, 31), "quarter_label": "Dec 2023",
             "sales": Decimal("80"), "pbt": Decimal("16"), "net_profit": Decimal("12")},
            {"quarter_end_date": date(2023, 6, 30), "quarter_label": "Jun 2023",
             "sales": Decimal("70"), "pbt": Decimal("14"), "net_profit": Decimal("10")},
        ]
        agg = _quarter_aggregates(rows)
        assert agg["yoy_q_net_profit"] == Decimal("10")   # Jun 2023
        assert agg["yoy_quarter_label"] == "Jun 2023"
        assert agg["prev_q_net_profit"] == Decimal("18")  # Mar 2024
        assert agg["latest_q_net_profit"] == Decimal("15")

    def test_yoy_none_when_same_quarter_missing(self):
        from plutus.scan.engine import _quarter_aggregates
        rows = [
            {"quarter_end_date": date(2024, 6, 30),
             "sales": Decimal("100"), "pbt": Decimal("20"), "net_profit": Decimal("15")},
            {"quarter_end_date": date(2024, 3, 31),
             "sales": Decimal("90"), "pbt": Decimal("18"), "net_profit": Decimal("18")},
        ]
        agg = _quarter_aggregates(rows)
        assert agg["yoy_q_net_profit"] is None

    def test_yoy_works_with_iso_string_dates(self):
        # PostgREST returns quarter_end_date as an ISO string.
        from plutus.scan.engine import _quarter_aggregates
        rows = [
            {"quarter_end_date": "2024-06-30", "quarter_label": "Jun 2024",
             "sales": Decimal("100"), "pbt": Decimal("20"), "net_profit": Decimal("15")},
            {"quarter_end_date": "2023-06-30", "quarter_label": "Jun 2023",
             "sales": Decimal("70"), "pbt": Decimal("14"), "net_profit": Decimal("10")},
        ]
        agg = _quarter_aggregates(rows)
        assert agg["yoy_q_net_profit"] == Decimal("10")


class TestScanEngineHelpers:
    def test_json_safe_stringifies_decimals(self):
        payload = {"a": Decimal("1.23"), "b": [Decimal("4"), "s"], "c": {"d": Decimal("5")}}
        out = _json_safe(payload)
        assert out == {"a": "1.23", "b": ["4", "s"], "c": {"d": "5"}}

    def test_build_scan_result_row_shape(self):
        from plutus.scan.base import StrategyResult
        res = StrategyResult(
            strategy_id="envelope_200dma",
            strategy_name="Envelope",
            symbol="X",
            status=STATUS_BUY_ZONE,
            score=100,
            reasons=["r1"],
            metrics_snapshot={"below_200dma_pct": Decimal("15")},
        )
        row = _build_scan_result_row(result=res, stock_id=42)
        assert row["symbol"] == "X"
        assert row["strategy_id"] == "envelope_200dma"
        assert row["status"] == STATUS_BUY_ZONE
        assert row["stock_id"] == 42
        assert row["reasons"] == ["r1"]
        assert row["metrics_snapshot"] == {"below_200dma_pct": "15"}
        assert row["fundamentals_check"] == {}
