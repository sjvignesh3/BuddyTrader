"""
Fundamental Screener Strategy — Plutus port of the essence of
backend/app/services/screener_engine.py.

The legacy screener runs many rules against Buddy's screener.in scraper.
Plutus's fundamentals tier is yfinance-based (Stage 5), so this strategy
only implements the rules whose inputs are already persisted in the
`fundamentals` and `daily_snapshots` tables:

  * pe_below_avg         : pe_current < pe_5y_avg
  * pb_below_avg         : pb_current < pb_5y_avg
  * roce_min             : roce >= min_roce
  * roe_min              : roe  >= min_roe
  * net_debt_to_equity   : net_debt_to_equity <= max_de
  * pledging_max         : promoter_pledging_pct <= max_pledge

Each rule contributes 1 point to the score. A stock PASSes only if every
enabled rule passes; missing inputs count as failures (safety-first, same
as the legacy engine).
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from plutus.registry.types import to_decimal
from plutus.scan.base import (
    STATUS_ERROR,
    STATUS_FAIL,
    STATUS_PASS,
    Strategy,
    StrategyResult,
)


DEFAULTS = {
    "pe_lookback_years": 5,
    "pb_lookback_years": 5,
    "roce_min": Decimal("18.0"),
    "roe_min": Decimal("18.0"),
    "net_debt_to_equity_max": Decimal("0.30"),
    "pledging_max": Decimal("5.0"),
}


class FundamentalScreenerStrategy(Strategy):
    """
    NB: This is the SNAPSHOT-time evaluator. The snapshot dict passed to
    `evaluate` must contain both daily_snapshots columns and the merged
    fundamentals-latest columns (the engine joins these before calling us).
    """

    @property
    def strategy_id(self) -> str:
        return "fundamental_screener"

    @property
    def strategy_name(self) -> str:
        return "Fundamental Screener"

    # -- individual rule evaluators ----------------------------------------
    def _rule_pe_below_avg(
        self, snap: Dict[str, Any], _cfg: Dict[str, Any]
    ) -> Tuple[bool, str, Dict[str, Any]]:
        pe = self._get_decimal(snap, "pe_current")
        pe_avg = self._get_decimal(snap, "pe_5y_avg")
        if pe is None:
            return False, "Current PE not available", {"pe_current": None, "pe_5y_avg": pe_avg}
        if pe_avg is None:
            return False, f"5yr avg PE not available (current PE: {pe})", {"pe_current": pe, "pe_5y_avg": None}
        passed = pe < pe_avg
        reason = f"Current PE {pe} vs 5yr Avg PE {pe_avg} — {'below' if passed else 'above'} average"
        return passed, reason, {"pe_current": pe, "pe_5y_avg": pe_avg}

    def _rule_pb_below_avg(
        self, snap: Dict[str, Any], _cfg: Dict[str, Any]
    ) -> Tuple[bool, str, Dict[str, Any]]:
        pb = self._get_decimal(snap, "pb_current")
        pb_avg = self._get_decimal(snap, "pb_5y_avg")
        if pb is None:
            return False, "Current PB not available", {"pb_current": None, "pb_5y_avg": pb_avg}
        if pb_avg is None:
            return False, f"5yr avg PB not available (current PB: {pb})", {"pb_current": pb, "pb_5y_avg": None}
        passed = pb < pb_avg
        reason = f"Current PB {pb} vs 5yr Avg PB {pb_avg} — {'below' if passed else 'above'} average"
        return passed, reason, {"pb_current": pb, "pb_5y_avg": pb_avg}

    def _rule_roce_min(
        self, snap: Dict[str, Any], cfg: Dict[str, Any]
    ) -> Tuple[bool, str, Dict[str, Any]]:
        roce = self._get_decimal(snap, "roce")
        threshold = to_decimal(cfg.get("roce_min")) or DEFAULTS["roce_min"]
        if roce is None:
            return False, "ROCE not available", {"roce": None, "threshold": threshold}
        passed = roce >= threshold
        reason = f"ROCE {roce}% vs threshold {threshold}%"
        return passed, reason, {"roce": roce, "threshold": threshold}

    def _rule_roe_min(
        self, snap: Dict[str, Any], cfg: Dict[str, Any]
    ) -> Tuple[bool, str, Dict[str, Any]]:
        roe = self._get_decimal(snap, "roe")
        threshold = to_decimal(cfg.get("roe_min")) or DEFAULTS["roe_min"]
        if roe is None:
            return False, "ROE not available", {"roe": None, "threshold": threshold}
        passed = roe >= threshold
        reason = f"ROE {roe}% vs threshold {threshold}%"
        return passed, reason, {"roe": roe, "threshold": threshold}

    def _rule_debt_to_equity(
        self, snap: Dict[str, Any], cfg: Dict[str, Any]
    ) -> Tuple[bool, str, Dict[str, Any]]:
        de = self._get_decimal(snap, "net_debt_to_equity")
        threshold = to_decimal(
            cfg.get("net_debt_to_equity_max")
        ) or DEFAULTS["net_debt_to_equity_max"]
        if de is None:
            return False, "Net Debt/Equity not available", {"net_debt_to_equity": None, "threshold": threshold}
        passed = de <= threshold
        reason = f"Net Debt/Equity {de} vs max {threshold}"
        return passed, reason, {"net_debt_to_equity": de, "threshold": threshold}

    def _rule_pledging_max(
        self, snap: Dict[str, Any], cfg: Dict[str, Any]
    ) -> Tuple[bool, str, Dict[str, Any]]:
        pledge = self._get_decimal(snap, "promoter_pledging_pct")
        threshold = to_decimal(cfg.get("pledging_max")) or DEFAULTS["pledging_max"]
        if pledge is None:
            return False, "Pledging data not found — treated as fail for safety", {"promoter_pledging_pct": None, "threshold": threshold}
        passed = pledge <= threshold
        reason = f"Promoter Pledging {pledge}% vs max {threshold}%"
        return passed, reason, {"promoter_pledging_pct": pledge, "threshold": threshold}

    # order determines the rule_id list in the result
    _RULES = [
        ("pe_below_avg",       "_rule_pe_below_avg"),
        ("pb_below_avg",       "_rule_pb_below_avg"),
        ("roce_min",           "_rule_roce_min"),
        ("roe_min",            "_rule_roe_min"),
        ("net_debt_to_equity", "_rule_debt_to_equity"),
        ("pledging_max",       "_rule_pledging_max"),
    ]

    def evaluate(self, snapshot: Dict[str, Any], config: Dict[str, Any]) -> StrategyResult:
        symbol = snapshot.get("symbol", "?")
        errors: List[str] = []

        # A per-rule enable map (default: all on).
        cfg = config or {}
        enabled_map: Dict[str, bool] = cfg.get("enabled_rules") or {}
        thresholds: Dict[str, Any] = cfg.get("thresholds") or {}

        rule_results: List[Dict[str, Any]] = []
        passed_count = 0
        failed_count = 0
        skipped_count = 0
        reasons: List[str] = []

        for rule_id, method_name in self._RULES:
            if not enabled_map.get(rule_id, True):
                rule_results.append({
                    "rule_id": rule_id, "enabled": False,
                    "passed": None, "reason": "disabled",
                })
                skipped_count += 1
                continue

            method = getattr(self, method_name)
            try:
                ok, reason, details = method(snapshot, thresholds)
            except TypeError as exc:
                # Bad snapshot type — surface as error and skip.
                errors.append(f"{rule_id}: {exc}")
                rule_results.append({
                    "rule_id": rule_id, "enabled": True,
                    "passed": None, "reason": str(exc),
                    "details": {},
                })
                skipped_count += 1
                continue

            rule_results.append({
                "rule_id": rule_id, "enabled": True,
                "passed": ok, "reason": reason, "details": details,
            })
            if ok:
                passed_count += 1
                reasons.append(f"[PASS] {reason}")
            else:
                failed_count += 1
                reasons.append(f"[FAIL] {reason}")

        # Overall verdict — same as legacy: pass only if every enabled rule passed.
        total_enabled = passed_count + failed_count
        if total_enabled == 0:
            # Every rule was disabled or errored — cannot judge.
            status = STATUS_ERROR
            score = 0
            reasons.insert(0, "No rules could be evaluated")
        elif failed_count == 0:
            status = STATUS_PASS
            score = passed_count
        else:
            status = STATUS_FAIL
            score = passed_count

        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.strategy_name,
            symbol=symbol,
            status=status,
            score=score,
            reasons=reasons,
            metrics_snapshot={
                "rule_results": rule_results,
                "passed_count": passed_count,
                "failed_count": failed_count,
                "skipped_count": skipped_count,
                "total_rules": len(self._RULES),
            },
            errors=errors,
        )
