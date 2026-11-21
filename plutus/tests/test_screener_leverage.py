"""Leverage inputs from the Screener company page (migration 030):
#profit-loss TTM column + #balance-sheet Borrowings -> fundamentals row."""
from __future__ import annotations

from decimal import Decimal

from plutus.fundamentals import screener_page as sp
from plutus.fundamentals.quarterly import rows_from_bundle

PAGE = """
<section id="quarters"><table class="data-table"><thead><tr><th></th><th>Jun 2026</th><th>Sep 2026</th></tr></thead>
<tbody>
<tr><td>Sales +</td><td>1,000</td><td>1,100</td></tr>
<tr><td>Profit before tax</td><td>200</td><td>220</td></tr>
<tr><td>Net Profit +</td><td>150</td><td>165</td></tr>
</tbody></table></section>
<section id="profit-loss"><table class="data-table"><thead><tr><th></th><th>Mar 2024</th><th>Mar 2025</th><th>Mar 2026</th><th>TTM</th></tr></thead>
<tbody>
<tr><td>Sales +</td><td>3,500</td><td>3,900</td><td>4,200</td><td>4,300</td></tr>
<tr><td>Expenses +</td><td>2,800</td><td>3,100</td><td>3,300</td><td>3,350</td></tr>
<tr><td>Operating Profit</td><td>700</td><td>800</td><td>900</td><td>950</td></tr>
<tr><td>OPM %</td><td>20%</td><td>21%</td><td>21%</td><td>22%</td></tr>
<tr><td>Other Income +</td><td>20</td><td>25</td><td>30</td><td>30</td></tr>
<tr><td>Interest</td><td>60</td><td>55</td><td>50</td><td>48</td></tr>
<tr><td>Depreciation</td><td>100</td><td>110</td><td>120</td><td>125</td></tr>
<tr><td>Profit before tax</td><td>560</td><td>660</td><td>760</td><td>807</td></tr>
<tr><td>Net Profit +</td><td>420</td><td>495</td><td>570</td><td>605</td></tr>
</tbody></table></section>
<section id="balance-sheet"><table class="data-table"><thead><tr><th></th><th>Mar 2025</th><th>Mar 2026</th></tr></thead>
<tbody>
<tr><td>Equity Capital</td><td>100</td><td>100</td></tr>
<tr><td>Borrowings +</td><td>1,200</td><td>1,050</td></tr>
<tr><td>Total Assets</td><td>6,000</td><td>6,500</td></tr>
</tbody></table></section>
"""


class TestExtractLeverage:
    def test_ttm_column_and_latest_borrowings(self):
        lev = sp.extract_leverage(PAGE)
        assert lev["operating_profit_ttm"] == Decimal("950")
        assert lev["depreciation_ttm"] == Decimal("125")
        assert lev["interest_ttm"] == Decimal("48")
        assert lev["borrowings"] == Decimal("1050")
        assert lev["ttm_label"] == "TTM"

    def test_without_ttm_uses_the_last_year(self):
        page = PAGE.replace("<th>TTM</th>", "").replace("<td>950</td>", "").replace("<td>48</td>", "").replace("<td>125</td>", "")
        lev = sp.extract_leverage(page)
        assert lev["operating_profit_ttm"] == Decimal("900")
        assert lev["interest_ttm"] == Decimal("50")
        assert lev["ttm_label"] == "Mar 2026"

    def test_missing_sections_give_nones(self):
        lev = sp.extract_leverage("<html><body>nothing</body></html>")
        assert lev == {"operating_profit_ttm": None, "depreciation_ttm": None, "interest_ttm": None, "borrowings": None, "ttm_label": None}

    def test_rows_carry_absolute_rupees_on_the_newest_row(self):
        bundle = {"symbol": "X.NS", "quarterly": sp.extract_quarterly_results(PAGE), "ratios": {}, "shareholding": {},
                  "leverage": sp.extract_leverage(PAGE)}
        rows = rows_from_bundle(bundle)
        r0, r1 = rows[0], rows[1]
        assert r0["quarter_label"] == "Sep 2026"
        assert r0["operating_profit_ttm"] == Decimal("9500000000.00")       # 950 Cr
        assert r0["interest_ttm"] == Decimal("480000000.00")
        assert r0["borrowings"] == Decimal("10500000000.00")
        assert r0["data_quality_flags"]["leverage"] == "screener.in:TTM"
        assert r1["operating_profit_ttm"] is None
        # a bundle without the key (older client) still builds rows
        del bundle["leverage"]
        r = rows_from_bundle(bundle)[0]
        assert r["borrowings"] is None and "leverage" not in r["data_quality_flags"]
