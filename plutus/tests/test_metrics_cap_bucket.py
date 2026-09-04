"""Unit tests for plutus.metrics.cap_bucket."""
from __future__ import annotations

from decimal import Decimal

from plutus.metrics.cap_bucket import classify_market_cap

CR = Decimal(10_000_000)   # 1 crore


class TestClassifyMarketCap:
    # Boundaries: Large >= 1,00,000 Cr · Mid >= 30,000 Cr · Small >= 10,000 Cr.

    def test_large_at_threshold(self) -> None:
        assert classify_market_cap(Decimal(100_000) * CR) == "Large"

    def test_large_above_threshold(self) -> None:
        assert classify_market_cap(Decimal(2_000_000) * CR) == "Large"

    def test_mid_at_threshold(self) -> None:
        assert classify_market_cap(Decimal(30_000) * CR) == "Mid"

    def test_mid_below_large_threshold(self) -> None:
        assert classify_market_cap(Decimal(99_999) * CR) == "Mid"

    def test_small_at_threshold(self) -> None:
        assert classify_market_cap(Decimal(10_000) * CR) == "Small"

    def test_small_below_mid_threshold(self) -> None:
        assert classify_market_cap(Decimal(29_999) * CR) == "Small"

    def test_kpittech_16k_cr_is_small(self) -> None:
        # Regression: ~16K Cr was misclassified as Mid under the stale
        # 15K-Cr mid threshold.
        assert classify_market_cap(Decimal(16_000) * CR) == "Small"

    def test_micro_below_small_threshold(self) -> None:
        assert classify_market_cap(Decimal(9_999) * CR) == "Micro"

    def test_none_returns_none(self) -> None:
        assert classify_market_cap(None) is None

    def test_zero_returns_none(self) -> None:
        assert classify_market_cap(Decimal(0)) is None

    def test_negative_returns_none(self) -> None:
        assert classify_market_cap(Decimal(-1)) is None


class TestEnvOverrides:
    def test_env_override_changes_threshold(self, monkeypatch) -> None:
        import importlib

        import plutus.metrics.cap_bucket as cb

        monkeypatch.setenv("PLUTUS_CAP_MID_MIN_CR", "40000")
        importlib.reload(cb)
        try:
            assert cb.classify_market_cap(Decimal(35_000) * CR) == "Small"
            assert cb.classify_market_cap(Decimal(40_000) * CR) == "Mid"
        finally:
            monkeypatch.delenv("PLUTUS_CAP_MID_MIN_CR")
            importlib.reload(cb)
