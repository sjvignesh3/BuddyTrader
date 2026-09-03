"""
Run-context for sync jobs — who triggered a run and what scope it covered.

Every sync worker stamps this dict into `sync_jobs.payload_json["context"]`
so the app's Sync page can show, per job: the trigger (cron / manual
dispatch / on-demand / CLI), the pool it ran for, the explicit symbols (if
any), and — for fetch-on-miss enrichment — which parent job caused it.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional, Sequence

# Payloads are audit rows, not archives — cap the symbol list we store.
MAX_SYMBOLS_STORED = 50

TRIGGER_CRON = "cron"
TRIGGER_DISPATCH = "manual-dispatch"
TRIGGER_ON_DEMAND = "on-demand"
TRIGGER_CLI = "cli"


def detect_trigger(default: str = TRIGGER_CLI) -> str:
    """GitHub Actions sets GITHUB_EVENT_NAME; anywhere else → `default`."""
    event = os.environ.get("GITHUB_EVENT_NAME", "").strip()
    if event == "schedule":
        return TRIGGER_CRON
    if event == "workflow_dispatch":
        return TRIGGER_DISPATCH
    if event:
        return f"github-{event}"
    return default


def build_run_context(
    *,
    pool: Optional[str] = None,
    symbols: Optional[Sequence[str]] = None,
    trigger: Optional[str] = None,
    via: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Build the payload_json["context"] dict.

    `via` names the parent flow when one job spawns another — e.g. the
    quarterly fundamentals fetched on-miss during a daily sync carry
    via="daily_sync fetch-on-miss".
    """
    ctx: Dict[str, Any] = {"trigger": trigger or detect_trigger()}
    if via:
        ctx["via"] = via
    if symbols:
        syms = [str(s) for s in symbols]
        ctx["symbols_requested"] = len(syms)
        ctx["symbols"] = syms[:MAX_SYMBOLS_STORED]
        if pool:
            ctx["pool"] = pool
    else:
        ctx["pool"] = pool or "ALL"
    return ctx
