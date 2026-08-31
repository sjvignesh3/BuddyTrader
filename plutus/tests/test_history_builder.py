"""Unit tests for plutus.sync.history_builder — no yfinance import needed."""
from __future__ import annotations

import math
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from plutus.sync.history_builder import bars_from_df, extract_meta


# ---------------------------------------------------------------------------
# A tiny in-memory DataFrame stand-in — enough duck-typing for bars_from_df.
# ---------------------------------------------------------------------------
class _FakeIndex:
    def __init__(self, values):
        self._values = list(values)


class _FakeRow(dict):
    """dict with __getitem__ + .get already; nothing extra needed."""


class _FakeDF:
    def __init__(self, rows, columns=("Open", "High", "Low", "Close")):
        self._rows = list(rows)   # list of (index, dict)
        self.columns = list(columns)

    def __len__(self):
        return len(self._rows)

    def sort_index(self):
        self._rows.sort(key=lambda pair: pair[0])
        return self

    def iterrows(self):
        for idx, r in self._rows:
            yield idx, _FakeRow(r)


def _bar(d, o, h, l, c):
    return (d, {"Open": o, "High": h, "Low": l, "Close": c})


class TestBarsFromDf:
    def test_happy_path(self) -> None:
        df = _FakeDF([
            _bar(date(2024, 1, 1), 100, 105, 99, 104),
            _bar(date(2024, 1, 2), 104, 108, 103, 107),
        ])
        bars = bars_from_df(df)
        assert len(bars) == 2
        assert bars[0].d == date(2024, 1, 1)
        assert bars[0].close == Decimal("104")
        assert bars[1].high == Decimal("108")

    def test_none_input(self) -> None:
        assert bars_from_df(None) == []

    def test_empty_df(self) -> None:
        assert bars_from_df(_FakeDF([])) == []

    def test_missing_column_returns_empty(self) -> None:
        df = _FakeDF([_bar(date(2024, 1, 1), 100, 105, 99, 104)],
                     columns=("Open", "High", "Close"))  # missing Low
        assert bars_from_df(df) == []

    def test_nan_rows_dropped(self) -> None:
        nan = float("nan")
        df = _FakeDF([
            _bar(date(2024, 1, 1), 100, 105, 99, 104),
            _bar(date(2024, 1, 2), nan, 108, 103, 107),   # bad row
            _bar(date(2024, 1, 3), 107, 110, 106, 109),
        ])
        bars = bars_from_df(df)
        assert [b.d.day for b in bars] == [1, 3]

    def test_unsorted_index_gets_sorted(self) -> None:
        df = _FakeDF([
            _bar(date(2024, 1, 3), 107, 110, 106, 109),
            _bar(date(2024, 1, 1), 100, 105, 99, 104),
            _bar(date(2024, 1, 2), 104, 108, 103, 107),
        ])
        bars = bars_from_df(df)
        assert [b.d.day for b in bars] == [1, 2, 3]

    def test_pandas_timestamp_index_coerced(self) -> None:
        # duck-typed Timestamp: has a .date() method
        class TS:
            def __init__(self, y, m, d):
                self._d = date(y, m, d)

            def date(self):
                return self._d

        df = _FakeDF([
            (TS(2024, 3, 15), {"Open": 100, "High": 105, "Low": 99, "Close": 104}),
        ])
        bars = bars_from_df(df)
        assert bars[0].d == date(2024, 3, 15)


class TestExtractMeta:
    def test_all_keys_present(self) -> None:
        info = {
            "regularMarketPrice": 2500.5,
            "fiftyTwoWeekHigh": 3000.0,
            "fiftyTwoWeekLow": 1900.0,
        }
        meta = extract_meta(info)
        assert meta["regularMarketPrice"] == Decimal("2500.5")
        assert meta["fiftyTwoWeekHigh"] == Decimal("3000")
        assert meta["fiftyTwoWeekLow"] == Decimal("1900")

    def test_price_fallback_chain(self) -> None:
        info = {"regularMarketPrice": None, "currentPrice": 1500}
        assert extract_meta(info)["regularMarketPrice"] == Decimal("1500")

    def test_none_and_empty(self) -> None:
        assert extract_meta(None) == {}
        assert extract_meta({}) == {}

    def test_zero_price_rejected(self) -> None:
        info = {"regularMarketPrice": 0, "currentPrice": 42}
        assert extract_meta(info)["regularMarketPrice"] == Decimal("42")

    def test_nan_ignored(self) -> None:
        info = {"regularMarketPrice": float("nan"), "previousClose": 10}
        assert extract_meta(info)["regularMarketPrice"] == Decimal("10")
