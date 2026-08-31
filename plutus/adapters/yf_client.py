"""
yfinance client — retry, timeout, batch isolation, structured logging.

DESIGN CONTRACT (Stage 2):
  - Every public function returns Result[T]. Never raises to the caller.
  - Every network call is retried up to MAX_ATTEMPTS with exponential backoff.
  - A batch fetch isolates per-symbol failures — one bad ticker never poisons
    the rest.
  - All timing and outcome data is logged as structured JSON so a later stage
    can ship those logs to a dashboard without regex parsing.
  - yfinance itself is imported lazily so the module can be unit-tested with
    the library mocked out.
"""
from __future__ import annotations

import json
import logging
import random
import time
from typing import Any, Callable, Dict, Iterable, List, Optional

from plutus.adapters.result import Result
from plutus.adapters.validators import sanity_check_symbol
from plutus.config import get_settings

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
BASE_BACKOFF_SECONDS = 0.5   # first retry waits ~0.5s
MAX_BACKOFF_SECONDS = 8.0
JITTER_FRACTION = 0.2        # +/- 20% jitter to avoid thundering herd


# -----------------------------------------------------------------------------
# Structured log helper
# -----------------------------------------------------------------------------

def _log_call(event: str, **fields: Any) -> None:
    """Emit a single-line JSON log record."""
    try:
        payload = {"event": event, **fields}
        logger.info(json.dumps(payload, default=str))
    except Exception:  # logging must never break the caller
        logger.info("event=%s fields=%s", event, fields)


# -----------------------------------------------------------------------------
# Retry primitive
# -----------------------------------------------------------------------------

def _retry(fn: Callable[[], Any], *, symbol: str, op: str,
           max_attempts: int = MAX_ATTEMPTS) -> Result[Any]:
    """
    Call fn() up to max_attempts. Exponential backoff with jitter between tries.
    Returns Result.success(value) on any successful attempt.
    Returns Result.failure(error) if all attempts raise.
    """
    last_err: Optional[str] = None
    started = time.monotonic()
    for attempt in range(1, max_attempts + 1):
        attempt_started = time.monotonic()
        try:
            value = fn()
            latency = int((time.monotonic() - started) * 1000)
            _log_call("yf.ok", symbol=symbol, op=op, attempt=attempt,
                      latency_ms=latency)
            return Result.success(value, symbol=symbol,
                                  attempts=attempt, latency_ms=latency)
        except Exception as exc:  # noqa: BLE001 — we log & retry every error
            last_err = f"{type(exc).__name__}: {exc}"
            attempt_ms = int((time.monotonic() - attempt_started) * 1000)
            _log_call("yf.err", symbol=symbol, op=op, attempt=attempt,
                      latency_ms=attempt_ms, error=last_err)
            if attempt >= max_attempts:
                break
            # exponential backoff with jitter
            backoff = min(
                BASE_BACKOFF_SECONDS * (2 ** (attempt - 1)),
                MAX_BACKOFF_SECONDS,
            )
            jitter = backoff * JITTER_FRACTION * (2 * random.random() - 1)
            time.sleep(max(0.0, backoff + jitter))
    total = int((time.monotonic() - started) * 1000)
    return Result.failure(last_err or "unknown error", symbol=symbol,
                          attempts=max_attempts, latency_ms=total)


# -----------------------------------------------------------------------------
# Lazy yfinance import — keeps unit tests fast & offline
# -----------------------------------------------------------------------------

def _yf():
    """Import yfinance on demand. Kept as a function so tests can patch it."""
    import yfinance  # noqa: WPS433 — intentional lazy import
    return yfinance


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------

def fetch_info(symbol: str) -> Result[Dict[str, Any]]:
    """
    Fetch yfinance `.info` dict for a single symbol.
    Returns Result[dict]. Never raises.
    """
    try:
        sym = sanity_check_symbol(symbol)
    except ValueError as exc:
        return Result.failure(str(exc), symbol=symbol, attempts=0)

    def _do() -> Dict[str, Any]:
        ticker = _yf().Ticker(sym)
        info = ticker.info  # yfinance handles its own HTTP
        if not isinstance(info, dict) or not info:
            raise RuntimeError("empty .info payload")
        return info

    return _retry(_do, symbol=sym, op="info")


def fetch_history(symbol: str, *, period: str = "5y",
                  interval: str = "1d") -> Result[Any]:
    """
    Fetch OHLCV history as a pandas DataFrame.
    Returns Result[DataFrame]. Never raises.
    """
    try:
        sym = sanity_check_symbol(symbol)
    except ValueError as exc:
        return Result.failure(str(exc), symbol=symbol, attempts=0)

    def _do():
        ticker = _yf().Ticker(sym)
        df = ticker.history(period=period, interval=interval,
                            auto_adjust=False, actions=False)
        if df is None or df.empty:
            raise RuntimeError(f"empty history for {sym} ({period}/{interval})")
        return df

    return _retry(_do, symbol=sym, op=f"history:{period}:{interval}")


def fetch_batch(symbols: Iterable[str], *,
                fetcher: Callable[[str], Result[Any]] = fetch_info,
                ) -> Dict[str, Result[Any]]:
    """
    Sequentially fetch each symbol, isolating failures.

    Returns a dict {symbol: Result}. Symbols with malformed tickers still
    appear in the output with an error Result — no silent drops.

    NOTE: sequential by design — yfinance is rate-limited and parallelising
    tends to trigger throttling. Stage 4 introduces a bounded thread-pool
    only after we measure the actual rate ceiling.
    """
    out: Dict[str, Result[Any]] = {}
    for raw_symbol in symbols:
        key = str(raw_symbol)
        out[key] = fetcher(raw_symbol)
    ok_count = sum(1 for r in out.values() if r.ok)
    _log_call("yf.batch_done", total=len(out),
              ok=ok_count, failed=len(out) - ok_count)
    return out


# -----------------------------------------------------------------------------
# Config-driven timeout wiring
#
# yfinance does not expose a per-call timeout parameter, so we clamp the
# session-level default via env config. This is best-effort — the ultimate
# guard is the retry envelope above.
# -----------------------------------------------------------------------------

def apply_session_timeout() -> None:
    """
    Best-effort: set a socket-level default timeout so hung yfinance calls
    can't stall the whole sync. Called once by the sync worker at startup.
    """
    import socket
    cfg = get_settings()
    socket.setdefaulttimeout(cfg.yf_timeout_seconds)
    _log_call("yf.timeout_applied", seconds=cfg.yf_timeout_seconds)
