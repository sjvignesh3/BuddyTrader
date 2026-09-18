"""Unit tests for plutus.sync.history_builder — no yfinance import needed."""
from __future__ import annotations

import math
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from plutus.sync.history_builder import (
    bars_from_df,
    extract_meta,
    merge_quote_bar,
    quote_bar,
    quote_session_date,
)


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


# ---------------------------------------------------------------------------
# quote_bar / merge_quote_bar
# ---------------------------------------------------------------------------
def _epoch_ist(y, m, d, hh=15, mm=29):
    from datetime import datetime, timedelta, timezone
    ist = timezone(timedelta(hours=5, minutes=30))
    return int(datetime(y, m, d, hh, mm, tzinfo=ist).timestamp())


def _quote(state="CLOSED", **over):
    info = {
        "marketState": state,
        "regularMarketTime": _epoch_ist(2026, 9, 17),
        "regularMarketPrice": 1553.0,
        "regularMarketOpen": 1499.9,
        "regularMarketDayHigh": 1558.0,
        "regularMarketDayLow": 1492.0,
        "regularMarketVolume": 517409,
    }
    info.update(over)
    return info


class TestQuoteBar:
    def test_settled_quote_becomes_a_decimal_bar(self) -> None:
        b = quote_bar(_quote(), today=date(2026, 9, 18))
        assert b is not None
        assert b.d == date(2026, 9, 17)
        assert (b.open, b.high, b.low, b.close) == (
            Decimal("1499.9"), Decimal("1558.0"), Decimal("1492.0"), Decimal("1553.0"))
        assert b.adj_close == b.close
        assert b.volume == 517409

    def test_session_date_is_ist_calendar_day(self) -> None:
        # 15:29 IST on Sep 17 is 09:59 UTC — the IST date must win.
        assert quote_session_date(_quote()) == date(2026, 9, 17)
        # Just after midnight IST is still the previous day in UTC.
        assert quote_session_date(
            {"regularMarketTime": _epoch_ist(2026, 9, 18, 0, 5)}) == date(2026, 9, 18)

    @pytest.mark.parametrize("state", ["PREPRE", "PRE", "POST", "CLOSED", ""])
    def test_pre_and_post_market_quotes_for_yesterday_are_accepted(self, state) -> None:
        assert quote_bar(_quote(state), today=date(2026, 9, 18)) is not None

    def test_regular_session_quote_is_rejected(self) -> None:
        # Live session: history already carries today's bar.
        assert quote_bar(_quote("REGULAR"), today=date(2026, 9, 17)) is None

    def test_pre_open_quote_already_dated_today_is_rejected(self) -> None:
        # Pre-open indicative price for TODAY is not a settled close.
        assert quote_bar(_quote("PRE"), today=date(2026, 9, 17)) is None
        assert quote_bar(_quote("PREPRE"), today=date(2026, 9, 17)) is None

    def test_missing_time_or_price_returns_none(self) -> None:
        assert quote_bar(_quote(regularMarketTime=None)) is None
        assert quote_bar(_quote(regularMarketPrice=0)) is None
        assert quote_bar(_quote(regularMarketPrice=float("nan"))) is None
        assert quote_bar({}) is None
        assert quote_bar(None) is None

    def test_missing_ohl_fall_back_to_price(self) -> None:
        b = quote_bar(_quote(regularMarketOpen=None, regularMarketDayHigh=None,
                             regularMarketDayLow=None, regularMarketVolume=None),
                      today=date(2026, 9, 18))
        assert (b.open, b.high, b.low, b.close) == (b.close,) * 4
        assert b.volume is None

    def test_high_low_widened_to_contain_open_and_close(self) -> None:
        b = quote_bar(_quote(regularMarketDayHigh=1500.0, regularMarketDayLow=1520.0),
                      today=date(2026, 9, 18))
        assert b.high == Decimal("1553.0")
        assert b.low == Decimal("1499.9")


class TestMergeQuoteBar:
    def _bars(self):
        return bars_from_df(_FakeDF([
            _bar(date(2026, 9, 15), 100, 105, 99, 104),
            _bar(date(2026, 9, 16), 104, 108, 103, 107),
        ]))

    def test_newer_quote_is_appended(self) -> None:
        q = quote_bar(_quote(), today=date(2026, 9, 18))
        bars, appended = merge_quote_bar(self._bars(), q)
        assert appended is True
        assert [b.d for b in bars] == [date(2026, 9, 15), date(2026, 9, 16), date(2026, 9, 17)]

    def test_same_date_history_bar_wins(self) -> None:
        q = quote_bar(_quote(regularMarketTime=_epoch_ist(2026, 9, 16)),
                      today=date(2026, 9, 18))
        bars, appended = merge_quote_bar(self._bars(), q)
        assert appended is False
        assert bars[-1].close == Decimal("107")

    def test_older_quote_is_ignored(self) -> None:
        q = quote_bar(_quote(regularMarketTime=_epoch_ist(2026, 9, 10)),
                      today=date(2026, 9, 18))
        bars, appended = merge_quote_bar(self._bars(), q)
        assert appended is False and len(bars) == 2

    def test_none_quote_is_a_no_op(self) -> None:
        bars, appended = merge_quote_bar(self._bars(), None)
        assert appended is False and len(bars) == 2

    def test_empty_history_takes_the_quote(self) -> None:
        q = quote_bar(_quote(), today=date(2026, 9, 18))
        bars, appended = merge_quote_bar([], q)
        assert appended is True and bars == [q]


class TestExtractMetaSessionKeys:
    def test_market_state_and_quote_date_lifted(self) -> None:
        m = extract_meta(_quote("PREPRE"))
        assert m["marketState"] == "PREPRE"
        assert m["quoteSessionDate"] == date(2026, 9, 17)
        assert m["regularMarketPrice"] == Decimal("1553.0")

    def test_absent_keys_are_omitted(self) -> None:
        m = extract_meta({"regularMarketPrice": 10.0})
        assert "marketState" not in m and "quoteSessionDate" not in m
