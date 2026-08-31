"""
yfinance client tests — fully offline. yfinance itself is patched out.

Guarantees under test:
  1. Retry envelope: transient failures retry up to MAX_ATTEMPTS.
  2. Success on 2nd attempt returns Result.success with attempts=2.
  3. All attempts failing returns Result.failure with attempts=MAX_ATTEMPTS.
  4. Malformed symbols short-circuit before any network call.
  5. Empty `.info` payload is treated as failure.
  6. Batch isolation: one bad symbol never breaks siblings.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from plutus.adapters import yf_client
from plutus.adapters.result import Result


# ---------------------------------------------------------------------------
# Reduce retry sleeps so the whole file runs in milliseconds.
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _fast_retries(monkeypatch):
    monkeypatch.setattr(yf_client, "BASE_BACKOFF_SECONDS", 0.0)
    monkeypatch.setattr(yf_client, "MAX_BACKOFF_SECONDS", 0.0)
    monkeypatch.setattr(yf_client, "JITTER_FRACTION", 0.0)
    # kill time.sleep entirely
    monkeypatch.setattr(yf_client.time, "sleep", lambda *_a, **_kw: None)


# ---------------------------------------------------------------------------
# fetch_info
# ---------------------------------------------------------------------------

def _fake_yf(info=None, raises_on_call=0):
    """Return a fake yfinance module. `raises_on_call` = number of leading
    calls that should raise before returning `info`."""
    calls = {"n": 0}

    class FakeTicker:
        def __init__(self, symbol):
            self.symbol = symbol

        @property
        def info(self):
            calls["n"] += 1
            if calls["n"] <= raises_on_call:
                raise RuntimeError(f"transient err {calls['n']}")
            return info if info is not None else {"longName": "X"}

        def history(self, **_):
            calls["n"] += 1
            if calls["n"] <= raises_on_call:
                raise RuntimeError(f"transient hist err {calls['n']}")
            import pandas as pd
            return pd.DataFrame({"Close": [1, 2, 3]})

    module = MagicMock()
    module.Ticker = FakeTicker
    module._calls = calls
    return module


def test_fetch_info_success_first_try() -> None:
    with patch.object(yf_client, "_yf", return_value=_fake_yf(info={"a": 1})):
        r = yf_client.fetch_info("RELIANCE.NS")
    assert r.ok is True
    assert r.value == {"a": 1}
    assert r.attempts == 1
    assert r.symbol == "RELIANCE.NS"


def test_fetch_info_retries_and_succeeds() -> None:
    fake = _fake_yf(info={"a": 1}, raises_on_call=2)
    with patch.object(yf_client, "_yf", return_value=fake):
        r = yf_client.fetch_info("RELIANCE.NS")
    assert r.ok is True
    assert r.attempts == 3


def test_fetch_info_all_attempts_fail() -> None:
    fake = _fake_yf(info={"a": 1}, raises_on_call=99)
    with patch.object(yf_client, "_yf", return_value=fake):
        r = yf_client.fetch_info("RELIANCE.NS")
    assert r.ok is False
    assert r.attempts == yf_client.MAX_ATTEMPTS
    assert "transient err" in (r.error or "")


def test_fetch_info_empty_payload_is_failure() -> None:
    with patch.object(yf_client, "_yf", return_value=_fake_yf(info={})):
        r = yf_client.fetch_info("RELIANCE.NS")
    assert r.ok is False
    assert "empty" in (r.error or "").lower()


def test_fetch_info_bad_symbol_short_circuits() -> None:
    # No yfinance patch — invalid symbol must fail before any network attempt.
    r = yf_client.fetch_info("not a symbol")
    assert r.ok is False
    assert r.attempts == 0


# ---------------------------------------------------------------------------
# fetch_history
# ---------------------------------------------------------------------------

def test_fetch_history_ok() -> None:
    with patch.object(yf_client, "_yf", return_value=_fake_yf()):
        r = yf_client.fetch_history("TCS.NS", period="1y")
    assert r.ok is True
    assert r.value is not None


def test_fetch_history_bad_symbol() -> None:
    r = yf_client.fetch_history("badsymbol")
    assert r.ok is False


# ---------------------------------------------------------------------------
# fetch_batch — isolation guarantee
# ---------------------------------------------------------------------------

def test_batch_isolates_failures() -> None:
    def fetcher(sym):
        if sym == "BAD.NS":
            return Result.failure("boom", symbol=sym)
        return Result.success({"sym": sym}, symbol=sym)

    result = yf_client.fetch_batch(["RELIANCE.NS", "BAD.NS", "TCS.NS"], fetcher=fetcher)
    assert result["RELIANCE.NS"].ok is True
    assert result["BAD.NS"].ok is False
    assert result["TCS.NS"].ok is True
    assert len(result) == 3


def test_batch_empty_returns_empty() -> None:
    assert yf_client.fetch_batch([]) == {}
