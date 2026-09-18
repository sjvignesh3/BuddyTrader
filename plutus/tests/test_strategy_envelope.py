"""
Envelope strategy — bit-for-bit correctness gate.

Every test uses Decimals only and hand-computes the expected outcome from
the rule spec seeded by migrations/005_strategy_configs.sql.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from plutus.scan.base import (
    STATUS_BUY_ZONE,
    STATUS_ERROR,
    STATUS_NO_SIGNAL,
    STATUS_OPPORTUNITY,
)
from plutus.scan.strategies.envelope import EnvelopeStrategy


@pytest.fixture
def strat() -> EnvelopeStrategy:
    return EnvelopeStrategy()


def _snap(below_dma_pct, dma=Decimal("2000"), close=Decimal("1700"), sym="RELIANCE"):
    return {
        "symbol": sym,
        "below_200dma_pct": below_dma_pct,
        "dma_200": dma,
        "close": close,
    }


class TestEnvelopeThresholds:
    def test_buy_zone_exactly_at_14(self, strat):
        r = strat.evaluate(_snap(Decimal("14.0")), {})
        assert r.status == STATUS_BUY_ZONE
        assert r.score == 100

    def test_buy_zone_above_14(self, strat):
        r = strat.evaluate(_snap(Decimal("14.7")), {})
        assert r.status == STATUS_BUY_ZONE
        assert r.score == 100

    def test_opportunity_exactly_at_9(self, strat):
        r = strat.evaluate(_snap(Decimal("9.0")), {})
        assert r.status == STATUS_OPPORTUNITY
        assert r.score == 70

    def test_opportunity_between_9_and_14(self, strat):
        r = strat.evaluate(_snap(Decimal("10.5")), {})
        assert r.status == STATUS_OPPORTUNITY
        assert r.score == 70

    def test_no_signal_below_9(self, strat):
        r = strat.evaluate(_snap(Decimal("8.99")), {})
        assert r.status == STATUS_NO_SIGNAL
        assert r.score == 0

    def test_no_signal_zero(self, strat):
        r = strat.evaluate(_snap(Decimal("0")), {})
        assert r.status == STATUS_NO_SIGNAL
        assert r.score == 0


class TestEnvelopeConfigOverrides:
    def test_custom_thresholds_win(self, strat):
        cfg = {
            "inputs": {
                "buy_zone_below_dma_pct": 20.0,
                "opportunity_below_dma_pct": 12.0,
            },
        }
        # 14% under default is BUY_ZONE, but with buy_zone=20 it's now OPPORTUNITY.
        r = strat.evaluate(_snap(Decimal("14.0")), cfg)
        assert r.status == STATUS_OPPORTUNITY

    def test_custom_score_map_used(self, strat):
        cfg = {"score_map": {"BUY_ZONE": 999, "OPPORTUNITY": 55, "NO_SIGNAL": 0}}
        r = strat.evaluate(_snap(Decimal("15.0")), cfg)
        assert r.status == STATUS_BUY_ZONE
        assert r.score == 999


class TestEnvelopeSafety:
    def test_missing_dma_is_no_signal_not_error(self, strat):
        # A recent listing has no 200-DMA yet — that is "nothing to say",
        # not a failure. An ERROR here used to turn the whole scan workflow
        # red for one IPO (BLIL.NS, 2026-09-18).
        snap = {"symbol": "X", "below_200dma_pct": None, "dma_200": None, "close": None}
        r = strat.evaluate(snap, {})
        assert r.status == STATUS_NO_SIGNAL
        assert r.score == 0
        assert not r.errors
        assert "200 DMA unavailable" in "; ".join(r.reasons)
        assert r.metrics_snapshot["below_200dma_pct"] is None

    def test_float_input_rejected(self, strat):
        # If a caller sneaks a float in, we must NOT silently convert.
        snap = {"symbol": "X", "below_200dma_pct": 12.5, "dma_200": None, "close": None}
        r = strat.evaluate(snap, {})
        assert r.status == STATUS_ERROR
        assert "must be Decimal" in "; ".join(r.errors)

    def test_metrics_snapshot_returns_decimal(self, strat):
        r = strat.evaluate(_snap(Decimal("15.0")), {})
        assert isinstance(r.metrics_snapshot["below_200dma_pct"], Decimal)
        assert isinstance(r.metrics_snapshot["threshold_buy_zone_pct"], Decimal)
