"""CLI smoke tests for plutus.scripts.run_quarterly_sync — no network."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, List

import pytest

from plutus.scripts import run_quarterly_sync as cli
from plutus.sync.quarterly import RunReport, SymbolReport


@dataclass
class _StubWorker:
    calls: List[dict] = field(default_factory=list)
    fail: bool = False

    def run_all(self, symbols, as_of=None, *, dry_run=False):
        self.calls.append({"symbols": list(symbols), "as_of": as_of,
                           "dry_run": dry_run})
        now = datetime.now(timezone.utc)
        return RunReport(
            as_of_date=as_of or date.today(),
            job_type="quarterly_sync",
            dry_run=dry_run,
            started_at=now, finished_at=now,
            symbols_total=len(symbols),
            symbols_ok=0 if self.fail else len(symbols),
            symbols_failed=len(symbols) if self.fail else 0,
            rows_written=0 if (self.fail or dry_run) else len(symbols) * 4,
            per_symbol=[SymbolReport(symbol=s, ok=not self.fail,
                                     rows_extracted=4) for s in symbols],
        )


class TestCli:
    def test_symbols_arg(self, capsys):
        w = _StubWorker()
        rc = cli.main(["--symbols", "A.NS", "--dry-run"], worker=w)
        assert rc == 0
        assert w.calls[0]["symbols"] == ["A.NS"]
        out = capsys.readouterr().out
        assert "rows_written" in out

    def test_no_symbols_returns_2(self):
        w = _StubWorker()
        rc = cli.main([], worker=w, load_symbols=lambda **_: [])
        assert rc == 2

    def test_pool_filter_forwarded(self):
        seen = {}
        def loader(**kw):
            seen.update(kw); return ["X.NS"]
        w = _StubWorker()
        rc = cli.main(["--pool", "E40"], worker=w, load_symbols=loader)
        assert rc == 0
        assert seen == {"pool": "E40", "limit": None}

    def test_failure_exits_nonzero(self):
        w = _StubWorker(fail=True)
        rc = cli.main(["--symbols", "A.NS"], worker=w)
        assert rc == 1

    def test_overrides_only_mode(self, capsys):
        rows = [{"symbol": "A.NS", "quarter_end_date": "2024-09-30",
                 "roce": "18"}]
        applied = {}
        def applier(rs):
            applied["rows"] = rs
            return {"rows_written": len(rs), "errors": []}
        rc = cli.main(["--overrides-csv", "/tmp/fake.csv"],
                      overrides_loader=lambda p: rows,
                      overrides_applier=applier)
        assert rc == 0
        assert applied["rows"] == rows

    def test_overrides_reader_failure(self):
        def bad(_): raise IOError("nope")
        rc = cli.main(["--overrides-csv", "/tmp/x.csv"],
                      overrides_loader=bad,
                      overrides_applier=lambda rs: {"rows_written": 0, "errors": []})
        assert rc == 2
