"""Alerting primitives.

`notifier.py` — generic webhook poster. `sync_hook.py` — glue that turns a
`RunReport` into a single alert payload and dispatches it. Both are
fire-and-forget: an alerting failure NEVER breaks a sync.
"""
from plutus.alerts.notifier import (  # noqa: F401
    AlertDispatchResult,
    AlertPayload,
    dispatch_alert,
)
from plutus.alerts.sync_hook import maybe_alert_on_run_report  # noqa: F401
