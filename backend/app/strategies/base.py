"""
Base strategy interface - all strategies must implement this.
"""
from abc import ABC, abstractmethod
from typing import Dict, List, Optional


class BaseStrategy(ABC):
    """Abstract base class for all strategies."""

    @property
    @abstractmethod
    def strategy_id(self) -> str:
        """Unique identifier for the strategy."""
        pass

    @property
    @abstractmethod
    def strategy_name(self) -> str:
        """Human-readable name."""
        pass

    @abstractmethod
    def evaluate(self, metrics: Dict, config: Dict) -> Dict:
        """
        Evaluate a stock against this strategy.

        Args:
            metrics: Computed metrics dict for the stock
            config: Strategy configuration from strategy_rules.json

        Returns:
            Dict with: status, score, reasons, strategy_id, strategy_name, + any extra fields
        """
        pass

    @staticmethod
    def _compare(value: float, operator: str, threshold: float) -> bool:
        """Generic comparison helper."""
        if operator == ">=":
            return value >= threshold
        elif operator == "<=":
            return value <= threshold
        elif operator == ">":
            return value > threshold
        elif operator == "<":
            return value < threshold
        elif operator == "==":
            return value == threshold
        elif operator == "!=":
            return value != threshold
        return False
