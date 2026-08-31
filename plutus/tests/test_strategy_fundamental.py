"""
Fundamental Screener — bit-for-bit correctness gate.

We drive individual rules and assert PASS/FAIL/ERROR per the legacy contract
(safety-first: any missing input counts as fail).
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from plutus.scan.base import STATUS_ERROR, STATUS_FAIL, STATUS_PASS
from plutus.scan.strategies.fundamental import FundamentalScreenerStrategy


@pytest.fixture
def strat() -> FundamentalScreenerStrategy:
    return FundamentalScreenerStrategy()


def _full_snapshot(**overrides):
    base = {
        "symbol": "HDFCBANK",
        "pe_current": Decimal("18"),
        "pe_5y_avg": Decimal("22"),
        "pb_current": Decimal("2.5"),
        "pb_5y_avg": Decimal("3.0"),
        "roce": Decimal("20"),
        "roe": Decimal("18.5"),
        "net_debt_to_equity": Decimal("0.15"),
        "promoter_pledging_pct": Decimal("0"),
    }
    base.update(overrides)
    return base


class TestFundamentalAllPass:
    def test_every_rule_passes(self, strat):
        r = strat.evaluate(_full_snapshot(), {})
        assert r.status == STATUS_PASS
        assert r.score == 6   # 6 enabled rules, all pass
        counts = r.metrics_snapshot
        assert counts["passed_count"] == 6
        assert counts["failed_count"] == 0
        assert counts["skipped_count"] == 0


class TestFundamentalPartialFail:
    def test_one_failing_rule_flips_to_fail(self, strat):
        snap = _full_snapshot(roce=Decimal("10"))   # < default 18
        r = strat.evaluate(snap, {})
        assert r.status == STATUS_FAIL
        assert r.score == 5   # 5 passed, 1 failed
        assert r.metrics_snapshot["failed_count"] == 1

    def test_missing_pe_avg_is_fail(self, strat):
        snap = _full_snapshot(pe_5y_avg=None)
        r = strat.evaluate(snap, {})
        assert r.status == STATUS_FAIL
        # pe_below_avg fails, others pass
        assert r.metrics_snapshot["passed_count"] == 5

    def test_missing_pledging_is_fail_not_pass(self, strat):
        # Safety-first: None pledging is treated as fail.
        snap = _full_snapshot(promoter_pledging_pct=None)
        r = strat.evaluate(snap, {})
        assert r.status == STATUS_FAIL
        # find pledging rule in metrics
        rules = r.metrics_snapshot["rule_results"]
        pledge = next(x for x in rules if x["rule_id"] == "pledging_max")
        assert pledge["passed"] is False
        assert "safety" in pledge["reason"].lower()


class TestFundamentalConfigOverrides:
    def test_custom_threshold_flips_outcome(self, strat):
        # Default roce_min is 18; with 25, ROCE of 20 now fails.
        snap = _full_snapshot(roce=Decimal("20"))
        cfg = {"thresholds": {"roce_min": Decimal("25")}}
        r = strat.evaluate(snap, cfg)
        assert r.status == STATUS_FAIL

    def test_disabling_a_rule_skips_it(self, strat):
        snap = _full_snapshot(roce=Decimal("5"))    # would fail
        cfg = {"enabled_rules": {"roce_min": False}}
        r = strat.evaluate(snap, cfg)
        assert r.status == STATUS_PASS
        assert r.metrics_snapshot["skipped_count"] == 1

    def test_all_rules_disabled_returns_error(self, strat):
        cfg = {"enabled_rules": {k: False for k in [
            "pe_below_avg", "pb_below_avg", "roce_min", "roe_min",
            "net_debt_to_equity", "pledging_max",
        ]}}
        r = strat.evaluate(_full_snapshot(), cfg)
        assert r.status == STATUS_ERROR
