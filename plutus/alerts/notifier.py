"""Generic webhook notifier.

Design invariants (Stage 8 hardening):
  * **Fire-and-forget** — the caller never crashes because alerting failed.
    Every failure is caught, logged, and returned as a value.
  * **Bounded** — 10 s hard timeout, 3 retries with exponential backoff.
  * **Stateless** — no persistent queue; a lost alert is a lost alert.
    We DO record the last-attempt result in the run log so a human can
    reconstruct history from GitHub Actions logs.
  * **Format-agnostic** — supports Slack / Discord / Telegram / generic
    JSON webhooks via a single ``{"text": ..., "attachments": [...] }``
    envelope that every common target understands.
  * **No `float(` anywhere** — alerting must obey the money-safety gate
    even though it never handles money directly, because the module can be
    imported into a sync worker and any float slip in shared code is bad.

Env vars (all optional — no env => alerting silently disabled):
  ``PLUTUS_ALERT_WEBHOOK``   — target URL
  ``PLUTUS_ALERT_TIMEOUT_S`` — override timeout (default 10)
  ``PLUTUS_ALERT_MAX_RETRIES`` — override retries (default 3)
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional
from urllib import error as urlerror
from urllib import request as urlrequest

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT_S = 10
_DEFAULT_MAX_RETRIES = 3
_BACKOFF_BASE_S = 1.0


@dataclass
class AlertPayload:
    """Envelope every alert produces.

    ``severity`` is one of ``"info" | "warning" | "error"`` and drives icon
    choice in Slack/Discord-style renderers. ``context`` is a small
    JSON-serialisable dict — keep it flat and human-readable.
    """

    title: str
    body: str
    severity: str = "info"
    context: Dict[str, Any] = field(default_factory=dict)

    def to_wire(self) -> Dict[str, Any]:
        """Serialise to the common webhook envelope.

        Includes both ``text`` (Slack/Discord fallback) and top-level
        structured keys (generic JSON webhooks).
        """
        icon = {"info": "ℹ️", "warning": "⚠️", "error": "🚨"}.get(self.severity, "•")
        text = f"{icon} *{self.title}*\n{self.body}"
        return {
            "text": text,
            "title": self.title,
            "severity": self.severity,
            "body": self.body,
            "context": dict(self.context),
        }


@dataclass
class AlertDispatchResult:
    """Structured result — callers can log this without leaking secrets."""

    ok: bool
    attempts: int
    status_code: Optional[int] = None
    error: Optional[str] = None
    skipped_reason: Optional[str] = None

    def as_json(self) -> Dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Config helpers (kept tiny — no plutus.config import so this module works in
# subprocesses like the GitHub Action step that only sets the webhook env).
# ---------------------------------------------------------------------------
def _webhook_url() -> Optional[str]:
    val = os.environ.get("PLUTUS_ALERT_WEBHOOK", "").strip()
    return val or None


def _timeout_s() -> int:
    raw = os.environ.get("PLUTUS_ALERT_TIMEOUT_S", "").strip()
    try:
        return max(1, int(raw)) if raw else _DEFAULT_TIMEOUT_S
    except ValueError:
        return _DEFAULT_TIMEOUT_S


def _max_retries() -> int:
    raw = os.environ.get("PLUTUS_ALERT_MAX_RETRIES", "").strip()
    try:
        return max(1, int(raw)) if raw else _DEFAULT_MAX_RETRIES
    except ValueError:
        return _DEFAULT_MAX_RETRIES


# ---------------------------------------------------------------------------
# Transport — thin urllib wrapper so tests can monkey-patch a single symbol.
# ---------------------------------------------------------------------------
def _default_post(url: str, body: bytes, timeout: int) -> int:
    req = urlrequest.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (URL is user-supplied config)
        return int(resp.status)


def dispatch_alert(
    payload: AlertPayload,
    *,
    url: Optional[str] = None,
    post: Callable[[str, bytes, int], int] = _default_post,
    sleep: Callable[[float], None] = time.sleep,
) -> AlertDispatchResult:
    """Send an alert. Never raises.

    ``url`` overrides the env var (useful in tests). ``post`` and ``sleep``
    are injection seams so the retry loop is deterministic in tests.
    """
    target = (url or _webhook_url())
    if not target:
        return AlertDispatchResult(
            ok=False,
            attempts=0,
            skipped_reason="no_webhook_configured",
        )

    body = json.dumps(payload.to_wire()).encode("utf-8")
    timeout = _timeout_s()
    max_retries = _max_retries()

    last_error: Optional[str] = None
    last_status: Optional[int] = None

    for attempt in range(1, max_retries + 1):
        try:
            status = post(target, body, timeout)
            last_status = status
            if 200 <= status < 300:
                _log("alert.sent", severity=payload.severity,
                     title=payload.title, attempts=attempt, status=status)
                return AlertDispatchResult(
                    ok=True, attempts=attempt, status_code=status,
                )
            last_error = f"http_{status}"
        except urlerror.URLError as exc:
            last_error = f"urlerror: {getattr(exc, 'reason', exc)}"
        except Exception as exc:  # noqa: BLE001 — MUST NOT bubble
            last_error = f"{type(exc).__name__}: {exc}"

        if attempt < max_retries:
            sleep(_BACKOFF_BASE_S * (2 ** (attempt - 1)))

    _log(
        "alert.failed",
        severity=payload.severity,
        title=payload.title,
        attempts=max_retries,
        error=last_error,
    )
    return AlertDispatchResult(
        ok=False,
        attempts=max_retries,
        status_code=last_status,
        error=last_error,
    )


# ---------------------------------------------------------------------------
def _log(event: str, **fields: Any) -> None:
    try:
        logger.info(json.dumps({"event": event, **fields}, default=str))
    except Exception:  # noqa: BLE001
        logger.info("event=%s %s", event, fields)


__all__ = ["AlertPayload", "AlertDispatchResult", "dispatch_alert"]
