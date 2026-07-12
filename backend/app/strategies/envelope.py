"""
Envelope Strategy - 200 DMA based buy zone detection.

Rules from strategy_rules.json:
- BUY_ZONE:    below_200dma_pct >= 14.0  → Score 100
- OPPORTUNITY: below_200dma_pct >= 9.0   → Score 70
- NO_SIGNAL:   below_200dma_pct < 9.0    → Score 0
"""
from typing import Dict
from .base import BaseStrategy


class EnvelopeStrategy(BaseStrategy):

    @property
    def strategy_id(self) -> str:
        return "envelope_200dma"

    @property
    def strategy_name(self) -> str:
        return "Envelope"

    def evaluate(self, metrics: Dict, config: Dict) -> Dict:
        """
        Evaluate Envelope strategy for a stock.

        The envelope checks how far below the 200 DMA the current price is.
        The deeper the fall below DMA, the better the opportunity.
        """
        below_dma_pct = metrics.get("below_200dma_pct", 0)

        # Read thresholds from config (with defaults from strategy_rules.json)
        buy_zone_pct = config.get("inputs", {}).get("buy_zone_below_dma_pct", 14.0)
        opportunity_pct = config.get("inputs", {}).get("opportunity_below_dma_pct", 9.0)

        # Score map from config
        score_map = config.get("score_map", {
            "BUY_ZONE": 100,
            "OPPORTUNITY": 70,
            "NO_SIGNAL": 0
        })

        # Evaluate status
        if below_dma_pct >= buy_zone_pct:
            status = "BUY_ZONE"
            reasons = [f"Price is {below_dma_pct:.1f}% below 200 DMA (threshold: {buy_zone_pct}%)"]
        elif below_dma_pct >= opportunity_pct:
            status = "OPPORTUNITY"
            reasons = [f"Price is {below_dma_pct:.1f}% below 200 DMA; suitable for GTT watch (threshold: {opportunity_pct}%)"]
        else:
            status = "NO_SIGNAL"
            reasons = [f"Price is only {below_dma_pct:.1f}% below 200 DMA (need {opportunity_pct}%+)"]

        score = score_map.get(status, 0)

        return {
            "strategy_id": self.strategy_id,
            "strategy_name": self.strategy_name,
            "status": status,
            "score": score,
            "reasons": reasons,
            "below_200dma_pct": below_dma_pct,
            "dma_200": metrics.get("dma_200", 0),
            "close": metrics.get("close", 0),
        }
