"""
52 Week High Low Strategy - proximity to 52-week low detection.

Rules from strategy_rules.json:
- BUY_ZONE:    distance_from_52w_low_pct <= 0.5  → Score 100
- OPPORTUNITY: distance_from_52w_low_pct <= 5.0  → Score 75
- NO_SIGNAL:   distance_from_52w_low_pct > 5.0   → Score 0
"""
from typing import Dict
from .base import BaseStrategy


class Week52HighLowStrategy(BaseStrategy):

    @property
    def strategy_id(self) -> str:
        return "week52_high_low"

    @property
    def strategy_name(self) -> str:
        return "52 Week High Low"

    def evaluate(self, metrics: Dict, config: Dict) -> Dict:
        """
        Evaluate 52 Week High Low strategy for a stock.

        Checks how close the current price is to the 52-week low.
        The closer to the low, the better the opportunity.
        """
        dist_from_low = metrics.get("distance_from_52w_low_pct", 100)

        # Read thresholds from config
        buy_zone_tolerance = config.get("inputs", {}).get("buy_zone_tolerance_pct", 0.5)
        opportunity_above_low = config.get("inputs", {}).get("opportunity_above_52w_low_pct", 5.0)

        # Score map from config
        score_map = config.get("score_map", {
            "BUY_ZONE": 100,
            "OPPORTUNITY": 75,
            "NO_SIGNAL": 0
        })

        # Evaluate status
        if dist_from_low <= buy_zone_tolerance:
            status = "BUY_ZONE"
            reasons = [f"Price is at 52-week low (only {dist_from_low:.1f}% above, tolerance: {buy_zone_tolerance}%)"]
        elif dist_from_low <= opportunity_above_low:
            status = "OPPORTUNITY"
            reasons = [f"Price is {dist_from_low:.1f}% above 52-week low (within {opportunity_above_low}% threshold)"]
        else:
            status = "NO_SIGNAL"
            reasons = [f"Price is {dist_from_low:.1f}% above 52-week low (need within {opportunity_above_low}%)"]

        score = score_map.get(status, 0)

        return {
            "strategy_id": self.strategy_id,
            "strategy_name": self.strategy_name,
            "status": status,
            "score": score,
            "reasons": reasons,
            "distance_from_52w_low_pct": dist_from_low,
            "distance_from_52w_high_pct": metrics.get("distance_from_52w_high_pct", 0),
            "low_52w": metrics.get("low_52w", 0),
            "high_52w": metrics.get("high_52w", 0),
            "close": metrics.get("close", 0),
        }
