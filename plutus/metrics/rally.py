"""
20% Rally metrics — Decimal port of Buddy's Pine-Script translation.

Definition (mirrors the V20 PineScript exactly):
  1. A "streak" is one or more CONSECUTIVE green candles (close > open).
  2. A streak COMPLETES when a non-green candle follows (open streaks are ignored).
  3. rally_pct = (max(High) - min(Low)) / min(Low) * 100 over the streak.
  4. Streak qualifies if rally_pct >= threshold (default 20%).
  5. Only streaks whose END BAR is within the last `window_days` bars count.
  6. The MOST RECENT qualifying streak is reported.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import List, Optional, Sequence

from plutus.registry.types import round_half_up, to_decimal

_TWO = 2   # decimal places
_DEFAULT_THRESHOLD = Decimal(20)
_DEFAULT_WINDOW = 189   # ~9 months of trading days


@dataclass(frozen=True)
class OHLCVBar:
    """One trading day. All prices are Decimals; date is a python date.

    ``adj_close`` is the dividend/split-adjusted close (yfinance ``Adj Close``
    with ``auto_adjust=False``). It defaults to ``close`` when the source has
    no adjustment column. ``volume`` is the session's traded volume.
    """
    d: date
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    adj_close: Optional[Decimal] = None
    volume: Optional[int] = None

    @staticmethod
    def make(d: date, o, h, l, c, adj_c=None, volume=None) -> "OHLCVBar":
        close = to_decimal(c)
        adj = to_decimal(adj_c) if adj_c is not None else None
        return OHLCVBar(
            d=d,
            open=to_decimal(o),
            high=to_decimal(h),
            low=to_decimal(l),
            close=close,
            adj_close=adj if adj is not None else close,
            volume=volume,
        )


@dataclass(frozen=True)
class RallyResult:
    has_valid_20pct_rally: bool = False
    last_rally_pct: Optional[Decimal] = None
    last_rally_low: Optional[Decimal] = None
    last_rally_high: Optional[Decimal] = None
    last_rally_start_date: Optional[date] = None
    last_rally_end_date: Optional[date] = None
    days_since_last_rally: Optional[int] = None
    total_valid_rallies_in_window: int = 0

    def as_dict(self) -> dict:
        """Registry-shaped dict for daily_snapshots upsert."""
        return {
            "has_valid_20pct_rally": self.has_valid_20pct_rally,
            "last_rally_pct": self.last_rally_pct,
            "last_rally_low": self.last_rally_low,
            "last_rally_high": self.last_rally_high,
            "last_rally_start_date": self.last_rally_start_date,
            "last_rally_end_date": self.last_rally_end_date,
            "days_since_last_rally": self.days_since_last_rally,
            "total_valid_rallies_in_window": self.total_valid_rallies_in_window,
        }


@dataclass
class _StreakState:
    start_idx: int
    low: Decimal
    high: Decimal


def compute_rally_metrics(
    bars: Sequence[OHLCVBar],
    *,
    threshold_pct: Decimal = _DEFAULT_THRESHOLD,
    window_days: int = _DEFAULT_WINDOW,
) -> RallyResult:
    """
    Scan bars for completed green-candle streaks with a rally >= threshold_pct
    whose end bar falls within the last `window_days`.

    Returns the most recent qualifying rally, plus the total count in window.
    """
    if not bars:
        return RallyResult()

    n = len(bars)
    window_start_idx = max(0, n - window_days)
    threshold = to_decimal(threshold_pct)

    valid: List[dict] = []
    streak: Optional[_StreakState] = None

    def close_streak(end_idx: int) -> None:
        nonlocal streak
        if streak is None:
            return
        low = streak.low
        high = streak.high
        if low > 0:
            rally_pct = (high - low) / low * Decimal(100)
            if rally_pct >= threshold and end_idx >= window_start_idx:
                valid.append({
                    "rally_pct": round_half_up(rally_pct, _TWO),
                    "rally_low": round_half_up(low, _TWO),
                    "rally_high": round_half_up(high, _TWO),
                    "start_idx": streak.start_idx,
                    "end_idx": end_idx,
                    "start_date": bars[streak.start_idx].d,
                    "end_date": bars[end_idx].d,
                    "days_since": n - 1 - end_idx,
                })
        streak = None

    for i, bar in enumerate(bars):
        is_green = bar.close > bar.open
        if is_green:
            if streak is None:
                streak = _StreakState(start_idx=i, low=bar.low, high=bar.high)
            else:
                if bar.low < streak.low:
                    streak.low = bar.low
                if bar.high > streak.high:
                    streak.high = bar.high
        else:
            if streak is not None:
                close_streak(end_idx=i - 1)

    # NOTE: open streak at the end is intentionally ignored (Pine parity).

    if not valid:
        return RallyResult()

    # Sort by end_idx desc; head is most recent.
    valid.sort(key=lambda x: x["end_idx"], reverse=True)
    latest = valid[0]
    return RallyResult(
        has_valid_20pct_rally=True,
        last_rally_pct=latest["rally_pct"],
        last_rally_low=latest["rally_low"],
        last_rally_high=latest["rally_high"],
        last_rally_start_date=latest["start_date"],
        last_rally_end_date=latest["end_date"],
        days_since_last_rally=latest["days_since"],
        total_valid_rallies_in_window=len(valid),
    )
