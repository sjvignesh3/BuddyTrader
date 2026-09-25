"""
Fundamental Score Strategy — the BuddyTrader 11-check score (out of 11).

Two check lists, one score contract. The snapshot's ``sector_group``
(stocks.sector_group — Banks | NBFC | Normal, migration 019) picks the list:

NORMAL (faithful port of the legacy Buddy `getFundamentalsFromCache`):
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

BANKS / NBFC (decision 2026-09-25 — lenders have no meaningful Net D/E,
ROCE or "Sales", so those checks always failed and sank every bank):
   1. PE < 30
   2. PE < 5yr Avg PE
   3. PB < 5yr Avg PB
   4. ROE > 12% (Banks) / 15% (NBFC)
   5. ROA > 1.2% (Banks) / 2% (NBFC)
   6. Net Profit TTM > ₹1,000 Cr   (newest four quarters)
   7. Net Profit YoY (same quarter)
   8. Net Profit near ATH
   9. Pledging < 5%
  10. Gross NPA < 3%
  11. Net NPA < 1%

Scoring rules (legacy semantics, both lists):
  * points = number of checks that DEFINITELY pass; unknown (missing
    input) counts as N/A — neither pass nor fail.
  * Colour bands downstream: 8–11 strong · 6–7 moderate · 0–5 weak.
  * status: PASS when points >= 8, FAIL otherwise (ERROR on bad input).

Thresholds come from ``config["thresholds"]``; group overrides live under
``config["thresholds"]["groups"]["Banks" | "NBFC"]`` (see GROUP_DEFAULTS).

Inputs come from the snapshot dict AFTER the engine merges fundamentals:
  * pe_current / pb_current      — Screener weekly ratios (same source as
                                   the 5Y averages — apples to apples)
  * pe_5y_avg .. promoter_holding_pct, roa — fundamentals latest row
  * latest_q_* / ath_q_* / ttm_* / latest_q_*_npa_pct — quarter-history
    aggregates (see engine.FUNDAMENTAL_AGG_COLS)
  * sector_group                 — stamped by the engine from `stocks`

Every numeric is Decimal. The full per-check breakdown is persisted in
``metrics_snapshot`` so the UI renders the same 11-card grid Buddy had;
``metrics_snapshot["group"]`` names the list that was applied.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, List, Optional

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

# Lender groups (stocks.sector_group values that take the bank list).
LENDER_GROUPS = ("Banks", "NBFC")
GROUP_NORMAL = "Normal"

# Per-group thresholds. NBFCs run leaner balance sheets and are expected to
# earn more on them, hence the stricter ROE / ROA bars.
GROUP_DEFAULTS: Dict[str, Dict[str, Decimal]] = {
    "Banks": {
        "pe_max": Decimal("30"),
        "roe_min": Decimal("12"),
        "roa_min": Decimal("1.2"),
        "net_profit_ttm_min_cr": Decimal("1000"),
        "gross_npa_max": Decimal("3"),
        "net_npa_max": Decimal("1"),
        "pledging_max": DEFAULTS["pledging_max"],
        "ath_tolerance": DEFAULTS["ath_tolerance"],
        "yoy_growth_min": DEFAULTS["yoy_growth_min"],
    },
    "NBFC": {
        "pe_max": Decimal("30"),
        "roe_min": Decimal("15"),
        "roa_min": Decimal("2"),
        "net_profit_ttm_min_cr": Decimal("1000"),
        "gross_npa_max": Decimal("3"),
        "net_npa_max": Decimal("1"),
        "pledging_max": DEFAULTS["pledging_max"],
        "ath_tolerance": DEFAULTS["ath_tolerance"],
        "yoy_growth_min": DEFAULTS["yoy_growth_min"],
    },
}

# Keys a group may inherit from the top-level thresholds when the group
# block does not override them (shared Buddy constants).
_SHARED_KEYS = ("pledging_max", "ath_tolerance", "yoy_growth_min")

_CRORE = Decimal(10_000_000)


def resolve_group(raw: Any) -> str:
    """snapshot['sector_group'] -> 'Banks' | 'NBFC' | 'Normal'.
    Unknown / NULL groups take the Normal list (the safe legacy default)."""
    if isinstance(raw, str):
        s = raw.strip()
        for g in LENDER_GROUPS:
            if s.lower() == g.lower():
                return g
    return GROUP_NORMAL


def group_thresholds(group: str, cfg: Dict[str, Any]) -> Dict[str, Decimal]:
    """Effective thresholds for a lender group: group block in the config
    -> shared top-level keys -> GROUP_DEFAULTS."""
    base = GROUP_DEFAULTS[group]
    groups_cfg = (cfg or {}).get("groups") or {}
    gcfg = groups_cfg.get(group) or {}
    out: Dict[str, Decimal] = {}
    for key, default in base.items():
        val = gcfg.get(key)
        if val is None and key in _SHARED_KEYS:
            val = (cfg or {}).get(key)
        out[key] = dec_or_default(val, default)
    return out


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
    # Shared check builders (both lists)
    # ------------------------------------------------------------------
    @staticmethod
    def _add(checks: List[Dict[str, Any]], check_id: str, label: str,
             passed: Optional[bool], detail: str) -> None:
        checks.append({"id": check_id, "label": label,
                       "passed": passed, "detail": detail})

    def _check_pe(self, checks, check_id, pe, pe_max) -> None:
        if pe is None:
            self._add(checks, check_id, f"PE < {pe_max}", None, "PE not available")
        else:
            self._add(checks, check_id, f"PE < {pe_max}", pe < pe_max,
                      f"PE = {_fmt(pe)}")

    def _check_pe_5yr(self, checks, pe, pe5) -> None:
        if pe is None or pe5 is None:
            self._add(checks, "pe_lt_5yr", "PE < 5yr Avg PE", None,
                      "PE or 5yr avg PE not available")
        else:
            self._add(checks, "pe_lt_5yr", "PE < 5yr Avg PE", pe < pe5,
                      f"PE {_fmt(pe)} vs 5yr avg {_fmt(pe5)}")

    def _check_pb_5yr(self, checks, pb, pb5) -> None:
        if pb is None or pb5 is None:
            self._add(checks, "pb_lt_5yr", "PB < 5yr Avg PB", None,
                      "PB or 5yr avg PB not available")
        else:
            self._add(checks, "pb_lt_5yr", "PB < 5yr Avg PB", pb < pb5,
                      f"PB {_fmt(pb, 2)} vs 5yr avg {_fmt(pb5, 2)}")

    def _check_min_pct(self, checks, check_id, name, value, minimum) -> None:
        """'ROE > 15%' style: value strictly above the bar."""
        label = f"{name} > {minimum}%"
        if value is None:
            self._add(checks, check_id, label, None, f"{name} not available")
        else:
            self._add(checks, check_id, label, value > minimum,
                      f"{name} = {_fmt(value)}%")

    def _check_max_pct(self, checks, check_id, name, value, maximum,
                       missing_detail: Optional[str] = None) -> None:
        """'Pledging < 5%' style: value strictly below the bar."""
        label = f"{name} < {maximum}%"
        if value is None:
            self._add(checks, check_id, label, None,
                      missing_detail or f"{name} not available")
        else:
            self._add(checks, check_id, label, value < maximum,
                      f"{name} = {_fmt(value)}%")

    def _check_ath(self, checks, check_id, label, latest, ath, tol) -> None:
        if latest is None or ath is None:
            self._add(checks, check_id, label, None, "Quarterly data not available")
        else:
            threshold = ath * tol
            self._add(checks, check_id, label, latest >= threshold,
                      f"Latest Q {_fmt_cr(latest)} vs ATH {_fmt_cr(ath)}")

    def _check_np_yoy(self, checks, lq_np, yoy_np, prev_np, yoy_min) -> None:
        # Same quarter last year (cyclicality-aware). A seasonally soft
        # latest quarter is judged against ITS OWN season, not the previous
        # quarter; QoQ-down-but-YoY-up is called out as a cyclic pattern
        # (conviction booster), never a knock-out.
        label = "Net Profit YoY (same quarter)"
        if lq_np is None or yoy_np is None:
            self._add(checks, "np_yoy", label, None,
                      "Same-quarter-last-year net profit not available")
        elif yoy_np <= 0:
            self._add(checks, "np_yoy", label, lq_np > 0,
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
            self._add(checks, "np_yoy", label, passed, detail)

    # ------------------------------------------------------------------
    # NORMAL list (legacy Buddy)
    # ------------------------------------------------------------------
    def _checks_normal(self, snap: Dict[str, Any],
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
        # 1-3. Valuation
        self._check_pe(checks, "pe_lt_70", pe, pe_max)
        self._check_pe_5yr(checks, pe, pe5)
        self._check_pb_5yr(checks, pb, pb5)
        # 4. Net D/E
        if nde is None:
            self._add(checks, "net_debt", f"Net Debt/Eq < {nde_max}", None,
                      "Net Debt to Equity not available")
        else:
            self._add(checks, "net_debt", f"Net Debt/Eq < {nde_max}", nde < nde_max,
                      f"Net Debt/Eq = {_fmt(nde, 2)}")
        # 5-6. Returns
        self._check_min_pct(checks, "roce", "ROCE", roce, roce_min)
        self._check_min_pct(checks, "roe", "ROE", roe, roe_min)
        # 7-9. Latest quarter vs all-time-high quarter (>= tolerance)
        self._check_ath(checks, "sales_ath", "Sales near ATH (≥90%)", lq_sales, ath_sales, ath_tol)
        self._check_ath(checks, "profit_ath", "Net Profit near ATH (≥90%)", lq_np, ath_np, ath_tol)
        self._check_ath(checks, "pbt_ath", "PBT near ATH (≥90%)", lq_pbt, ath_pbt, ath_tol)
        # 10. Pledging
        self._check_max_pct(checks, "pledging", "Pledging", pledge, pledge_max,
                            "Pledging data not available")
        # 11. Net Profit YoY
        self._check_np_yoy(checks, lq_np, yoy_np, prev_np, yoy_min)
        return checks

    # ------------------------------------------------------------------
    # BANKS / NBFC list
    # ------------------------------------------------------------------
    def _checks_lender(self, snap: Dict[str, Any], cfg: Dict[str, Any],
                       group: str) -> List[Dict[str, Any]]:
        g = self._get_decimal
        t = group_thresholds(group, cfg)
        pe = g(snap, "pe_current")
        pb = g(snap, "pb_current")
        pe5 = g(snap, "pe_5y_avg")
        pb5 = g(snap, "pb_5y_avg")
        roe = g(snap, "roe")
        roa = g(snap, "roa")
        pledge = g(snap, "promoter_pledging_pct")
        lq_np = g(snap, "latest_q_net_profit")
        ath_np = g(snap, "ath_q_net_profit")
        yoy_np = g(snap, "yoy_q_net_profit")
        prev_np = g(snap, "prev_q_net_profit")
        ttm_np = g(snap, "ttm_net_profit")
        gnpa = g(snap, "latest_q_gross_npa_pct")
        nnpa = g(snap, "latest_q_net_npa_pct")

        checks: List[Dict[str, Any]] = []
        # 1-3. Valuation (lenders trade on book; PE bar is tighter)
        self._check_pe(checks, "pe_lt_30", pe, t["pe_max"])
        self._check_pe_5yr(checks, pe, pe5)
        self._check_pb_5yr(checks, pb, pb5)
        # 4-5. Returns on equity and on the asset base
        self._check_min_pct(checks, "roe", "ROE", roe, t["roe_min"])
        self._check_min_pct(checks, "roa", "ROA", roa, t["roa_min"])
        # 6. Scale: trailing-twelve-month net profit floor
        np_min_abs = t["net_profit_ttm_min_cr"] * _CRORE
        np_label = f"Net Profit TTM > ₹{int(t['net_profit_ttm_min_cr']):,} Cr"
        if ttm_np is None:
            self._add(checks, "np_ttm", np_label, None,
                      "Fewer than four quarters of net profit stored")
        else:
            self._add(checks, "np_ttm", np_label, ttm_np > np_min_abs,
                      f"TTM net profit {_fmt_cr(ttm_np)}")
        # 7. Net Profit YoY (same quarter)
        self._check_np_yoy(checks, lq_np, yoy_np, prev_np, t["yoy_growth_min"])
        # 8. Net Profit near ATH
        self._check_ath(checks, "profit_ath", "Net Profit near ATH (≥90%)",
                        lq_np, ath_np, t["ath_tolerance"])
        # 9. Pledging
        self._check_max_pct(checks, "pledging", "Pledging", pledge, t["pledging_max"],
                            "Pledging data not available")
        # 10-11. Asset quality
        self._check_max_pct(checks, "gnpa", "Gross NPA", gnpa, t["gross_npa_max"],
                            "Gross NPA not printed on the latest quarter")
        self._check_max_pct(checks, "nnpa", "Net NPA", nnpa, t["net_npa_max"],
                            "Net NPA not printed on the latest quarter")
        return checks

    # ------------------------------------------------------------------
    def evaluate(self, snapshot: Dict[str, Any],
                 config: Dict[str, Any]) -> StrategyResult:
        symbol = snapshot.get("symbol", "?")
        cfg = (config or {}).get("thresholds") or {}
        group = resolve_group(snapshot.get("sector_group"))
        try:
            if group in LENDER_GROUPS:
                checks = self._checks_lender(snapshot, cfg, group)
            else:
                checks = self._checks_normal(snapshot, cfg)
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

        d = self._get_decimal
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
                "group": group,
                "checks": checks,
                "data": {
                    "current_pe": d(snapshot, "pe_current"),
                    "pe_5yr_avg": d(snapshot, "pe_5y_avg"),
                    "current_pb": d(snapshot, "pb_current"),
                    "pb_5yr_avg": d(snapshot, "pb_5y_avg"),
                    "roce": d(snapshot, "roce"),
                    "roe": d(snapshot, "roe"),
                    "roa": d(snapshot, "roa"),
                    "net_debt_to_equity": d(snapshot, "net_debt_to_equity"),
                    "pledging": d(snapshot, "promoter_pledging_pct"),
                    "promoter_holding": d(snapshot, "promoter_holding_pct"),
                    "latest_sales": d(snapshot, "latest_q_sales"),
                    "latest_pbt": d(snapshot, "latest_q_pbt"),
                    "latest_profit": d(snapshot, "latest_q_net_profit"),
                    "ath_sales": d(snapshot, "ath_q_sales"),
                    "ath_pbt": d(snapshot, "ath_q_pbt"),
                    "ath_profit": d(snapshot, "ath_q_net_profit"),
                    "yoy_profit": d(snapshot, "yoy_q_net_profit"),
                    "prev_profit": d(snapshot, "prev_q_net_profit"),
                    "yoy_quarter": snapshot.get("yoy_quarter_label"),
                    "ttm_profit": d(snapshot, "ttm_net_profit"),
                    "gross_npa": d(snapshot, "latest_q_gross_npa_pct"),
                    "net_npa": d(snapshot, "latest_q_net_npa_pct"),
                },
            },
        )
