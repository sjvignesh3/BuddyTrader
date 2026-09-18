"""
Envelope Strategy — bit-for-bit port of the legacy Buddy envelope strategy.

Rules (defaults seeded by migrations/005_strategy_configs.sql):
  BUY_ZONE     : below_200dma_pct >= 14.0  -> Score 100
  OPPORTUNITY  : below_200dma_pct >= 9.0   -> Score 70
  NO_SIGNAL    : below_200dma_pct <  9.0   -> Score 0
  NO_SIGNAL    : below_200dma_pct missing  -> Score 0  (fewer than 200
                 sessions of history — a recent listing; not an error)

All comparisons use Decimal — no float() calls anywhere.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict

from plutus.scan.base import (
    STATUS_BUY_ZONE,
    STATUS_ERROR,
    STATUS_NO_SIGNAL,
    STATUS_OPPORTUNITY,
    Strategy,
    StrategyResult,
    dec_or_default,
)


DEFAULT_BUY_ZONE_PCT = Decimal("14.0")
DEFAULT_OPPORTUNITY_PCT = Decimal("9.0")
DEFAULT_SCORE_MAP = {
    STATUS_BUY_ZONE: 100,
    STATUS_OPPORTUNITY: 70,
    STATUS_NO_SIGNAL: 0,
}


class EnvelopeStrategy(Strategy):

    @property
    def strategy_id(self) -> str:
        return "envelope_200dma"

    @property
    def strategy_name(self) -> str:
        return "Envelope"

    def evaluate(self, snapshot: Dict[str, Any], config: Dict[str, Any]) -> StrategyResult:
        symbol = snapshot.get("symbol", "?")
        errors: list[str] = []

        # -- extract inputs --------------------------------------------------
        try:
            below_dma_pct = self._get_decimal(snapshot, "below_200dma_pct")
            dma_200 = self._get_decimal(snapshot, "dma_200")
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

        if below_dma_pct is None:
            # No 200-DMA yet (fewer than 200 sessions — a recent listing) is
            # a legitimate "nothing to say", not an evaluation failure; an
            # ERROR here used to fail the whole scan workflow for one IPO.
            return StrategyResult(
                strategy_id=self.strategy_id,
                strategy_name=self.strategy_name,
                symbol=symbol,
                status=STATUS_NO_SIGNAL,
                score=0,
                reasons=["200 DMA unavailable — fewer than 200 sessions of "
                         "history; envelope not evaluated"],
                metrics_snapshot={
                    "below_200dma_pct": None,
                    "dma_200": dma_200,
                    "close": close,
                },
                errors=errors,
            )

        # -- resolve thresholds ---------------------------------------------
        inputs = (config or {}).get("inputs", {}) or {}
        buy_zone_pct = dec_or_default(
            inputs.get("buy_zone_below_dma_pct"), DEFAULT_BUY_ZONE_PCT)
        opportunity_pct = dec_or_default(
            inputs.get("opportunity_below_dma_pct"), DEFAULT_OPPORTUNITY_PCT)
        score_map = (config or {}).get("score_map") or DEFAULT_SCORE_MAP

        # -- decision -------------------------------------------------------
        if below_dma_pct >= buy_zone_pct:
            status = STATUS_BUY_ZONE
            reasons = [
                f"Price is {below_dma_pct:.1f}% below 200 DMA "
                f"(threshold: {buy_zone_pct}%)"
            ]
        elif below_dma_pct >= opportunity_pct:
            status = STATUS_OPPORTUNITY
            reasons = [
                f"Price is {below_dma_pct:.1f}% below 200 DMA; "
                f"suitable for GTT watch (threshold: {opportunity_pct}%)"
            ]
        else:
            status = STATUS_NO_SIGNAL
            reasons = [
                f"Price is only {below_dma_pct:.1f}% below 200 DMA "
                f"(need {opportunity_pct}%+)"
            ]

        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.strategy_name,
            symbol=symbol,
            status=status,
            score=self._score_from_map(score_map, status),
            reasons=reasons,
            metrics_snapshot={
                "below_200dma_pct": below_dma_pct,
                "dma_200": dma_200,
                "close": close,
                "threshold_buy_zone_pct": buy_zone_pct,
                "threshold_opportunity_pct": opportunity_pct,
            },
            errors=errors,
        )
