"""
Daily Moving Average metrics.

Pure Decimal functions. No I/O. No pandas dependency at the interface —
callers pass a Sequence[Decimal] of prices (typically AdjClose).

Semantic parity with Buddy's `metrics_engine.compute_metrics`:
  - DMA uses AdjClose (dividend-adjusted) when available.
  - `below_dma_pct` is POSITIVE when close is below DMA (buy-zone convention).
"""
from __future__ import annotations

from decimal import Decimal
from typing import Optional, Sequence

from plutus.registry.types import round_half_up, to_decimal

_TWO = 2   # decimal places for round_half_up


def compute_dma(prices: Sequence[Decimal], window: int = 200) -> Optional[Decimal]:
    """
    Simple moving average over the last `window` prices.

    Returns:
        Decimal average, rounded half-up to 2 decimals. None on empty input.
        If fewer than `window` prices exist, averages what is available
        (matches Buddy's fallback behaviour) and callers should log a warning.
    """
    if not prices:
        return None
    if window <= 0:
        raise ValueError(f"window must be positive, got {window}")

    tail = list(prices[-window:])
    total = sum((to_decimal(p) for p in tail), start=Decimal(0))
    avg = total / Decimal(len(tail))
    return round_half_up(avg, _TWO)


def compute_below_dma_pct(close: Decimal, dma: Optional[Decimal]) -> Optional[Decimal]:
    """
    Percent BELOW the DMA. Positive => close is under DMA (buying zone).

        below_dma_pct = ((dma - close) / dma) * 100

    Returns None if dma is missing or non-positive.
    """
    if dma is None:
        return None
    dma_d = to_decimal(dma)
    if dma_d <= 0:
        return None
    close_d = to_decimal(close)
    pct = (dma_d - close_d) / dma_d * Decimal(100)
    return round_half_up(pct, _TWO)
