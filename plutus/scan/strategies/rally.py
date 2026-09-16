"""
20% Rally Strategy — bit-for-bit port of the legacy Buddy
rally_20_percent strategy.

The heavy lifting (streak detection, pivot picking) is done upstream in
metrics/rally.py and persisted on the daily_snapshots row. This strategy
simply consumes the boolean gate and enriches with the metrics that the
frontend needs for the expanded row.

Rules:
  VALID   : has_valid_20pct_rally == True  -> Score 100
  INVALID : has_valid_20pct_rally == False -> Score 0
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict

from plutus.scan.base import dec_or_default
from plutus.scan.base import (
    STATUS_ERROR,
    STATUS_INVALID,
    STATUS_VALID,
    Strategy,
    StrategyResult,
)

DEFAULT_THRESHOLD_PCT = Decimal("20.0")
DEFAULT_WINDOW_DAYS = 189
DEFAULT_SCORE_MAP = {STATUS_VALID: 100, STATUS_INVALID: 0}


class Rally20PercentStrategy(Strategy):

    @property
    def strategy_id(self) -> str:
        return "rally_20_percent"

    @property
    def strategy_name(self) -> str:
        return "20% Rally"

    def evaluate(self, snapshot: Dict[str, Any], config: Dict[str, Any]) -> StrategyResult:
        symbol = snapshot.get("symbol", "?")
        errors: list[str] = []

        # Rally block is optional on the snapshot — if the metrics pipeline
        # could not build it (e.g. short history), we return INVALID with a
        # clean note rather than an error.
        try:
            has_valid = self._get_bool(snapshot, "has_valid_20pct_rally", False)
            rally_pct = self._get_decimal(snapshot, "last_rally_pct")
            rally_low = self._get_decimal(snapshot, "last_rally_low")
            rally_high = self._get_decimal(snapshot, "last_rally_high")
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

        rally_start = snapshot.get("last_rally_start_date")
        rally_end = snapshot.get("last_rally_end_date")
        days_since = snapshot.get("days_since_last_rally")

        inputs = (config or {}).get("inputs", {}) or {}
        threshold = dec_or_default(
            inputs.get("movement_threshold_pct"), DEFAULT_THRESHOLD_PCT)
        window_days = int(
            inputs.get("validity_window_days", DEFAULT_WINDOW_DAYS)
        )
        score_map = (config or {}).get("score_map") or DEFAULT_SCORE_MAP

        if has_valid:
            status = STATUS_VALID
            reasons = [
                f"Qualifying rally found in the last ~{window_days} trading days",
            ]
            if rally_pct is not None:
                reasons.append(
                    f"Most recent: {rally_pct:.1f}% move (threshold: {threshold}%)"
                )
            if rally_low is not None and rally_high is not None:
                reasons.append(
                    f"Streak range: {rally_low} -> {rally_high}"
                )
            if rally_start and rally_end:
                reasons.append(f"Streak dates: {rally_start} -> {rally_end}")
            if days_since is not None:
                reasons.append(f"Days since streak closed: {days_since} trading days")
        else:
            status = STATUS_INVALID
            reasons = [
                f"No completed green streak reached {threshold}% rally "
                f"within the last ~{window_days} trading days",
            ]
            if rally_pct is not None and rally_pct > 0:
                reasons.append(
                    f"Last found rally was {rally_pct:.1f}% but occurred "
                    f"outside the validity window"
                )

        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.strategy_name,
            symbol=symbol,
            status=status,
            score=self._score_from_map(score_map, status),
            reasons=reasons,
            metrics_snapshot={
                "has_valid_20pct_rally": has_valid,
                "last_rally_pct": rally_pct,
                "last_rally_low": rally_low,
                "last_rally_high": rally_high,
                "last_rally_start_date": rally_start,
                "last_rally_end_date": rally_end,
                "days_since_last_rally": days_since,
                "threshold_movement_pct": threshold,
                "validity_window_days": window_days,
            },
            errors=errors,
        )
