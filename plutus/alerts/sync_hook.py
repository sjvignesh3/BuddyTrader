"""Turn a sync ``RunReport`` into a single, well-formatted alert.

Called by both the daily and quarterly sync CLIs immediately after
``run_all`` returns. The rule is intentionally conservative: **any
non-success outcome fires an alert.** Success is silent — a green sync is
a boring sync.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from plutus.alerts.notifier import (
    AlertDispatchResult,
    AlertPayload,
    dispatch_alert,
)


def _severity_for(run_report_json: Dict[str, Any]) -> Optional[str]:
    """Map a serialised ``RunReport`` to an alert severity.

    Returns ``None`` when the run was fully successful — the caller should
    NOT alert in that case (silence-on-green).
    """
    failed = int(run_report_json.get("symbols_failed") or 0)
    upsert_errors = run_report_json.get("upsert_errors") or []
    total = int(run_report_json.get("symbols_total") or 0)

    if failed == 0 and not upsert_errors:
        return None
    # Total failure — nothing landed.
    if total > 0 and failed >= total:
        return "error"
    # Upsert errors mean computed data did NOT land in the DB — that is an
    # error, not a degradation (Stage 8 spec: non-empty upsert_errors ⇒ error).
    if upsert_errors:
        return "error"
    # Partial symbol failure.
    return "warning"


def _summary_lines(run_report_json: Dict[str, Any]) -> list[str]:
    lines = [
        f"job_type: {run_report_json.get('job_type')}",
        f"as_of:    {run_report_json.get('as_of_date')}",
        f"session:  {run_report_json.get('session_date', 'n/a')}",
        f"total:    {run_report_json.get('symbols_total')}",
        f"ok:       {run_report_json.get('symbols_ok')}",
        f"failed:   {run_report_json.get('symbols_failed')}",
        # Daily reports use 'snapshots_written'; quarterly uses 'rows_written'.
        f"written:  {run_report_json.get('snapshots_written', run_report_json.get('rows_written'))}",
        f"duration: {run_report_json.get('duration_ms')} ms",
    ]
    upsert = run_report_json.get("upsert_errors") or []
    if upsert:
        lines.append(f"upsert_errors ({len(upsert)}): {upsert[:3]}")
    stale = run_report_json.get("stale_symbols") or {}
    if stale:
        lines.append(f"stale_symbols ({len(stale)}): {list(stale)[:10]}")
    failed_syms = [
        s.get("symbol") for s in (run_report_json.get("per_symbol") or [])
        if not s.get("ok")
    ]
    if failed_syms:
        preview = failed_syms[:10]
        suffix = "" if len(failed_syms) <= 10 else f" (+{len(failed_syms) - 10} more)"
        lines.append(f"failed_symbols: {', '.join(preview)}{suffix}")
    return lines


def maybe_alert_on_run_report(
    run_report_json: Dict[str, Any],
    *,
    dispatcher: Any = dispatch_alert,
    url: Optional[str] = None,
) -> Optional[AlertDispatchResult]:
    """Fire an alert when the run was not fully successful.

    Returns:
        * ``None`` — silent-on-green (no alert dispatched, no error)
        * ``AlertDispatchResult`` — an attempt was made (successful or not)

    Never raises. Safe to call from a CLI that must exit cleanly whatever
    happens.
    """
    if run_report_json.get("dry_run"):
        return None  # dry-run never alerts

    severity = _severity_for(run_report_json)
    if severity is None:
        return None

    job_type = run_report_json.get("job_type") or "sync"
    as_of = run_report_json.get("as_of_date") or ""
    title = f"Plutus {job_type} degraded — {as_of}"
    body = "\n".join(_summary_lines(run_report_json))

    payload = AlertPayload(
        title=title,
        body=body,
        severity=severity,
        context={
            "job_type": job_type,
            "as_of_date": as_of,
            "symbols_failed": run_report_json.get("symbols_failed"),
            "sync_job_id": run_report_json.get("sync_job_id"),
        },
    )
    try:
        return dispatcher(payload, url=url)
    except Exception:  # noqa: BLE001 — dispatcher already swallows, this is belt+braces
        return AlertDispatchResult(
            ok=False, attempts=0, error="dispatcher_raised"
        )


__all__ = ["maybe_alert_on_run_report"]
