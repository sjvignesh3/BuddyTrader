"""
Synthetic OHLCV fixture builder.

Deterministic, hand-verifiable price series for metric unit tests. No live
network required. Every helper returns a list of `OHLCVBar` sorted oldest-first.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import List, Sequence, Tuple

from plutus.metrics.rally import OHLCVBar


def _d(y: int, m: int, d: int) -> date:
    return date(y, m, d)


def flat_series(price: str = "100.00", *, n: int = 210,
                start: date = _d(2024, 1, 1)) -> List[OHLCVBar]:
    """N flat bars at the same price. DMA(200) == price."""
    p = Decimal(price)
    return [
        OHLCVBar(d=start + timedelta(days=i),
                 open=p, high=p, low=p, close=p)
        for i in range(n)
    ]


def linear_up_series(start_price: str = "100.00",
                     step: str = "1.00",
                     *, n: int = 210,
                     start: date = _d(2024, 1, 1)) -> List[OHLCVBar]:
    """Prices rise by `step` each bar. Every bar green (close > open)."""
    p0 = Decimal(start_price)
    s = Decimal(step)
    bars: List[OHLCVBar] = []
    for i in range(n):
        o = p0 + s * Decimal(i)
        c = o + s
        bars.append(OHLCVBar(
            d=start + timedelta(days=i),
            open=o, high=c, low=o, close=c,
        ))
    return bars


def build_bars(rows: Sequence[Tuple[str, str, str, str, str]],
               *, start: date = _d(2024, 1, 1)) -> List[OHLCVBar]:
    """Manual OHLCV construction: rows of (open, high, low, close, ...).

    The 5th element is ignored (kept for readability of test data)."""
    out: List[OHLCVBar] = []
    for i, r in enumerate(rows):
        o, h, l, c = r[0], r[1], r[2], r[3]
        out.append(OHLCVBar(
            d=start + timedelta(days=i),
            open=Decimal(o), high=Decimal(h),
            low=Decimal(l), close=Decimal(c),
        ))
    return out
