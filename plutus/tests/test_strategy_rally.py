"""
20% Rally strategy — bit-for-bit correctness gate.

The rally boolean is computed upstream; this strategy just consumes it
and enriches with the display metrics.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from plutus.scan.base import STATUS_INVALID, STATUS_VALID
from plutus.scan.strategies.rally import Rally20PercentStrategy


@pytest.fixture
def strat() -> Rally20PercentStrategy:
    return Rally20PercentStrategy()


class TestRallyOutcome:
    def test_valid_rally_scores_100(self, strat):
        snap = {
            "symbol": "INFY",
            "has_valid_20pct_rally": True,
            "last_rally_pct": Decimal("23.5"),
            "last_rally_low": Decimal("1500"),
            "last_rally_high": Decimal("1853"),
            "last_rally_start_date": date(2024, 3, 1),
            "last_rally_end_date": date(2024, 4, 15),
            "days_since_last_rally": 20,
        }
        r = strat.evaluate(snap, {})
        assert r.status == STATUS_VALID
        assert r.score == 100
        # audit fields carried through
        assert r.metrics_snapshot["last_rally_pct"] == Decimal("23.5")
        assert r.metrics_snapshot["last_rally_low"] == Decimal("1500")
        assert r.metrics_snapshot["last_rally_high"] == Decimal("1853")

    def test_invalid_rally_scores_zero(self, strat):
        snap = {
            "symbol": "INFY",
            "has_valid_20pct_rally": False,
            "last_rally_pct": Decimal("18"),
            "last_rally_low": Decimal("1500"),
            "last_rally_high": Decimal("1770"),
            "last_rally_start_date": None,
            "last_rally_end_date": None,
            "days_since_last_rally": None,
        }
        r = strat.evaluate(snap, {})
        assert r.status == STATUS_INVALID
        assert r.score == 0

    def test_missing_rally_block_defaults_to_invalid(self, strat):
        # Snapshot with none of the rally fields — safe fallback.
        r = strat.evaluate({"symbol": "X"}, {})
        assert r.status == STATUS_INVALID
        assert r.score == 0

    def test_custom_threshold_and_window_flow_into_reasons(self, strat):
        snap = {"symbol": "X", "has_valid_20pct_rally": True,
                "last_rally_pct": Decimal("22"),
                "last_rally_low": Decimal("100"),
                "last_rally_high": Decimal("122"),
                "last_rally_start_date": None,
                "last_rally_end_date": None,
                "days_since_last_rally": None}
        cfg = {"inputs": {"movement_threshold_pct": 25.0, "validity_window_days": 90}}
        r = strat.evaluate(snap, cfg)
        assert r.status == STATUS_VALID
        # Threshold and window make it into the reasons list.
        joined = " ".join(r.reasons)
        assert "25" in joined
        assert "90" in joined
