"""CLI tests for plutus.scripts.run_canary — pure argparse + exit code checks."""
from __future__ import annotations

import json
from typing import Any, List

from plutus.canary.runner import CanaryOutcome, CanaryRunReport
from plutus.scripts import run_canary


class _StubRunner:
    def __init__(self, report: CanaryRunReport) -> None:
        self._report = report
        self.calls: List[bool] = []

    def run(self, *, alert: bool = True) -> CanaryRunReport:
        self.calls.append(alert)
        return self._report


def _mk_report(**counts: int) -> CanaryRunReport:
    return CanaryRunReport(
        started_at="2024-05-10T00:00:00+00:00",
        finished_at="2024-05-10T00:00:01+00:00",
        checked=counts.get("ok", 0) + counts.get("drift", 0)
                + counts.get("missing", 0) + counts.get("error", 0),
        ok=counts.get("ok", 0),
        drift=counts.get("drift", 0),
        missing=counts.get("missing", 0),
        error=counts.get("error", 0),
        outcomes=[],
    )


def test_exit_zero_when_all_ok(capsys: Any) -> None:
    stub = _StubRunner(_mk_report(ok=3))
    rc = run_canary.main([], runner=stub)  # type: ignore[arg-type]
    assert rc == 0
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["ok"] == 3
    assert stub.calls == [True]


def test_exit_one_on_drift(capsys: Any) -> None:
    stub = _StubRunner(_mk_report(ok=2, drift=1))
    rc = run_canary.main([], runner=stub)  # type: ignore[arg-type]
    assert rc == 1


def test_exit_one_on_missing_only() -> None:
    stub = _StubRunner(_mk_report(ok=0, missing=2))
    rc = run_canary.main([], runner=stub)  # type: ignore[arg-type]
    assert rc == 1


def test_no_alert_flag_forwarded() -> None:
    stub = _StubRunner(_mk_report(drift=1))
    rc = run_canary.main(["--no-alert"], runner=stub)  # type: ignore[arg-type]
    assert rc == 1
    assert stub.calls == [False]


def test_no_fixtures_configured_exits_zero() -> None:
    stub = _StubRunner(_mk_report())
    rc = run_canary.main([], runner=stub)  # type: ignore[arg-type]
    assert rc == 0
