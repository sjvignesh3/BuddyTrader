"""Unit tests for plutus.metrics.pe_pb."""
from __future__ import annotations

from decimal import Decimal

from plutus.metrics.pe_pb import pb_5yr_avg, pe_5yr_avg, pick_pb, pick_pe


class TestPickPe:
    def test_trailing_pe_preferred(self) -> None:
        info = {"trailingPE": 25.5, "forwardPE": 30.0}
        assert pick_pe(info) == Decimal("25.50")

    def test_forward_pe_fallback(self) -> None:
        info = {"trailingPE": None, "forwardPE": 30.0}
        assert pick_pe(info) == Decimal("30.00")

    def test_negative_pe_rejected(self) -> None:
        # Loss-making companies: yfinance sometimes reports negative PE — drop it.
        info = {"trailingPE": -12.0, "forwardPE": None}
        assert pick_pe(info) is None

    def test_zero_treated_as_missing(self) -> None:
        info = {"trailingPE": 0, "forwardPE": 18.5}
        assert pick_pe(info) == Decimal("18.50")

    def test_empty_info_returns_none(self) -> None:
        assert pick_pe({}) is None
        assert pick_pe(None) is None

    def test_absurd_ratio_rejected(self) -> None:
        # Outside sanity_check_ratio band
        info = {"trailingPE": 999999}
        assert pick_pe(info) is None


class TestPickPb:
    def test_basic(self) -> None:
        info = {"priceToBook": 4.2}
        assert pick_pb(info) == Decimal("4.20")

    def test_missing_returns_none(self) -> None:
        assert pick_pb({}) is None


class TestFiveYrAverages:
    def test_pe_5yr_avg_stub_returns_none(self) -> None:
        # Deferred to Stage 5 — must not raise, must return None.
        assert pe_5yr_avg() is None

    def test_pb_5yr_avg_stub_returns_none(self) -> None:
        assert pb_5yr_avg() is None
