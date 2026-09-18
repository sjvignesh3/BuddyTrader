"""
CLI smoke test — verifies argparse wiring and exit codes without touching
Supabase.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

import pytest

from plutus.scan.engine import ScanEngine, ScanReport, SymbolStrategyReport
from plutus.scripts import run_scan


class _StubEngine:
    def __init__(self, *, total=2, opps=1, upsert_errs=None, result_error=False):
        self.total = total
        self.opps = opps
        self.upsert_errs = upsert_errs or []
        self.result_error = result_error
        self.calls = []

    def run(self, **kwargs):
        self.calls.append(kwargs)
        now = datetime.now(timezone.utc)
        per = []
        if self.result_error:
            per.append(SymbolStrategyReport(
                symbol="X", strategy_id="envelope_200dma",
                status="ERROR", score=0, opportunity=False,
                error="boom",
            ))
        return ScanReport(
            scan_id="42" if not kwargs.get("dry_run") else None,
            pool_code=kwargs["pool_code"],
            snapshot_date=kwargs["snapshot_date"],
            triggered_by=kwargs.get("triggered_by", "manual"),
            dry_run=kwargs.get("dry_run", False),
            started_at=now,
            finished_at=now,
            strategy_ids=list(kwargs.get("strategy_ids") or []),
            total_stocks=self.total,
            opportunities_count=self.opps,
            result_rows_written=self.total,
            per_result=per,
            upsert_errors=self.upsert_errs,
        )


class _ResolvingEngine(_StubEngine):
    """Stub with the real engine's `resolve_snapshot_date` hook."""

    def __init__(self, *, resolved, **kw):
        super().__init__(**kw)
        self.resolved = resolved
        self.asked = []

    def resolve_snapshot_date(self, on_or_before):
        self.asked.append(on_or_before)
        return self.resolved


class TestCLI:
    def test_happy_path_exit_0(self, capsys):
        eng = _StubEngine()
        rc = run_scan.main(
            ["--pool", "F40", "--as-of", "2024-06-01",
             "--strategies", "envelope_200dma"],
            engine=eng,
        )
        assert rc == 0
        assert eng.calls[0]["pool_code"] == "F40"
        assert eng.calls[0]["snapshot_date"] == date(2024, 6, 1)
        assert eng.calls[0]["strategy_ids"] == ["envelope_200dma"]
        out = capsys.readouterr().out
        assert '"scan_id": "42"' in out

    def test_dry_run_passed_through(self):
        eng = _StubEngine()
        rc = run_scan.main(
            ["--pool", "F40", "--as-of", "2024-06-01", "--dry-run"],
            engine=eng,
        )
        assert rc == 0
        assert eng.calls[0]["dry_run"] is True

    def test_bad_date_returns_2(self):
        eng = _StubEngine()
        rc = run_scan.main(
            ["--pool", "F40", "--as-of", "not-a-date"],
            engine=eng,
        )
        assert rc == 2

    def test_no_snapshots_returns_2(self):
        eng = _StubEngine(total=0)
        rc = run_scan.main(
            ["--pool", "F40", "--as-of", "2024-06-01"],
            engine=eng,
        )
        assert rc == 2

    def test_upsert_error_returns_1(self):
        eng = _StubEngine(upsert_errs=["fail"])
        rc = run_scan.main(
            ["--pool", "F40", "--as-of", "2024-06-01"],
            engine=eng,
        )
        assert rc == 1

    def test_per_symbol_error_is_logged_not_fatal(self, caplog):
        # One symbol's strategy error must not fail the workflow while the
        # other results were written — it is logged as a warning instead.
        eng = _StubEngine(result_error=True)
        with caplog.at_level("WARNING", logger="plutus.run_scan"):
            rc = run_scan.main(
                ["--pool", "F40", "--as-of", "2024-06-01"],
                engine=eng,
            )
        assert rc == 0
        assert "strategy evaluation error" in caplog.text
        assert "F40/X/envelope_200dma: boom" in caplog.text

    def test_as_of_defaults_to_today_ist(self):
        eng = _StubEngine()
        rc = run_scan.main(["--pool", "F40"], engine=eng)
        assert rc == 0
        assert eng.calls[0]["snapshot_date"] == run_scan._today_ist()

    def test_resolver_picks_newest_session_on_or_before(self):
        # Rows are labelled by SESSION date: a Saturday run must scan Friday.
        eng = _ResolvingEngine(resolved=date(2024, 5, 31))
        rc = run_scan.main(
            ["--pool", "F40", "--as-of", "2024-06-01"], engine=eng)
        assert rc == 0
        assert eng.asked == [date(2024, 6, 1)]
        assert eng.calls[0]["snapshot_date"] == date(2024, 5, 31)

    def test_resolver_none_means_no_snapshots_exit_2(self):
        eng = _ResolvingEngine(resolved=None)
        rc = run_scan.main(
            ["--pool", "F40", "--as-of", "2024-06-01"], engine=eng)
        assert rc == 2
        assert eng.calls == []

    def test_triggered_by_recorded(self):
        eng = _StubEngine()
        run_scan.main(
            ["--pool", "F40", "--as-of", "2024-06-01",
             "--triggered-by", "cron"],
            engine=eng,
        )
        assert eng.calls[0]["triggered_by"] == "cron"
