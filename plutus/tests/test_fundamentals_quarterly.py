"""Screener.in parsers + fundamentals row builder — offline HTML fixtures.

The fixture mirrors the real screener.in markup shapes the legacy Buddy
fetcher was built against: #top-ratios <li> spans, the quick-ratios Ajax
fragment, #quarters and #shareholding data tables, and the #analysis
pledging sentence.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from plutus.fundamentals.quarterly import rows_from_bundle
from plutus.fundamentals.screener_page import (
    extract_pledging_fallback,
    extract_quarterly_results,
    extract_ratios,
    extract_shareholding,
    extract_warehouse_id,
    parse_number,
    quarter_label_to_date,
)


PAGE_HTML = """
<div data-warehouse-id="150476773" data-company-id="3730"></div>
<ul id="top-ratios">
  <li><span class="name">Market Cap</span>
      <span class="nowrap value">&#8377; <span class="number">8,69,924</span> Cr.</span></li>
  <li><span class="name">Current Price</span>
      <span class="nowrap value">&#8377; <span class="number">2,369</span></span></li>
  <li><span class="name">Stock P/E</span>
      <span class="nowrap value"><span class="number">16.2</span></span></li>
  <li><span class="name">Book Value</span>
      <span class="nowrap value">&#8377; <span class="number">296</span></span></li>
  <li><span class="name">ROCE</span>
      <span class="nowrap value"><span class="number">63.0</span> %</span></li>
  <li><span class="name">ROE</span>
      <span class="nowrap value"><span class="number">51.8</span> %</span></li>
</ul>
<section id="quarters">
  <table class="data-table">
    <thead><tr><th></th><th>Mar 2026</th><th>Jun 2026</th></tr></thead>
    <tbody>
      <tr><td>Sales&nbsp;+</td><td>70,698</td><td>72,275</td></tr>
      <tr><td>Expenses&nbsp;+</td><td>51,422</td><td>53,719</td></tr>
      <tr><td>OPM %</td><td>27%</td><td>26%</td></tr>
      <tr><td>Profit before tax</td><td>18,362</td><td>17,944</td></tr>
      <tr><td>Net Profit&nbsp;+</td><td>13,784</td><td>13,420</td></tr>
    </tbody>
  </table>
</section>
<section id="shareholding">
  <table class="data-table">
    <thead><tr><th></th><th>Mar 2026</th><th>Jun 2026</th></tr></thead>
    <tbody>
      <tr><td><button>Promoters&nbsp;+</button></td><td>71.77%</td><td>71.77%</td></tr>
      <tr><td><button>FIIs&nbsp;+</button></td><td>9.66%</td><td>9.07%</td></tr>
      <tr><td><button>DIIs&nbsp;+</button></td><td>13.34%</td><td>13.41%</td></tr>
      <tr><td><button>Public&nbsp;+</button></td><td>5.16%</td><td>5.69%</td></tr>
      <tr><td>No. of Shareholders</td><td>24,50,090</td><td>26,05,182</td></tr>
    </tbody>
  </table>
</section>
"""

QUICK_RATIOS_HTML = """
<li><span class="name">5Yrs PE</span>
    <span class="nowrap value"><span class="number">29.7</span></span></li>
<li><span class="name">5Yrs PBV</span>
    <span class="nowrap value"><span class="number">13.2</span></span></li>
<li><span class="name">Net Debt to Equity</span>
    <span class="nowrap value"><span class="number">-0.02</span></span></li>
<li><span class="name">Pledged percentage</span>
    <span class="nowrap value"><span class="number">0.00</span> %</span></li>
"""

PLEDGED_PAGE = """
<meta name="description" content="Promoters have pledged 89.4% of their holding.">
<section id="analysis"><div class="cons">
  <li>Promoters have pledged 89.4% of their holding.</li>
</div></section>
"""


class TestPrimitives:
    def test_parse_number(self):
        assert parse_number("3,09,468") == Decimal("309468")
        assert parse_number("63.0%") == Decimal("63.0")
        assert parse_number("-0.02") == Decimal("-0.02")
        assert parse_number("—") is None
        assert parse_number("") is None
        assert parse_number(None) is None

    def test_quarter_label_to_date(self):
        assert quarter_label_to_date("Jun 2026") == date(2026, 6, 30)
        assert quarter_label_to_date("Mar 2026") == date(2026, 3, 31)
        assert quarter_label_to_date("Feb 2024") == date(2024, 2, 29)  # leap
        assert quarter_label_to_date("garbage") is None

    def test_warehouse_id(self):
        assert extract_warehouse_id(PAGE_HTML) == "150476773"
        assert extract_warehouse_id("<div></div>") is None


class TestRatios:
    def test_top_ratios_only(self):
        r = extract_ratios(PAGE_HTML)
        assert r["roce"] == Decimal("63.0")
        assert r["roe"] == Decimal("51.8")
        assert r["current_pe"] == Decimal("16.2")
        # PB derived from Current Price / Book Value: 2369 / 296
        assert r["current_pb"] == Decimal("8.00")
        assert r["pe_5yr_avg"] is None  # quick-ratio, not on the base page

    def test_quick_ratios_merged(self):
        r = extract_ratios(PAGE_HTML, QUICK_RATIOS_HTML)
        assert r["pe_5yr_avg"] == Decimal("29.7")
        assert r["pb_5yr_avg"] == Decimal("13.2")
        assert r["net_debt_to_equity"] == Decimal("-0.02")
        assert r["pledged_pct"] == Decimal("0.00")

    def test_pledging_fallback_sentence(self):
        assert extract_pledging_fallback(PLEDGED_PAGE) == Decimal("89.4")
        assert extract_pledging_fallback(PAGE_HTML) is None


class TestQuarterly:
    def test_extract_quarters(self):
        qs = extract_quarterly_results(PAGE_HTML)
        assert [q["quarter_label"] for q in qs] == ["Mar 2026", "Jun 2026"]
        jun = qs[1]
        assert jun["quarter_end_date"] == date(2026, 6, 30)
        assert jun["sales"] == Decimal("72275")       # ₹ Cr, as printed
        assert jun["pbt"] == Decimal("17944")
        assert jun["net_profit"] == Decimal("13420")
        assert jun["opm_pct"] == Decimal("26")

    def test_empty_page(self):
        assert extract_quarterly_results("<html></html>") == []


class TestShareholding:
    def test_latest_quarter_values(self):
        sh = extract_shareholding(PAGE_HTML)
        assert sh["promoter_holding_pct"] == Decimal("71.77")
        # FIIs 9.07 + DIIs 13.41 (latest column)
        assert sh["institutional_pct"] == Decimal("22.48")
        assert sh["public_holding_pct"] == Decimal("5.69")


class TestRowsFromBundle:
    def _bundle(self):
        return {
            "symbol": "TCS.NS",
            "quarterly": extract_quarterly_results(PAGE_HTML),
            "ratios": extract_ratios(PAGE_HTML, QUICK_RATIOS_HTML),
            "shareholding": extract_shareholding(PAGE_HTML),
        }

    def test_rows_newest_first_and_units(self):
        rows = rows_from_bundle(self._bundle())
        assert len(rows) == 2
        r0 = rows[0]
        assert r0["quarter_end_date"] == date(2026, 6, 30)  # newest first
        # ₹ Cr -> absolute rupees (x 1e7)
        assert r0["sales"] == Decimal("722750000000.00")
        assert r0["net_profit"] == Decimal("134200000000.00")
        assert r0["operating_margin_pct"] == Decimal("26.00")

    def test_quality_metrics_on_newest_row_only(self):
        rows = rows_from_bundle(self._bundle())
        r0, r1 = rows
        assert r0["roce"] == Decimal("63.0")
        assert r0["roe"] == Decimal("51.8")
        assert r0["net_debt_to_equity"] == Decimal("-0.02")
        assert r0["promoter_pledging_pct"] == Decimal("0.00")
        assert r0["pe_5y_avg"] == Decimal("29.7")
        assert r0["pb_5y_avg"] == Decimal("13.2")
        assert r0["promoter_holding_pct"] == Decimal("71.77")
        assert r0["data_source"] == "screener.in"
        assert r0["data_quality_flags"]["roce"] == "screener.in"
        # Older rows: quarterly financials only.
        assert r1["roce"] is None
        assert r1["promoter_holding_pct"] is None
        assert r1["data_quality_flags"] == {}

    def test_uniform_keys_across_rows(self):
        # PostgREST bulk upserts need one uniform column list.
        rows = rows_from_bundle(self._bundle())
        assert set(rows[0].keys()) == set(rows[1].keys())

    def test_empty_bundle(self):
        assert rows_from_bundle({"quarterly": [], "ratios": {}, "shareholding": {}}) == []
