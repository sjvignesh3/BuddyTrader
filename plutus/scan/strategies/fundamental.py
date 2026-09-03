"""
Fundamental Score Strategy — the BuddyTrader 11-check score (out of 11).

Faithful port of the scoring contract in legacy
``backend/app/api/routes.py::getFundamentalsFromCache`` (the "Score
(out of 11)" column every Buddy view sorts by):

   1. PE < 70
   2. PE < 5yr Avg PE
   3. PB < 5yr Avg PB
   4. Net Debt/Equity < 0.25
   5. ROCE > 15%
   6. ROE > 15%
   7. Sales near ATH        (latest Q >= 90% of peak quarterly)
   8. Net Profit near ATH   (latest Q >= 90% of peak quarterly)
   9. PBT near ATH          (latest Q >= 90% of peak quarterly)
  10. Pledging < 5%
  11. Net Profit YoY (same quarter) — latest Q vs the SAME quarter last
      year. Cyclic/seasonal businesses post soft quarters by design; a
      QoQ dip with YoY growth is a pattern, not a red flag — this check
      rewards it instead of punishing it. (Replaced the old OPM check,
      decision 2026-09-02.)

Scoring rules (legacy semantics):
  * points = number of checks that DEFINITELY pass; unknown (missing
    input) counts as N/A — neither pass nor fail.
  * Colour bands downstream: 8–11 strong · 6–7 moderate · 0–5 weak.
  * status: PASS when points >= 8, FAIL otherwise (ERROR on bad input).

Inputs come from the snapshot dict AFTER the engine merges fundamentals:
  * pe_current / pb_current      — Screener weekly ratios (same source as
                                   the 5Y averages — apples to apples)
  * pe_5y_avg .. promoter_holding_pct — fundamentals latest row
  * latest_q_* / ath_q_* / *_opm — quarter-history aggregates
    (see engine.FUNDAMENTAL_AGG_COLS)

Every numeric is Decimal. The full per-check breakdown is persisted in
``metrics_snapshot`` so the UI renders the same 11-card grid Buddy had.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from plutus.scan.base import (
    STATUS_ERROR,
    STATUS_FAIL,
    STATUS_PASS,
    Strategy,
    StrategyResult,
    dec_or_default,
)

POINTS_MAX = 11
PASS_THRESHOLD_POINTS = 8   # legacy "strong" band lower bound

DEFAULTS = {
    "pe_max": Decimal("70"),
    "net_debt_to_equity_max": Decimal("0.25"),
    "roce_min": Decimal("15"),
    "roe_min": Decimal("15"),
    "pledging_max": Decimal("5"),
    "ath_tolerance": Decimal("0.90"),   # latest Q >= 90% of ATH quarter
    "yoy_growth_min": Decimal("0"),     # latest Q NP >= same-Q-last-year NP
}

_CRORE = Decimal(10_000_000)


def _fmt(v: Optional[Decimal], nd: int = 1) -> str:
    if v is None:
        return "—"
    q = Decimal(1).scaleb(-nd)
    return str(v.quantize(q))


def _fmt_cr(v: Optional[Decimal]) -> str:
    """Absolute-₹ Decimal -> '72,275 Cr' style string for check details."""
    if v is None:
        return "—"
    return f"{int(v / _CRORE):,} Cr"


class FundamentalScreenerStrategy(Strategy):
    """Snapshot-time evaluator. The snapshot dict must contain the merged
    fundamentals columns + quarter aggregates (the engine joins these)."""

    @property
    def strategy_id(self) -> str:
        return "fundamental_screener"

    @property
    def strategy_name(self) -> str:
        return "Fundamental Score"

    # ------------------------------------------------------------------
    def _checks(self, snap: Dict[str, Any],
                cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
        g = self._get_decimal
        pe = g(snap, "pe_current")
        pb = g(snap, "pb_current")
        pe5 = g(snap, "pe_5y_avg")
        pb5 = g(snap, "pb_5y_avg")
        nde = g(snap, "net_debt_to_equity")
        roce = g(snap, "roce")
        roe = g(snap, "roe")
        pledge = g(snap, "promoter_pledging_pct")
        lq_sales = g(snap, "latest_q_sales")
        lq_pbt = g(snap, "latest_q_pbt")
        lq_np = g(snap, "latest_q_net_profit")
        ath_sales = g(snap, "ath_q_sales")
        ath_pbt = g(snap, "ath_q_pbt")
        ath_np = g(snap, "ath_q_net_profit")
        yoy_np = g(snap, "yoy_q_net_profit")
        prev_np = g(snap, "prev_q_net_profit")

        pe_max = dec_or_default(cfg.get("pe_max"), DEFAULTS["pe_max"])
        nde_max = dec_or_default(cfg.get("net_debt_to_equity_max"),
                                 DEFAULTS["net_debt_to_equity_max"])
        roce_min = dec_or_default(cfg.get("roce_min"), DEFAULTS["roce_min"])
        roe_min = dec_or_default(cfg.get("roe_min"), DEFAULTS["roe_min"])
        pledge_max = dec_or_default(cfg.get("pledging_max"),
                                    DEFAULTS["pledging_max"])
        ath_tol = dec_or_default(cfg.get("ath_tolerance"),
                                 DEFAULTS["ath_tolerance"])
        yoy_min = dec_or_default(cfg.get("yoy_growth_min"),
                                 DEFAULTS["yoy_growth_min"])

        checks: List[Dict[str, Any]] = []

        def add(check_id: str, label: str,
                passed: Optional[bool], detail: str) -> None:
            checks.append({"id": check_id, "label": label,
                           "passed": passed, "detail": detail})

        # 1. PE < 70
        if pe is None:
            add("pe_lt_70", f"PE < {pe_max}", None, "PE not available")
        else:
            add("pe_lt_70", f"PE < {pe_max}", pe < pe_max,
                f"PE = {_fmt(pe)}")

        # 2. PE < 5yr avg
        if pe is None or pe5 is None:
            add("pe_lt_5yr", "PE < 5yr Avg PE", None,
                "PE or 5yr avg PE not available")
        else:
            add("pe_lt_5yr", "PE < 5yr Avg PE", pe < pe5,
                f"PE {_fmt(pe)} vs 5yr avg {_fmt(pe5)}")

        # 3. PB < 5yr avg
        if pb is None or pb5 is None:
            add("pb_lt_5yr", "PB < 5yr Avg PB", None,
                "PB or 5yr avg PB not available")
        else:
            add("pb_lt_5yr", "PB < 5yr Avg PB", pb < pb5,
                f"PB {_fmt(pb, 2)} vs 5yr avg {_fmt(pb5, 2)}")

        # 4. Net D/E
        if nde is None:
            add("net_debt", f"Net Debt/Eq < {nde_max}", None,
                "Net Debt to Equity not available")
        else:
            add("net_debt", f"Net Debt/Eq < {nde_max}", nde < nde_max,
                f"Net Debt/Eq = {_fmt(nde, 2)}")

        # 5. ROCE
        if roce is None:
            add("roce", f"ROCE > {roce_min}%", None, "ROCE not available")
        else:
            add("roce", f"ROCE > {roce_min}%", roce > roce_min,
                f"ROCE = {_fmt(roce)}%")

        # 6. ROE
        if roe is None:
            add("roe", f"ROE > {roe_min}%", None, "ROE not available")
        else:
            add("roe", f"ROE > {roe_min}%", roe > roe_min,
                f"ROE = {_fmt(roe)}%")

        # 7-9. Latest quarter vs all-time-high quarter (>= tolerance)
        for check_id, label, latest, ath in (
            ("sales_ath", "Sales near ATH (≥90%)", lq_sales, ath_sales),
            ("profit_ath", "Net Profit near ATH (≥90%)", lq_np, ath_np),
            ("pbt_ath", "PBT near ATH (≥90%)", lq_pbt, ath_pbt),
        ):
            if latest is None or ath is None:
                add(check_id, label, None, "Quarterly data not available")
            else:
                threshold = ath * ath_tol
                add(check_id, label, latest >= threshold,
                    f"Latest Q {_fmt_cr(latest)} vs ATH {_fmt_cr(ath)}")

        # 10. Pledging
        if pledge is None:
            add("pledging", f"Pledging < {pledge_max}%", None,
                "Pledging data not available")
        else:
            add("pledging", f"Pledging < {pledge_max}%", pledge < pledge_max,
                f"Pledging = {_fmt(pledge)}%")

        # 11. Net Profit YoY — same quarter last year (cyclicality-aware).
        # A seasonally soft latest quarter is judged against ITS OWN season,
        # not the previous quarter; QoQ-down-but-YoY-up is called out as a
        # cyclic pattern (conviction booster), never a knock-out.
        if lq_np is None or yoy_np is None:
            add("np_yoy", "Net Profit YoY (same quarter)", None,
                "Same-quarter-last-year net profit not available")
        elif yoy_np <= 0:
            add("np_yoy", "Net Profit YoY (same quarter)", lq_np > 0,
                f"Turned {'profitable' if lq_np > 0 else 'loss-making'} vs "
                f"loss in the same quarter last year")
        else:
            growth = (lq_np - yoy_np) / yoy_np * Decimal(100)
            passed = growth >= yoy_min
            detail = (f"Latest Q {_fmt_cr(lq_np)} vs same Q last year "
                      f"{_fmt_cr(yoy_np)} ({'+' if growth >= 0 else ''}"
                      f"{_fmt(growth)}% YoY)")
            if passed and prev_np is not None and lq_np < prev_np:
                detail += " — QoQ dip but YoY up: cyclic/seasonal pattern"
            add("np_yoy", "Net Profit YoY (same quarter)", passed, detail)

        return checks

    # ------------------------------------------------------------------
    def evaluate(self, snapshot: Dict[str, Any],
                 config: Dict[str, Any]) -> StrategyResult:
        symbol = snapshot.get("symbol", "?")
        cfg = (config or {}).get("thresholds") or {}
        try:
            checks = self._checks(snapshot, cfg)
        except Exception as exc:  # noqa: BLE001 — never raise
            return StrategyResult(
                strategy_id=self.strategy_id,
                strategy_name=self.strategy_name,
                symbol=symbol, status=STATUS_ERROR, score=0,
                reasons=[f"evaluation failed: {type(exc).__name__}: {exc}"],
                errors=[str(exc)],
            )

        points = sum(1 for c in checks if c["passed"] is True)
        unknown = sum(1 for c in checks if c["passed"] is None)
        status = STATUS_PASS if points >= PASS_THRESHOLD_POINTS else STATUS_FAIL

        reasons = []
        for i, c in enumerate(checks, 1):
            mark = "N/A" if c["passed"] is None else (
                "PASS" if c["passed"] else "FAIL")
            reasons.append(f"[{mark}] {i}. {c['label']} — {c['detail']}")

        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.strategy_name,
            symbol=symbol,
            status=status,
            score=points,
            reasons=reasons,
            metrics_snapshot={
                "points": points,
                "points_max": POINTS_MAX,
                "unknown": unknown,
                "checks": checks,
                "data": {
                    "current_pe": self._get_decimal(snapshot, "pe_current"),
                    "pe_5yr_avg": self._get_decimal(snapshot, "pe_5y_avg"),
                    "current_pb": self._get_decimal(snapshot, "pb_current"),
                    "pb_5yr_avg": self._get_decimal(snapshot, "pb_5y_avg"),
                    "roce": self._get_decimal(snapshot, "roce"),
                    "roe": self._get_decimal(snapshot, "roe"),
                    "net_debt_to_equity": self._get_decimal(snapshot, "net_debt_to_equity"),
                    "pledging": self._get_decimal(snapshot, "promoter_pledging_pct"),
                    "promoter_holding": self._get_decimal(snapshot, "promoter_holding_pct"),
                    "latest_sales": self._get_decimal(snapshot, "latest_q_sales"),
                    "latest_pbt": self._get_decimal(snapshot, "latest_q_pbt"),
                    "latest_profit": self._get_decimal(snapshot, "latest_q_net_profit"),
                    "ath_sales": self._get_decimal(snapshot, "ath_q_sales"),
                    "ath_pbt": self._get_decimal(snapshot, "ath_q_pbt"),
                    "ath_profit": self._get_decimal(snapshot, "ath_q_net_profit"),
                    "yoy_profit": self._get_decimal(snapshot, "yoy_q_net_profit"),
                    "prev_profit": self._get_decimal(snapshot, "prev_q_net_profit"),
                    "yoy_quarter": snapshot.get("yoy_quarter_label"),
                },
            },
        )
