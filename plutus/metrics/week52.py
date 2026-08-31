"""
52-week high/low + distance metrics.

Prefers yfinance meta (`fiftyTwoWeekHigh` / `fiftyTwoWeekLow`) because those
values match Screener.in and TradingView exactly. Falls back to trailing-252
high/low from OHLCV when meta is missing.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Iterable, Optional, Sequence

from plutus.registry.types import round_half_up, to_decimal

_TRAILING_DAYS = 252
_TWO = 2   # decimal places


def _from_meta(meta: dict, key: str) -> Optional[Decimal]:
    if not meta:
        return None
    v = meta.get(key)
    if v in (None, "", 0, 0.0):
        return None
    try:
        d = to_decimal(v)
    except Exception:
        return None
    return d if d > 0 else None


def compute_52w_high(highs: Sequence[Decimal],
                     *, meta: Optional[dict] = None) -> Optional[Decimal]:
    """Return meta['fiftyTwoWeekHigh'] if present, else max(highs[-252:])."""
    meta_val = _from_meta(meta or {}, "fiftyTwoWeekHigh")
    if meta_val is not None:
        return round_half_up(meta_val, _TWO)
    if not highs:
        return None
    window = list(highs[-_TRAILING_DAYS:])
    return round_half_up(max(to_decimal(x) for x in window), _TWO)


def compute_52w_low(lows: Sequence[Decimal],
                    *, meta: Optional[dict] = None) -> Optional[Decimal]:
    """Return meta['fiftyTwoWeekLow'] if present, else min(lows[-252:])."""
    meta_val = _from_meta(meta or {}, "fiftyTwoWeekLow")
    if meta_val is not None:
        return round_half_up(meta_val, _TWO)
    if not lows:
        return None
    window = list(lows[-_TRAILING_DAYS:])
    return round_half_up(min(to_decimal(x) for x in window), _TWO)


def distance_from_52w_high_pct(close: Decimal,
                               high_52w: Optional[Decimal]) -> Optional[Decimal]:
    """Percent BELOW the 52W high. Higher => deeper from the high."""
    if high_52w is None:
        return None
    hi = to_decimal(high_52w)
    if hi <= 0:
        return None
    c = to_decimal(close)
    pct = (hi - c) / hi * Decimal(100)
    return round_half_up(pct, _TWO)


def distance_from_52w_low_pct(close: Decimal,
                              low_52w: Optional[Decimal]) -> Optional[Decimal]:
    """Percent ABOVE the 52W low. Higher => further from buying zone."""
    if low_52w is None:
        return None
    lo = to_decimal(low_52w)
    if lo <= 0:
        return None
    c = to_decimal(close)
    pct = (c - lo) / lo * Decimal(100)
    return round_half_up(pct, _TWO)
