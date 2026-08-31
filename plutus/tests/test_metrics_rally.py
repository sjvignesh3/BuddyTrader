"""Unit tests for plutus.metrics.rally."""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from plutus.metrics.rally import OHLCVBar, compute_rally_metrics
from plutus.tests.fixtures.synthetic_ohlcv import build_bars

_BASE = date(2024, 1, 1)


def _mk(o, h, l, c, day: int = 1) -> OHLCVBar:
    return OHLCVBar(
        d=_BASE + timedelta(days=day - 1),
        open=Decimal(o), high=Decimal(h),
        low=Decimal(l), close=Decimal(c),
    )


class TestRally:
    def test_empty_returns_default(self) -> None:
        r = compute_rally_metrics([])
        assert r.has_valid_20pct_rally is False
        assert r.total_valid_rallies_in_window == 0

    def test_all_flat_no_rally(self) -> None:
        # open == close ⇒ never green
        bars = [_mk(100, 100, 100, 100, day=i + 1) for i in range(30)]
        r = compute_rally_metrics(bars)
        assert r.has_valid_20pct_rally is False

    def test_single_green_below_threshold(self) -> None:
        # 5% move — below the 20% threshold
        bars = [
            _mk(100, 105, 99, 105, day=1),   # green +5
            _mk(105, 105, 100, 100, day=2),  # red, closes streak
        ]
        r = compute_rally_metrics(bars)
        assert r.has_valid_20pct_rally is False

    def test_single_green_streak_qualifies(self) -> None:
        # 3 green candles: low=100, high=130 ⇒ 30% rally
        bars = [
            _mk(100, 110, 100, 110, day=1),
            _mk(110, 120, 108, 120, day=2),
            _mk(120, 130, 118, 130, day=3),
            _mk(130, 130, 125, 125, day=4),   # red — closes streak
        ]
        r = compute_rally_metrics(bars)
        assert r.has_valid_20pct_rally is True
        assert r.last_rally_pct == Decimal("30.00")
        assert r.last_rally_low == Decimal("100.00")
        assert r.last_rally_high == Decimal("130.00")
        assert r.last_rally_start_date == date(2024, 1, 1)
        assert r.last_rally_end_date == date(2024, 1, 3)
        # streak ended at index 2 (day 3); latest bar is at index 3 (day 4).
        # days_since = n-1-end = 4-1-2 = 1
        assert r.days_since_last_rally == 1
        assert r.total_valid_rallies_in_window == 1

    def test_multiple_rallies_returns_most_recent(self) -> None:
        bars = [
            # First rally: 100 → 130 (30%)
            _mk(100, 110, 100, 110, day=1),
            _mk(110, 130, 108, 130, day=2),
            _mk(130, 130, 120, 120, day=3),   # red closes streak 1
            # A gap of red/flat
            _mk(120, 120, 115, 118, day=4),
            # Second rally: 118 → 160 (~35%)
            _mk(118, 130, 118, 130, day=5),
            _mk(130, 160, 128, 160, day=6),
            _mk(160, 160, 150, 150, day=7),   # red closes streak 2
        ]
        r = compute_rally_metrics(bars)
        assert r.has_valid_20pct_rally is True
        assert r.total_valid_rallies_in_window == 2
        assert r.last_rally_low == Decimal("118.00")
        assert r.last_rally_high == Decimal("160.00")
        # most recent by end_idx (5), reported

    def test_open_streak_at_end_ignored(self) -> None:
        # A green streak still running at the last bar should NOT be reported
        # (matches Pine — label fires only when streak breaks).
        bars = [
            _mk(100, 110, 100, 110, day=1),
            _mk(110, 130, 108, 130, day=2),
        ]
        r = compute_rally_metrics(bars)
        assert r.has_valid_20pct_rally is False

    def test_rally_outside_window_ignored(self) -> None:
        # Old rally at the head; window only includes the tail
        old_rally = [
            _mk(100, 110, 100, 110, day=1),
            _mk(110, 130, 108, 130, day=2),
            _mk(130, 130, 120, 120, day=3),   # red closes streak
        ]
        # 50 flat bars after the rally, no new rally
        tail = [_mk(120, 120, 120, 120, day=(4 + i)) for i in range(50)]
        bars = old_rally + tail
        r = compute_rally_metrics(bars, window_days=10)
        assert r.has_valid_20pct_rally is False
