"""Tests for plutus.alerts.sync_hook.maybe_alert_on_run_report."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from plutus.alerts.notifier import AlertDispatchResult, AlertPayload
from plutus.alerts.sync_hook import maybe_alert_on_run_report


class _Recorder:
    """Captures every dispatched payload."""

    def __init__(self) -> None:
        self.calls: List[AlertPayload] = []

    def __call__(
        self,
        payload: AlertPayload,
        *,
        url: Optional[str] = None,
    ) -> AlertDispatchResult:
        self.calls.append(payload)
        return AlertDispatchResult(ok=True, attempts=1, status_code=200)


def _base_report(**overrides: Any) -> Dict[str, Any]:
    report: Dict[str, Any] = {
        "as_of_date": "2024-05-10",
        "job_type": "daily_sync",
        "dry_run": False,
        "started_at": "2024-05-10T12:30:00+00:00",
        "finished_at": "2024-05-10T12:33:00+00:00",
        "duration_ms": 180_000,
        "symbols_total": 300,
        "symbols_ok": 300,
        "symbols_failed": 0,
        "snapshots_written": 300,
        "per_symbol": [],
        "upsert_errors": [],
        "sync_job_id": "sj-1",
    }
    report.update(overrides)
    return report


# ---------------------------------------------------------------------------
# Silence-on-green
# ---------------------------------------------------------------------------
def test_green_run_dispatches_nothing() -> None:
    rec = _Recorder()
    out = maybe_alert_on_run_report(_base_report(), dispatcher=rec)
    assert out is None
    assert rec.calls == []


def test_dry_run_never_alerts_even_when_failures_present() -> None:
    rec = _Recorder()
    report = _base_report(dry_run=True, symbols_ok=0, symbols_failed=300)
    out = maybe_alert_on_run_report(report, dispatcher=rec)
    assert out is None
    assert rec.calls == []


# ---------------------------------------------------------------------------
# Severity mapping
# ---------------------------------------------------------------------------
def test_partial_failure_is_warning() -> None:
    rec = _Recorder()
    report = _base_report(
        symbols_ok=298, symbols_failed=2,
        per_symbol=[
            {"symbol": "AAA", "ok": False, "error": "fetch_info: 404"},
            {"symbol": "BBB", "ok": False, "error": "empty history"},
        ],
    )
    out = maybe_alert_on_run_report(report, dispatcher=rec)
    assert out is not None and out.ok is True
    assert len(rec.calls) == 1
    payload = rec.calls[0]
    assert payload.severity == "warning"
    # Both failed symbols appear in the body.
    assert "AAA" in payload.body and "BBB" in payload.body
    # Title includes job type and date for quick triage.
    assert "daily_sync" in payload.title and "2024-05-10" in payload.title


def test_total_failure_is_error() -> None:
    rec = _Recorder()
    report = _base_report(
        symbols_ok=0, symbols_failed=300,
        per_symbol=[
            {"symbol": f"S{i}", "ok": False, "error": "boom"} for i in range(300)
        ],
    )
    out = maybe_alert_on_run_report(report, dispatcher=rec)
    assert out is not None
    assert rec.calls[0].severity == "error"
    # Body caps failed-symbol enumeration at 10 to avoid a huge message.
    body = rec.calls[0].body
    assert "S0" in body and "S9" in body
    assert "+290 more" in body


def test_upsert_errors_alone_trigger_error() -> None:
    # Stage 8 spec: non-empty upsert_errors ⇒ ERROR — computed data did not
    # land in the DB, which is worse than a partial fetch failure.
    rec = _Recorder()
    report = _base_report(
        upsert_errors=["timeout on batch 3"],
    )
    out = maybe_alert_on_run_report(report, dispatcher=rec)
    assert out is not None
    assert rec.calls[0].severity == "error"
    assert "upsert_errors" in rec.calls[0].body


# ---------------------------------------------------------------------------
# Robustness
# ---------------------------------------------------------------------------
def test_dispatcher_exception_is_swallowed() -> None:
    def boom(_payload: AlertPayload, *, url: Optional[str] = None) -> AlertDispatchResult:
        raise RuntimeError("kaboom")

    report = _base_report(symbols_ok=299, symbols_failed=1)
    out = maybe_alert_on_run_report(report, dispatcher=boom)
    assert out is not None
    assert out.ok is False
    assert out.error == "dispatcher_raised"


def test_context_carries_key_telemetry() -> None:
    rec = _Recorder()
    report = _base_report(symbols_ok=299, symbols_failed=1, sync_job_id="abc-123")
    maybe_alert_on_run_report(report, dispatcher=rec)
    ctx = rec.calls[0].context
    assert ctx["job_type"] == "daily_sync"
    assert ctx["as_of_date"] == "2024-05-10"
    assert ctx["symbols_failed"] == 1
    assert ctx["sync_job_id"] == "abc-123"
