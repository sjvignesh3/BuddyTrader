"""
20% Rally Strategy — Python translation of the V20 Pine Script.

PINE SCRIPT LOGIC (translated):
  1. A "green candle" is any candle where close > open.
  2. Track consecutive green candle streaks.
  3. Within each streak, record the lowest Low and highest High.
  4. When the streak is BROKEN by a red/doji candle:
       - Compute rally% = ((highest_high - lowest_low) / lowest_low) * 100
       - If rally% >= 20 → this is a valid 20% rally event.
       - Record the streak end date (last green candle date).
  5. Validity window: the streak must have ENDED within the last N trading days
     (configurable, default 189 ≈ 9 months as per user requirement).
  6. Signal: find the MOST RECENT valid rally within the window.
       - VALID   → has a qualifying rally → Score 100
       - INVALID → no qualifying rally     → Score 0

KEY OUTPUTS (exposed in expanded row):
  - last_rally_pct         : % move of the most recent valid rally
  - last_rally_low         : lowest low price during the streak
  - last_rally_high        : highest high price during the streak
  - last_rally_start_date  : first green candle of the streak
  - last_rally_end_date    : last green candle of the streak (streak closed date)
  - days_since_rally       : trading days from streak end to today
  - next_buy_at            : lowestPrice of last valid streak (Pine: "Next Buy at")
  - next_sell_at           : highestPrice of last valid streak (Pine: "Next Sell at")
  - total_valid_rallies    : count of qualifying rallies in the window

NOTE on "streak closed":
  Pine script fires the label WHEN the first red/doji candle appears after the
  streak — i.e., the streak is "completed" only when it breaks. We replicate
  this exactly: streaks still in progress at the end of the data window are
  NOT counted (they may not reach 20%).
"""
from typing import Dict
from .base import BaseStrategy


class Rally20PercentStrategy(BaseStrategy):

    @property
    def strategy_id(self) -> str:
        return "rally_20_percent"

    @property
    def strategy_name(self) -> str:
        return "20% Rally"

    def evaluate(self, metrics: Dict, config: Dict) -> Dict:
        """
        Evaluate the 20% rally pattern for a stock.

        Expects metrics to already contain pre-computed rally fields
        (added by metrics_engine.compute_rally_metrics).

        Args:
            metrics : dict from metrics_engine — includes rally_ prefixed keys
            config  : strategy config block from strategy_rules.json

        Returns:
            Standard strategy result dict.
        """
        # ── Pull pre-computed rally fields ──────────────────────────────────
        has_valid_rally    = metrics.get("has_valid_20pct_rally", False)
        rally_pct          = metrics.get("last_rally_pct", 0.0)
        rally_low          = metrics.get("last_rally_low", 0.0)
        rally_high         = metrics.get("last_rally_high", 0.0)
        rally_start        = metrics.get("last_rally_start_date", None)
        rally_end          = metrics.get("last_rally_end_date", None)
        days_since         = metrics.get("days_since_last_rally", None)
        total_valid        = metrics.get("total_valid_rallies_in_window", 0)
        threshold          = config.get("inputs", {}).get("movement_threshold_pct", 20.0)
        window_days        = config.get("inputs", {}).get("validity_window_days", 189)

        # ── Score map ───────────────────────────────────────────────────────
        score_map = config.get("score_map", {"VALID": 100, "INVALID": 0})

        # ── Status determination ─────────────────────────────────────────────
        if has_valid_rally:
            status = "VALID"
            reasons = [
                f"✅ {total_valid} qualifying rally(s) found in the last ~{window_days} trading days",
                f"Most recent: {rally_pct:.1f}% move (threshold: {threshold}%)",
                f"Streak range: ₹{rally_low:.2f} → ₹{rally_high:.2f}",
            ]
            if rally_start and rally_end:
                reasons.append(f"Streak dates: {rally_start} → {rally_end}")
            if days_since is not None:
                reasons.append(f"Days since streak closed: {days_since} trading days")
        else:
            status = "INVALID"
            reasons = [
                f"❌ No completed green streak reached {threshold}% rally within the last ~{window_days} trading days",
            ]
            if rally_pct > 0:
                # There was a rally but outside the window
                reasons.append(
                    f"Last found rally was {rally_pct:.1f}% but occurred outside the validity window"
                )

        score = score_map.get(status, 0)

        return {
            "strategy_id":   self.strategy_id,
            "strategy_name": self.strategy_name,
            "status":        status,
            "score":         score,
            "reasons":       reasons,
            # Rally-specific fields for the expanded details panel
            "has_valid_rally":            has_valid_rally,
            "last_rally_pct":             round(rally_pct, 2),
            "last_rally_low":             round(rally_low, 2),
            "last_rally_high":            round(rally_high, 2),
            "last_rally_start_date":      rally_start,
            "last_rally_end_date":        rally_end,
            "days_since_last_rally":      days_since,
            "total_valid_rallies":        total_valid,
            "next_buy_at":                round(rally_low, 2),   # Pine: "Next Buy at"
            "next_sell_at":               round(rally_high, 2),  # Pine: "Next Sell at"
            "close":                      metrics.get("close", 0),
        }
