"""Unit tests for plutus.metrics.dma."""
from __future__ import annotations

from decimal import Decimal

import pytest

from plutus.metrics.dma import compute_below_dma_pct, compute_dma


class TestComputeDma:
    def test_flat_series_returns_same_price(self) -> None:
        prices = [Decimal("100.00")] * 200
        assert compute_dma(prices, window=200) == Decimal("100.00")

    def test_simple_average_hand_computed(self) -> None:
        # 4 numbers, average = 250 / 4 = 62.50
        prices = [Decimal("10"), Decimal("50"), Decimal("90"), Decimal("100")]
        assert compute_dma(prices, window=4) == Decimal("62.50")

    def test_only_last_window_is_averaged(self) -> None:
        # First 100 values ignored; last 4 → avg = 82.50
        prices = [Decimal("1")] * 100 + [
            Decimal("80"), Decimal("80"), Decimal("85"), Decimal("85"),
        ]
        assert compute_dma(prices, window=4) == Decimal("82.50")

    def test_fewer_than_window_falls_back_to_available(self) -> None:
        prices = [Decimal("10"), Decimal("20"), Decimal("30")]
        # average of 3 values = 20.00
        assert compute_dma(prices, window=200) == Decimal("20.00")

    def test_empty_returns_none(self) -> None:
        assert compute_dma([]) is None

    def test_bad_window_raises(self) -> None:
        with pytest.raises(ValueError):
            compute_dma([Decimal(1)], window=0)


class TestBelowDmaPct:
    def test_close_below_dma_is_positive(self) -> None:
        # dma=100, close=80 → (100-80)/100 * 100 = 20.00
        result = compute_below_dma_pct(Decimal("80"), Decimal("100"))
        assert result == Decimal("20.00")

    def test_close_above_dma_is_negative(self) -> None:
        # dma=100, close=120 → (100-120)/100 * 100 = -20.00
        result = compute_below_dma_pct(Decimal("120"), Decimal("100"))
        assert result == Decimal("-20.00")

    def test_close_equal_dma_is_zero(self) -> None:
        result = compute_below_dma_pct(Decimal("100"), Decimal("100"))
        assert result == Decimal("0.00")

    def test_none_dma_returns_none(self) -> None:
        assert compute_below_dma_pct(Decimal("100"), None) is None

    def test_zero_dma_returns_none(self) -> None:
        assert compute_below_dma_pct(Decimal("100"), Decimal("0")) is None
