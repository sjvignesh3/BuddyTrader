"""Fundamental Score strategy — the BuddyTrader 11-check score."""
from __future__ import annotations

from decimal import Decimal

from plutus.scan.base import STATUS_FAIL, STATUS_PASS
from plutus.scan.strategies.fundamental import (
    POINTS_MAX,
    FundamentalScreenerStrategy,
)


D = Decimal


def _snapshot(**overrides):
    """A snapshot that passes ALL 11 checks unless overridden."""
    snap = {
        "symbol": "TCS.NS",
        # Valuation (Screener weekly ratios, stamped by the daily sync)
        "pe_current": D("16.2"),
        "pb_current": D("8.00"),
        # Fundamentals latest row
        "pe_5y_avg": D("29.7"),
        "pb_5y_avg": D("13.2"),
        "net_debt_to_equity": D("-0.02"),
        "roce": D("63.0"),
        "roe": D("51.8"),
        "promoter_pledging_pct": D("0.00"),
        "promoter_holding_pct": D("71.77"),
        # Quarter-history aggregates (absolute rupees)
        "latest_q_sales": D("722750000000"),
        "latest_q_pbt": D("179440000000"),
        "latest_q_net_profit": D("134200000000"),
        "ath_q_sales": D("722750000000"),
        "ath_q_pbt": D("183620000000"),
        "ath_q_net_profit": D("137840000000"),
        # Same quarter last year (Jun 2025) + previous quarter (Mar 2026)
        "yoy_q_net_profit": D("128190000000"),
        "prev_q_net_profit": D("137840000000"),
    }
    snap.update(overrides)
    return snap


class TestElevenChecks:
    def test_all_pass_gives_11_points_and_pass_status(self):
        r = FundamentalScreenerStrategy().evaluate(_snapshot(), {})
        assert r.score == 11
        assert r.status == STATUS_PASS
        ms = r.metrics_snapshot
        assert ms["points"] == 11
        assert ms["points_max"] == POINTS_MAX == 11
        assert len(ms["checks"]) == 11
        assert all(c["passed"] is True for c in ms["checks"])
        assert len(r.reasons) == 11
        assert r.reasons[0].startswith("[PASS] 1. PE < 70")

    def test_check_ids(self):
        # Legacy Buddy list with one amendment (2026-09-02): the OPM check
        # was replaced by the cyclicality-aware YoY net-profit check.
        r = FundamentalScreenerStrategy().evaluate(_snapshot(), {})
        ids = [c["id"] for c in r.metrics_snapshot["checks"]]
        assert ids == ["pe_lt_70", "pe_lt_5yr", "pb_lt_5yr", "net_debt",
                       "roce", "roe", "sales_ath", "profit_ath", "pbt_ath",
                       "pledging", "np_yoy"]

    def test_missing_inputs_are_na_not_fail(self):
        snap = _snapshot(roce=None, promoter_pledging_pct=None)
        r = FundamentalScreenerStrategy().evaluate(snap, {})
        by_id = {c["id"]: c for c in r.metrics_snapshot["checks"]}
        assert by_id["roce"]["passed"] is None
        assert by_id["pledging"]["passed"] is None
        # Points count only definite passes.
        assert r.score == 9
        assert r.metrics_snapshot["unknown"] == 2
        assert r.status == STATUS_PASS  # 9 >= 8

    def test_ath_tolerance_is_90_percent(self):
        # latest exactly at 90% of ATH -> pass; just below -> fail.
        snap = _snapshot(latest_q_sales=D("90"), ath_q_sales=D("100"))
        r = FundamentalScreenerStrategy().evaluate(snap, {})
        assert {c["id"]: c["passed"] for c in r.metrics_snapshot["checks"]}["sales_ath"] is True

        snap = _snapshot(latest_q_sales=D("89.99"), ath_q_sales=D("100"))
        r = FundamentalScreenerStrategy().evaluate(snap, {})
        assert {c["id"]: c["passed"] for c in r.metrics_snapshot["checks"]}["sales_ath"] is False

    def test_np_yoy_growth_passes(self):
        # Latest 13,420 vs same-Q-last-year 12,819 → +4.7% YoY → pass.
        r = FundamentalScreenerStrategy().evaluate(_snapshot(), {})
        chk = {c["id"]: c for c in r.metrics_snapshot["checks"]}["np_yoy"]
        assert chk["passed"] is True
        assert "YoY" in chk["detail"]

    def test_np_yoy_cyclic_pattern_called_out(self):
        # QoQ DOWN (latest < previous quarter) but YoY UP -> pass, with the
        # cyclic/seasonal pattern named. This is the whole point: a soft
        # quarter in a seasonal business must not sink the stock.
        snap = _snapshot(
            latest_q_net_profit=D("100"),
            prev_q_net_profit=D("140"),      # QoQ dip
            yoy_q_net_profit=D("80"),        # +25% vs same Q last year
            ath_q_net_profit=D("140"),
            latest_q_sales=D("1000"), ath_q_sales=D("1000"),
            latest_q_pbt=D("130"), ath_q_pbt=D("140"),
        )
        r = FundamentalScreenerStrategy().evaluate(snap, {})
        chk = {c["id"]: c for c in r.metrics_snapshot["checks"]}["np_yoy"]
        assert chk["passed"] is True
        assert "cyclic/seasonal pattern" in chk["detail"]

    def test_np_yoy_decline_fails(self):
        snap = _snapshot(latest_q_net_profit=D("70"),
                         yoy_q_net_profit=D("100"))
        r = FundamentalScreenerStrategy().evaluate(snap, {})
        chk = {c["id"]: c for c in r.metrics_snapshot["checks"]}["np_yoy"]
        assert chk["passed"] is False

    def test_np_yoy_missing_is_na(self):
        snap = _snapshot(yoy_q_net_profit=None)
        r = FundamentalScreenerStrategy().evaluate(snap, {})
        chk = {c["id"]: c for c in r.metrics_snapshot["checks"]}["np_yoy"]
        assert chk["passed"] is None

    def test_np_yoy_turnaround_from_loss(self):
        # Loss in the same quarter last year, profitable now → pass.
        snap = _snapshot(latest_q_net_profit=D("50"),
                         yoy_q_net_profit=D("-20"))
        r = FundamentalScreenerStrategy().evaluate(snap, {})
        chk = {c["id"]: c for c in r.metrics_snapshot["checks"]}["np_yoy"]
        assert chk["passed"] is True
        assert "profitable" in chk["detail"]

    def test_weak_score_is_fail_status(self):
        snap = _snapshot(
            pe_current=D("80"),            # fails PE<70 and PE<5yr avg? 80>29.7 fail
            pb_current=D("20"),            # 20 > 13.2 fail
            net_debt_to_equity=D("1.5"),   # fail
            roce=D("5"), roe=D("5"),       # fail, fail
            promoter_pledging_pct=D("40"),  # fail
        )
        r = FundamentalScreenerStrategy().evaluate(snap, {})
        assert r.score <= 5
        assert r.status == STATUS_FAIL

    def test_thresholds_overridable_via_config(self):
        snap = _snapshot(roce=D("16.0"))
        cfg = {"thresholds": {"roce_min": "20"}}
        r = FundamentalScreenerStrategy().evaluate(snap, cfg)
        assert {c["id"]: c["passed"] for c in r.metrics_snapshot["checks"]}["roce"] is False

    def test_never_raises_on_garbage(self):
        r = FundamentalScreenerStrategy().evaluate({"symbol": "X.NS"}, {})
        assert r.score == 0
        assert r.metrics_snapshot["unknown"] == 11
        assert r.status == STATUS_FAIL
