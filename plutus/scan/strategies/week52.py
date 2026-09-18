"""
52 Week High Low Strategy — bit-for-bit port of the legacy Buddy
week52_high_low strategy.

Rules (defaults seeded by migrations/005_strategy_configs.sql):
  BUY_ZONE     : distance_from_52w_low_pct <= 0.5  -> Score 100
  OPPORTUNITY  : distance_from_52w_low_pct <= 5.0  -> Score 75
  NO_SIGNAL    : distance_from_52w_low_pct >  5.0  -> Score 0
  NO_SIGNAL    : distance_from_52w_low_pct missing -> Score 0 (no usable
                 close / 52W low for the session; not an error)

All comparisons use Decimal.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict

from plutus.scan.base import dec_or_default
from plutus.scan.base import (
    STATUS_BUY_ZONE,
    STATUS_ERROR,
    STATUS_NO_SIGNAL,
    STATUS_OPPORTUNITY,
    Strategy,
    StrategyResult,
)

DEFAULT_BUY_ZONE_TOL_PCT = Decimal("0.5")
DEFAULT_OPPORTUNITY_ABOVE_LOW_PCT = Decimal("5.0")
DEFAULT_SCORE_MAP = {
    STATUS_BUY_ZONE: 100,
    STATUS_OPPORTUNITY: 75,
    STATUS_NO_SIGNAL: 0,
}


class Week52HighLowStrategy(Strategy):

    @property
    def strategy_id(self) -> str:
        return "week52_high_low"

    @property
    def strategy_name(self) -> str:
        return "52 Week High Low"

    def evaluate(self, snapshot: Dict[str, Any], config: Dict[str, Any]) -> StrategyResult:
        symbol = snapshot.get("symbol", "?")
        errors: list[str] = []

        try:
            dist_from_low = self._get_decimal(snapshot, "distance_from_52w_low_pct")
            dist_from_high = self._get_decimal(snapshot, "distance_from_52w_high_pct")
            low_52w = self._get_decimal(snapshot, "low_52w")
            high_52w = self._get_decimal(snapshot, "high_52w")
            close = self._get_decimal(snapshot, "close")
        except TypeError as exc:
            return StrategyResult(
                strategy_id=self.strategy_id,
                strategy_name=self.strategy_name,
                symbol=symbol,
                status=STATUS_ERROR,
                score=0,
                reasons=[str(exc)],
                errors=[str(exc)],
            )

        if dist_from_low is None:
            # Missing input is a data gap for this session, not an
            # evaluation failure — report NO_SIGNAL with the reason so the
            # scan workflow stays green for the other symbols.
            return StrategyResult(
                strategy_id=self.strategy_id,
                strategy_name=self.strategy_name,
                symbol=symbol,
                status=STATUS_NO_SIGNAL,
                score=0,
                reasons=["52W low distance unavailable — no usable close / "
                         "52W low for this session; not evaluated"],
                metrics_snapshot={
                    "distance_from_52w_low_pct": None,
                    "distance_from_52w_high_pct": dist_from_high,
                    "low_52w": low_52w,
                    "high_52w": high_52w,
                    "close": close,
                },
                errors=errors,
            )

        inputs = (config or {}).get("inputs", {}) or {}
        buy_zone_tolerance = dec_or_default(
            inputs.get("buy_zone_tolerance_pct"), DEFAULT_BUY_ZONE_TOL_PCT)
        opportunity_above_low = dec_or_default(
            inputs.get("opportunity_above_52w_low_pct"), DEFAULT_OPPORTUNITY_ABOVE_LOW_PCT)
        score_map = (config or {}).get("score_map") or DEFAULT_SCORE_MAP

        if dist_from_low <= buy_zone_tolerance:
            status = STATUS_BUY_ZONE
            reasons = [
                f"Price is at 52-week low (only {dist_from_low:.1f}% above, "
                f"tolerance: {buy_zone_tolerance}%)"
            ]
        elif dist_from_low <= opportunity_above_low:
            status = STATUS_OPPORTUNITY
            reasons = [
                f"Price is {dist_from_low:.1f}% above 52-week low "
                f"(within {opportunity_above_low}% threshold)"
            ]
        else:
            status = STATUS_NO_SIGNAL
            reasons = [
                f"Price is {dist_from_low:.1f}% above 52-week low "
                f"(need within {opportunity_above_low}%)"
            ]

        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.strategy_name,
            symbol=symbol,
            status=status,
            score=self._score_from_map(score_map, status),
            reasons=reasons,
            metrics_snapshot={
                "distance_from_52w_low_pct": dist_from_low,
                "distance_from_52w_high_pct": dist_from_high,
                "low_52w": low_52w,
                "high_52w": high_52w,
                "close": close,
                "threshold_buy_zone_tolerance_pct": buy_zone_tolerance,
                "threshold_opportunity_above_low_pct": opportunity_above_low,
            },
            errors=errors,
        )
