"""
Strategy Registry — the ONLY place that maps strategy_id -> Strategy instance.

Everything else (engine, CLI, API) looks up strategies through this module.
Adding a new strategy is a two-line change here.
"""
from __future__ import annotations

from typing import Dict, List

from plutus.scan.base import Strategy
from plutus.scan.strategies.envelope import EnvelopeStrategy
from plutus.scan.strategies.fundamental import FundamentalScreenerStrategy
from plutus.scan.strategies.rally import Rally20PercentStrategy
from plutus.scan.strategies.week52 import Week52HighLowStrategy


_REGISTRY: Dict[str, Strategy] = {
    "envelope_200dma":    EnvelopeStrategy(),
    "week52_high_low":    Week52HighLowStrategy(),
    "rally_20_percent":   Rally20PercentStrategy(),
    "fundamental_screener": FundamentalScreenerStrategy(),
}


def get_strategy(strategy_id: str) -> Strategy:
    """Return the singleton strategy instance for ``strategy_id``.

    Raises
    ------
    KeyError
        If the strategy is not registered.
    """
    try:
        return _REGISTRY[strategy_id]
    except KeyError as exc:
        raise KeyError(
            f"Unknown strategy '{strategy_id}'. Registered: {list_strategy_ids()}"
        ) from exc


def list_strategy_ids() -> List[str]:
    """Return every registered strategy id, in registration order."""
    return list(_REGISTRY.keys())


def all_strategies() -> Dict[str, Strategy]:
    """Return the full registry (copy)."""
    return dict(_REGISTRY)
