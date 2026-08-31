"""Unit tests for plutus.alerts.notifier.

Every path is exercised without touching the network. The transport is
injected via the `post` kwarg.
"""
from __future__ import annotations

import json
from typing import List, Tuple

import pytest

from plutus.alerts.notifier import (
    AlertDispatchResult,
    AlertPayload,
    dispatch_alert,
)


class _FakeSleep:
    """Records sleep calls but does not actually sleep."""

    def __init__(self) -> None:
        self.calls: List[float] = []

    def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


# ---------------------------------------------------------------------------
# to_wire
# ---------------------------------------------------------------------------
def test_to_wire_shape_and_icon_mapping() -> None:
    p = AlertPayload(title="X", body="Y", severity="warning",
                     context={"a": 1})
    wire = p.to_wire()
    assert wire["title"] == "X"
    assert wire["body"] == "Y"
    assert wire["severity"] == "warning"
    assert wire["context"] == {"a": 1}
    # Slack/Discord fallback text carries the icon + bold title.
    assert "⚠️" in wire["text"] and "*X*" in wire["text"]


def test_to_wire_unknown_severity_falls_back_to_bullet() -> None:
    wire = AlertPayload(title="T", body="B", severity="bogus").to_wire()
    assert "• *T*" in wire["text"]


# ---------------------------------------------------------------------------
# dispatch_alert — configuration
# ---------------------------------------------------------------------------
def test_no_webhook_configured_returns_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PLUTUS_ALERT_WEBHOOK", raising=False)
    res = dispatch_alert(AlertPayload(title="t", body="b"))
    assert isinstance(res, AlertDispatchResult)
    assert res.ok is False
    assert res.attempts == 0
    assert res.skipped_reason == "no_webhook_configured"


def test_explicit_url_arg_overrides_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PLUTUS_ALERT_WEBHOOK", raising=False)
    captured: List[Tuple[str, bytes, int]] = []

    def fake_post(url: str, body: bytes, timeout: int) -> int:
        captured.append((url, body, timeout))
        return 200

    res = dispatch_alert(
        AlertPayload(title="t", body="b"),
        url="https://example.com/hook",
        post=fake_post,
    )
    assert res.ok is True
    assert res.attempts == 1
    assert captured[0][0] == "https://example.com/hook"


# ---------------------------------------------------------------------------
# dispatch_alert — retry & backoff
# ---------------------------------------------------------------------------
def test_success_first_try_no_sleep() -> None:
    sleep = _FakeSleep()
    calls: List[int] = []

    def post(_url: str, _body: bytes, _t: int) -> int:
        calls.append(1)
        return 204

    res = dispatch_alert(
        AlertPayload(title="t", body="b"),
        url="https://x",
        post=post,
        sleep=sleep,
    )
    assert res.ok is True
    assert res.attempts == 1
    assert res.status_code == 204
    assert sleep.calls == []      # no backoff on first-try success
    assert len(calls) == 1


def test_retries_on_5xx_and_reports_last_status(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PLUTUS_ALERT_MAX_RETRIES", "3")
    sleep = _FakeSleep()
    calls: List[int] = []

    def post(_url: str, _body: bytes, _t: int) -> int:
        calls.append(1)
        return 503

    res = dispatch_alert(
        AlertPayload(title="t", body="b"),
        url="https://x",
        post=post,
        sleep=sleep,
    )
    assert res.ok is False
    assert res.attempts == 3
    assert res.status_code == 503
    assert res.error == "http_503"
    # Backoff between the 3 attempts: sleeps twice (after attempt 1, 2).
    assert sleep.calls == [1.0, 2.0]
    assert len(calls) == 3


def test_recovers_after_transient_failure() -> None:
    sleep = _FakeSleep()
    statuses = iter([500, 200])

    def post(_url: str, _body: bytes, _t: int) -> int:
        return next(statuses)

    res = dispatch_alert(
        AlertPayload(title="t", body="b"),
        url="https://x",
        post=post,
        sleep=sleep,
    )
    assert res.ok is True
    assert res.attempts == 2
    assert res.status_code == 200
    assert sleep.calls == [1.0]   # exactly one backoff between the two calls


def test_swallows_transport_exceptions() -> None:
    sleep = _FakeSleep()

    def boom(_url: str, _body: bytes, _t: int) -> int:
        raise RuntimeError("network down")

    res = dispatch_alert(
        AlertPayload(title="t", body="b"),
        url="https://x",
        post=boom,
        sleep=sleep,
    )
    assert res.ok is False
    assert res.attempts == 3       # default max retries
    assert res.error is not None
    assert "RuntimeError" in res.error


# ---------------------------------------------------------------------------
# Body integrity
# ---------------------------------------------------------------------------
def test_wire_body_is_valid_json_and_contains_all_fields() -> None:
    captured: List[bytes] = []

    def post(_url: str, body: bytes, _t: int) -> int:
        captured.append(body)
        return 200

    payload = AlertPayload(title="T", body="line1\nline2",
                           severity="error",
                           context={"job": "daily_sync", "failed": 3})
    dispatch_alert(payload, url="https://x", post=post)
    parsed = json.loads(captured[0].decode("utf-8"))
    assert parsed["title"] == "T"
    assert parsed["severity"] == "error"
    assert parsed["context"] == {"job": "daily_sync", "failed": 3}
    assert "line1" in parsed["body"] and "line2" in parsed["body"]
