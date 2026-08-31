"""Unit tests for plutus.fundamentals.quarterly extractors."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Dict, List

import pytest

from plutus.fundamentals.quarterly import (
    compute_pb_5yr_avg,
    compute_pe_5yr_avg,
    extract_holdings,
    extract_quarterly_rows,
)


# ---------------------------------------------------------------------------
# Duck-typed DataFrame stand-ins
# ---------------------------------------------------------------------------
class _FakeQF:
    """
    Mimics yfinance.quarterly_financials:
        columns = quarter-end dates
        rows    = line item labels
        at[row, col] returns the cell value
    """
    def __init__(self, data: Dict[str, Dict[Any, Any]], columns: List[Any]):
        # data: { line_item: { col: value } }
        self._data = data
        self.columns = list(columns)

    class _AtAccessor:
        def __init__(self, data): self._d = data

        def __getitem__(self, key):
            row, col = key
            return self._d[row][col]

    @property
    def at(self):
        return _FakeQF._AtAccessor(self._data)

    class _Loc:
        def __init__(self, data): self._d = data
        def __getitem__(self, row):
            r = self._d.get(row)
            if r is None:
                raise KeyError(row)
            return r
    @property
    def loc(self):
        return _FakeQF._Loc(self._data)


class _FakeHolders:
    """Mimics yfinance.major_holders as an iterable of (value, label) rows."""
    def __init__(self, rows):
        self._rows = rows

    def iterrows(self):
        for i, r in enumerate(self._rows):
            yield i, r


# ---------------------------------------------------------------------------
# extract_holdings
# ---------------------------------------------------------------------------
class TestExtractHoldings:
    def test_happy_path_percent_strings(self):
        h = _FakeHolders([("52.30%", "% of Shares Held by All Insider"),
                          ("18.40%", "% of Shares Held by Institutions")])
        got = extract_holdings(h)
        assert got["promoter_holding_pct"] == Decimal("52.30")
        assert got["institutional_pct"] == Decimal("18.40")
        assert got["public_holding_pct"] == Decimal("29.30")

    def test_fractional_input_scaled(self):
        h = _FakeHolders([(0.523, "insider"), (0.184, "inst")])
        got = extract_holdings(h)
        assert got["promoter_holding_pct"] == Decimal("52.30")
        assert got["institutional_pct"] == Decimal("18.40")

    def test_none_input(self):
        got = extract_holdings(None)
        assert all(v is None for v in got.values())

    def test_partial_data(self):
        h = _FakeHolders([("60.0%", "insider")])
        got = extract_holdings(h)
        assert got["promoter_holding_pct"] == Decimal("60.00")
        assert got["institutional_pct"] is None
        assert got["public_holding_pct"] is None


# ---------------------------------------------------------------------------
# extract_quarterly_rows
# ---------------------------------------------------------------------------
class TestExtractQuarterlyRows:
    def _qf(self):
        cols = [date(2024, 9, 30), date(2024, 6, 30), date(2024, 3, 31), date(2023, 12, 31)]
        data = {
            "Total Revenue":    {c: v for c, v in zip(cols, [220_00, 200_00, 190_00, 180_00])},
            "Pretax Income":    {c: v for c, v in zip(cols, [ 50_00,  45_00,  42_00,  40_00])},
            "Net Income":       {c: v for c, v in zip(cols, [ 40_00,  35_00,  32_00,  30_00])},
            "Operating Income": {c: v for c, v in zip(cols, [ 60_00,  55_00,  50_00,  48_00])},
        }
        return _FakeQF(data, cols)

    def test_happy_path(self):
        rows = extract_quarterly_rows(self._qf(), info={"debtToEquity": 24.5})
        assert len(rows) == 4
        r0 = rows[0]
        assert r0["quarter_end_date"] == date(2024, 9, 30)
        assert r0["quarter_label"] == "Sep 2024"
        assert r0["sales"] == Decimal("22000.00")
        assert r0["net_profit"] == Decimal("4000.00")
        # 6000 / 22000 * 100 = 27.27
        assert r0["operating_margin_pct"] == Decimal("27.27")
        assert r0["net_debt_to_equity"] == Decimal("24.5")
        assert r0["promoter_holding_source"] == "yfinance"

    def test_none_input(self):
        assert extract_quarterly_rows(None) == []

    def test_missing_line_items_none(self):
        cols = [date(2024, 9, 30)]
        qf = _FakeQF({"Total Revenue": {cols[0]: 100_00}}, cols)
        rows = extract_quarterly_rows(qf, info=None)
        assert rows[0]["net_profit"] is None
        assert rows[0]["operating_margin_pct"] is None

    def test_string_date_columns(self):
        cols = ["2024-09-30", "2024-06-30"]
        qf = _FakeQF({
            "Total Revenue": {cols[0]: 100_00, cols[1]: 90_00},
        }, cols)
        rows = extract_quarterly_rows(qf, info=None)
        assert rows[0]["quarter_end_date"] == date(2024, 9, 30)


# ---------------------------------------------------------------------------
# 5Y averages
# ---------------------------------------------------------------------------
class TestFiveYearAverages:
    def test_pe_happy_path(self):
        ni = [Decimal("100"), Decimal("100"), Decimal("100"), Decimal("100")]
        closes = [Decimal("200")] * 100
        # TTM_EPS = 400 / 10 = 40 ; PE = 200 / 40 = 5.00
        got = compute_pe_5yr_avg(ni, shares_outstanding=Decimal("10"),
                                 daily_closes=closes)
        assert got == Decimal("5.00")

    def test_pe_missing_data_returns_none(self):
        assert compute_pe_5yr_avg([], Decimal("10"), [Decimal("100")]) is None
        assert compute_pe_5yr_avg([None], Decimal("10"), [Decimal("100")]) is None
        assert compute_pe_5yr_avg([Decimal("1")], None, [Decimal("100")]) is None
        assert compute_pe_5yr_avg([Decimal("1")], Decimal("0"), [Decimal("100")]) is None

    def test_pe_negative_ttm_returns_none(self):
        ni = [Decimal("-100")] * 4
        got = compute_pe_5yr_avg(ni, Decimal("10"), [Decimal("100")])
        assert got is None

    def test_pb_happy_path(self):
        got = compute_pb_5yr_avg(Decimal("50"), [Decimal("150")] * 10)
        assert got == Decimal("3.00")

    def test_pb_missing_data_returns_none(self):
        assert compute_pb_5yr_avg(None, [Decimal("100")]) is None
        assert compute_pb_5yr_avg(Decimal("0"), [Decimal("100")]) is None
        assert compute_pb_5yr_avg(Decimal("10"), []) is None
