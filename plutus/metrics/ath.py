"""
All-Time High metrics.

ATH uses adjusted intraday High to match TradingView:

    adjusted_high_i = high_i * (adj_close_i / close_i)
    ath = max(adjusted_high_i) over full history

This corrects for dividend / split adjustments that shrink historical
raw Highs on the yfinance-adjusted series.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Optional, Sequence

from plutus.registry.types import round_half_up, to_decimal

_TWO = 2   # decimal places


def compute_ath(highs: Sequence[Decimal],
                closes: Sequence[Decimal],
                adj_closes: Sequence[Decimal]) -> Optional[Decimal]:
    """
    Compute the adjusted-intraday all-time high.

    Args:
        highs, closes, adj_closes: parallel sequences of the same length.

    Returns:
        Decimal ATH rounded to 2dp. None if inputs are empty / mismatched.
    """
    if not highs or not closes or not adj_closes:
        return None
    n = len(highs)
    if len(closes) != n or len(adj_closes) != n:
        raise ValueError(
            f"highs/closes/adj_closes length mismatch: "
            f"{len(highs)}/{len(closes)}/{len(adj_closes)}"
        )

    best: Optional[Decimal] = None
    for h, c, a in zip(highs, closes, adj_closes):
        c_d = to_decimal(c)
        if c_d <= 0:
            continue
        h_d = to_decimal(h)
        a_d = to_decimal(a)
        adjusted = h_d * (a_d / c_d)
        if best is None or adjusted > best:
            best = adjusted

    return round_half_up(best, _TWO) if best is not None else None


def gap_from_ath_pct(close: Decimal,
                     ath: Optional[Decimal]) -> Optional[Decimal]:
    """
    Percent below the ATH. Positive => below ATH.

        gap = (ath - close) / ath * 100
    """
    if ath is None:
        return None
    a = to_decimal(ath)
    if a <= 0:
        return None
    c = to_decimal(close)
    pct = (a - c) / a * Decimal(100)
    return round_half_up(pct, _TWO)
