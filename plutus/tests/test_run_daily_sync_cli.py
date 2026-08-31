"""CLI smoke tests for plutus.scripts.run_daily_sync — no network, no DB."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, List

import pytest

from plutus.scripts import run_daily_sync as cli
from plutus.sync.worker import RunReport, SymbolReport


@dataclass
class _StubWorker:
    calls: List[dict] = field(default_factory=list)
    fail: bool = False

    def run_all(self, symbols, as_of=None, *, dry_run=False):
        self.calls.append({
            "symbols": list(symbols),
            "as_of": as_of,
            "dry_run": dry_run,
        })
        now = datetime.now(timezone.utc)
        return RunReport(
            as_of_date=as_of or date.today(),
            job_type="daily_sync",
            dry_run=dry_run,
            started_at=now,
            finished_at=now,
            symbols_total=len(symbols),
            symbols_ok=0 if self.fail else len(symbols),
            symbols_failed=len(symbols) if self.fail else 0,
            snapshots_written=0 if (self.fail or dry_run) else len(symbols),
            per_symbol=[SymbolReport(symbol=s, ok=not self.fail,
                                     snapshot_written=not (self.fail or dry_run),
                                     fetch_attempts=1) for s in symbols],
        )


class TestCli:
    def test_symbols_arg_bypasses_db(self, capsys):
        w = _StubWorker()
        rc = cli.main(["--symbols", "A.NS,B.NS", "--dry-run"], worker=w)
        assert rc == 0
        assert w.calls[0]["symbols"] == ["A.NS", "B.NS"]
        assert w.calls[0]["dry_run"] is True
        out = capsys.readouterr().out
        assert "symbols_total" in out

    def test_no_symbols_returns_2(self):
        w = _StubWorker()
        rc = cli.main([], worker=w, load_symbols=lambda **_: [])
        assert rc == 2

    def test_pool_filter_forwarded(self):
        seen = {}

        def _loader(**kw):
            seen.update(kw)
            return ["X.NS"]

        w = _StubWorker()
        rc = cli.main(["--pool", "F40", "--limit", "10"],
                      worker=w, load_symbols=_loader)
        assert rc == 0
        assert seen == {"pool": "F40", "limit": 10}

    def test_failure_exits_nonzero(self):
        w = _StubWorker(fail=True)
        rc = cli.main(["--symbols", "A.NS"], worker=w)
        assert rc == 1

    def test_as_of_override(self):
        w = _StubWorker()
        rc = cli.main(["--symbols", "A.NS", "--as-of", "2024-05-15"], worker=w)
        assert rc == 0
        assert w.calls[0]["as_of"] == date(2024, 5, 15)

    def test_loader_exception_returns_2(self):
        def _bad(**_):
            raise RuntimeError("db down")

        w = _StubWorker()
        rc = cli.main([], worker=w, load_symbols=_bad)
        assert rc == 2
