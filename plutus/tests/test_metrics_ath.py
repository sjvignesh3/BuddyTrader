"""Unit tests for plutus.metrics.ath."""
from __future__ import annotations

from decimal import Decimal

import pytest

from plutus.metrics.ath import compute_ath, gap_from_ath_pct


class TestComputeAth:
    def test_no_adjustment_when_adj_equals_close(self) -> None:
        highs = [Decimal("100"), Decimal("150"), Decimal("120")]
        closes = [Decimal("95"), Decimal("140"), Decimal("115")]
        adj = list(closes)  # no dividends → adj_close == close
        # ATH = max(high * 1.0) = 150.00
        assert compute_ath(highs, closes, adj) == Decimal("150.00")

    def test_adjustment_shrinks_pre_dividend_prices(self) -> None:
        # Bar 0: high=100, close=100, adj=80  → 100 * (80/100) = 80
        # Bar 1: high=120, close=120, adj=120 → 120
        # ATH = 120.00
        highs = [Decimal("100"), Decimal("120")]
        closes = [Decimal("100"), Decimal("120")]
        adj = [Decimal("80"), Decimal("120")]
        assert compute_ath(highs, closes, adj) == Decimal("120.00")

    def test_hand_computed_three_bars(self) -> None:
        # Bar A: h=200 c=100 a=50   → 200 * 0.5 = 100
        # Bar B: h=300 c=100 a=100  → 300
        # Bar C: h=250 c=100 a=200  → 500
        # ATH = 500.00
        highs = [Decimal("200"), Decimal("300"), Decimal("250")]
        closes = [Decimal("100"), Decimal("100"), Decimal("100")]
        adj = [Decimal("50"), Decimal("100"), Decimal("200")]
        assert compute_ath(highs, closes, adj) == Decimal("500.00")

    def test_zero_close_bar_is_skipped(self) -> None:
        highs = [Decimal("100"), Decimal("120")]
        closes = [Decimal("0"), Decimal("120")]   # bar 0 unusable
        adj = [Decimal("100"), Decimal("120")]
        assert compute_ath(highs, closes, adj) == Decimal("120.00")

    def test_empty_returns_none(self) -> None:
        assert compute_ath([], [], []) is None

    def test_length_mismatch_raises(self) -> None:
        with pytest.raises(ValueError):
            compute_ath([Decimal(1)], [Decimal(1), Decimal(2)], [Decimal(1)])


class TestGapFromAth:
    def test_basic(self) -> None:
        # ath=200, close=150 → (200-150)/200 * 100 = 25.00
        assert gap_from_ath_pct(Decimal("150"), Decimal("200")) == Decimal("25.00")

    def test_at_ath_is_zero(self) -> None:
        assert gap_from_ath_pct(Decimal("200"), Decimal("200")) == Decimal("0.00")

    def test_none_ath_returns_none(self) -> None:
        assert gap_from_ath_pct(Decimal("100"), None) is None

    def test_zero_ath_returns_none(self) -> None:
        assert gap_from_ath_pct(Decimal("100"), Decimal("0")) is None
