"""
Strategy registry - maps strategy IDs to strategy classes.
New strategies are registered here. Adding a new strategy requires:
1. Create a new strategy file in strategies/
2. Register it in STRATEGY_REGISTRY below
"""
from typing import Dict
from .base import BaseStrategy
from .envelope import EnvelopeStrategy
from .week52_high_low import Week52HighLowStrategy
from .rally_20_percent import Rally20PercentStrategy

# Registry: strategy_id -> strategy instance
STRATEGY_REGISTRY: Dict[str, BaseStrategy] = {
    "envelope_200dma": EnvelopeStrategy(),
    "week52_high_low": Week52HighLowStrategy(),
    "rally_20_percent": Rally20PercentStrategy(),
}


def get_strategy(strategy_id: str) -> BaseStrategy:
    """Get a strategy by its ID."""
    if strategy_id not in STRATEGY_REGISTRY:
        raise ValueError(f"Unknown strategy: {strategy_id}. Available: {list(STRATEGY_REGISTRY.keys())}")
    return STRATEGY_REGISTRY[strategy_id]


def get_all_strategies() -> Dict[str, BaseStrategy]:
    """Get all registered strategies."""
    return STRATEGY_REGISTRY
