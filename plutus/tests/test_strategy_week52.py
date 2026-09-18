"""
52W High/Low strategy — bit-for-bit correctness gate.
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
from plutus.scan.strategies.week52 import Week52HighLowStrategy


@pytest.fixture
def strat() -> Week52HighLowStrategy:
    return Week52HighLowStrategy()


def _snap(dist_low, dist_high=Decimal("30"), low=Decimal("100"),
          high=Decimal("200"), close=Decimal("100"), sym="TCS"):
    return {
        "symbol": sym,
        "distance_from_52w_low_pct": dist_low,
        "distance_from_52w_high_pct": dist_high,
        "low_52w": low,
        "high_52w": high,
        "close": close,
    }


class TestWeek52Thresholds:
    def test_buy_zone_at_or_below_half_percent(self, strat):
        for d in ("0", "0.4", "0.5"):
            r = strat.evaluate(_snap(Decimal(d)), {})
            assert r.status == STATUS_BUY_ZONE, d
            assert r.score == 100

    def test_opportunity_between_half_and_five(self, strat):
        for d in ("0.51", "3.0", "5.0"):
            r = strat.evaluate(_snap(Decimal(d)), {})
            assert r.status == STATUS_OPPORTUNITY, d
            assert r.score == 75

    def test_no_signal_above_five(self, strat):
        for d in ("5.01", "10", "50"):
            r = strat.evaluate(_snap(Decimal(d)), {})
            assert r.status == STATUS_NO_SIGNAL, d
            assert r.score == 0


class TestWeek52ConfigOverrides:
    def test_custom_tolerance_widens_buy_zone(self, strat):
        cfg = {"inputs": {"buy_zone_tolerance_pct": 1.0}}
        r = strat.evaluate(_snap(Decimal("0.9")), cfg)
        assert r.status == STATUS_BUY_ZONE


class TestWeek52Safety:
    def test_missing_input_is_no_signal_not_error(self, strat):
        # A session without a usable close / 52W low is a data gap, not an
        # evaluation failure — the scan must stay green for everyone else.
        snap = {
            "symbol": "X",
            "distance_from_52w_low_pct": None,
            "distance_from_52w_high_pct": None,
            "low_52w": None, "high_52w": None, "close": None,
        }
        r = strat.evaluate(snap, {})
        assert r.status == STATUS_NO_SIGNAL
        assert r.score == 0
        assert not r.errors
        assert "unavailable" in "; ".join(r.reasons)

    def test_float_rejected(self, strat):
        snap = {
            "symbol": "X",
            "distance_from_52w_low_pct": 2.5,
            "distance_from_52w_high_pct": None,
            "low_52w": None, "high_52w": None, "close": None,
        }
        r = strat.evaluate(snap, {})
        assert r.status == STATUS_ERROR
