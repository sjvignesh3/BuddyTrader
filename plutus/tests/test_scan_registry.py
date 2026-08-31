"""Registry lookup contract."""
from __future__ import annotations

import pytest

from plutus.scan.base import Strategy
from plutus.scan.registry import (
    all_strategies,
    get_strategy,
    list_strategy_ids,
)


class TestScanRegistry:
    def test_registered_ids(self):
        ids = list_strategy_ids()
        assert "envelope_200dma" in ids
        assert "week52_high_low" in ids
        assert "rally_20_percent" in ids
        assert "fundamental_screener" in ids

    def test_lookup_returns_singleton(self):
        s1 = get_strategy("envelope_200dma")
        s2 = get_strategy("envelope_200dma")
        assert s1 is s2

    def test_unknown_strategy_raises(self):
        with pytest.raises(KeyError, match="Unknown strategy"):
            get_strategy("does_not_exist")

    def test_every_strategy_inherits_base(self):
        for sid, strat in all_strategies().items():
            assert isinstance(strat, Strategy)
            assert strat.strategy_id == sid
            assert strat.strategy_name
