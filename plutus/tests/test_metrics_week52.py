"""Unit tests for plutus.metrics.week52."""
from __future__ import annotations

from decimal import Decimal

from plutus.metrics.week52 import (
    compute_52w_high,
    compute_52w_low,
    distance_from_52w_high_pct,
    distance_from_52w_low_pct,
)


class TestComputeHighLow:
    def test_meta_high_used_when_present(self) -> None:
        highs = [Decimal("100"), Decimal("200")]
        assert compute_52w_high(highs, meta={"fiftyTwoWeekHigh": "500.55"}) == Decimal("500.55")

    def test_meta_low_used_when_present(self) -> None:
        lows = [Decimal("50"), Decimal("40")]
        assert compute_52w_low(lows, meta={"fiftyTwoWeekLow": "12.34"}) == Decimal("12.34")

    def test_fallback_to_series_max(self) -> None:
        highs = [Decimal("10"), Decimal("50"), Decimal("30")]
        assert compute_52w_high(highs) == Decimal("50.00")

    def test_fallback_to_series_min(self) -> None:
        lows = [Decimal("10"), Decimal("5"), Decimal("30")]
        assert compute_52w_low(lows) == Decimal("5.00")

    def test_meta_zero_falls_through_to_series(self) -> None:
        highs = [Decimal("77")]
        assert compute_52w_high(highs, meta={"fiftyTwoWeekHigh": 0}) == Decimal("77.00")

    def test_empty_series_no_meta_returns_none(self) -> None:
        assert compute_52w_high([]) is None
        assert compute_52w_low([]) is None

    def test_only_trailing_252_bars_are_considered(self) -> None:
        # An old spike at the head is ignored; only tail contributes.
        highs = [Decimal("9999")] + [Decimal("100")] * 252
        assert compute_52w_high(highs) == Decimal("100.00")


class TestDistancePct:
    def test_distance_from_high(self) -> None:
        # hi=100, close=80 → (100-80)/100 * 100 = 20.00
        assert distance_from_52w_high_pct(Decimal("80"), Decimal("100")) == Decimal("20.00")

    def test_distance_from_low(self) -> None:
        # lo=50, close=75 → (75-50)/50 * 100 = 50.00
        assert distance_from_52w_low_pct(Decimal("75"), Decimal("50")) == Decimal("50.00")

    def test_none_returns_none(self) -> None:
        assert distance_from_52w_high_pct(Decimal("100"), None) is None
        assert distance_from_52w_low_pct(Decimal("100"), None) is None

    def test_zero_high_returns_none(self) -> None:
        assert distance_from_52w_high_pct(Decimal("100"), Decimal("0")) is None
