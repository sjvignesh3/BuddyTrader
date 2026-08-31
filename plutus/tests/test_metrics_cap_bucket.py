"""Unit tests for plutus.metrics.cap_bucket."""
from __future__ import annotations

from decimal import Decimal

from plutus.metrics.cap_bucket import classify_market_cap

CR = Decimal(10_000_000)   # 1 crore


class TestClassifyMarketCap:
    def test_large_at_threshold(self) -> None:
        assert classify_market_cap(Decimal(50_000) * CR) == "Large"

    def test_large_above_threshold(self) -> None:
        assert classify_market_cap(Decimal(200_000) * CR) == "Large"

    def test_mid_at_threshold(self) -> None:
        assert classify_market_cap(Decimal(15_000) * CR) == "Mid"

    def test_mid_below_large_threshold(self) -> None:
        assert classify_market_cap(Decimal(49_999) * CR) == "Mid"

    def test_small_at_threshold(self) -> None:
        assert classify_market_cap(Decimal(5_000) * CR) == "Small"

    def test_small_below_mid_threshold(self) -> None:
        assert classify_market_cap(Decimal(14_999) * CR) == "Small"

    def test_micro_below_small_threshold(self) -> None:
        assert classify_market_cap(Decimal(4_999) * CR) == "Micro"

    def test_none_returns_none(self) -> None:
        assert classify_market_cap(None) is None

    def test_zero_returns_none(self) -> None:
        assert classify_market_cap(Decimal(0)) is None

    def test_negative_returns_none(self) -> None:
        assert classify_market_cap(Decimal(-1)) is None
