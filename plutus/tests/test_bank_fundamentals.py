"""Banks & NBFC fundamentals (decision 2026-09-25).

Covers the whole path: Screener bank page -> NPA / total-assets parsing ->
ROA on the fundamentals row -> engine TTM / NPA aggregates -> the lender
branch of the 11-check score -> the thresholds the extension is served ->
the sector_group backfill planner. Offline, Decimal-only.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from plutus.fundamentals.quarterly import compute_roa, rows_from_bundle
from plutus.fundamentals.screener_page import (
    extract_quarterly_results,
    extract_ratios,
    extract_shareholding,
    extract_total_assets,
)
from plutus.scan.base import STATUS_FAIL, STATUS_PASS
from plutus.scan.engine import FUNDAMENTAL_AGG_COLS, _quarter_aggregates
from plutus.scan.strategies.fundamental import (
    GROUP_DEFAULTS,
    POINTS_MAX,
    FundamentalScreenerStrategy,
    group_thresholds,
    resolve_group,
)

D = Decimal

# A bank page: "Revenue" instead of "Sales", the two NPA rows, a balance
# sheet with Total Assets, no Net Debt / ROCE worth reading.
BANK_PAGE = """
<div data-warehouse-id="150476001" data-company-id="1298"></div>
<ul id="top-ratios">
  <li><span class="name">Market Cap</span>
      <span class="nowrap value">&#8377; <span class="number">14,50,000</span> Cr.</span></li>
  <li><span class="name">Current Price</span>
      <span class="nowrap value">&#8377; <span class="number">1,900</span></span></li>
  <li><span class="name">Stock P/E</span>
      <span class="nowrap value"><span class="number">19.5</span></span></li>
  <li><span class="name">Book Value</span>
      <span class="nowrap value">&#8377; <span class="number">650</span></span></li>
  <li><span class="name">ROCE</span>
      <span class="nowrap value"><span class="number">7.5</span> %</span></li>
  <li><span class="name">ROE</span>
      <span class="nowrap value"><span class="number">14.6</span> %</span></li>
</ul>
<section id="quarters">
  <table class="data-table">
    <thead><tr><th></th><th>Sep 2025</th><th>Dec 2025</th><th>Mar 2026</th><th>Jun 2026</th></tr></thead>
    <tbody>
      <tr><td>Revenue&nbsp;+</td><td>76,000</td><td>77,500</td><td>78,900</td><td>80,200</td></tr>
      <tr><td>Interest</td><td>44,000</td><td>44,500</td><td>45,000</td><td>45,800</td></tr>
      <tr><td>Financing Profit</td><td>10,000</td><td>10,400</td><td>10,900</td><td>11,300</td></tr>
      <tr><td>Financing Margin %</td><td>13%</td><td>13%</td><td>14%</td><td>14%</td></tr>
      <tr><td>Profit before tax</td><td>22,000</td><td>22,800</td><td>23,600</td><td>24,300</td></tr>
      <tr><td>Net Profit&nbsp;+</td><td>17,000</td><td>17,600</td><td>18,200</td><td>18,700</td></tr>
      <tr><td>Gross NPA %</td><td>1.40%</td><td>1.42%</td><td>1.33%</td><td>1.36%</td></tr>
      <tr><td>Net NPA %</td><td>0.46%</td><td>0.46%</td><td>0.43%</td><td>0.45%</td></tr>
    </tbody>
  </table>
</section>
<section id="balance-sheet">
  <table class="data-table">
    <thead><tr><th></th><th>Mar 2024</th><th>Mar 2025</th><th>Mar 2026</th></tr></thead>
    <tbody>
      <tr><td>Equity Capital</td><td>760</td><td>765</td><td>767</td></tr>
      <tr><td>Deposits</td><td>23,00,000</td><td>27,00,000</td><td>29,50,000</td></tr>
      <tr><td>Total Liabilities</td><td>36,00,000</td><td>39,10,000</td><td>41,50,000</td></tr>
      <tr><td>Total Assets</td><td>36,00,000</td><td>39,10,000</td><td>41,50,000</td></tr>
    </tbody>
  </table>
</section>
<section id="shareholding">
  <table class="data-table">
    <thead><tr><th></th><th>Mar 2026</th><th>Jun 2026</th></tr></thead>
    <tbody>
      <tr><td><button>Promoters&nbsp;+</button></td><td>0.00%</td><td>0.00%</td></tr>
      <tr><td><button>FIIs&nbsp;+</button></td><td>48.00%</td><td>47.50%</td></tr>
      <tr><td><button>DIIs&nbsp;+</button></td><td>35.00%</td><td>35.80%</td></tr>
      <tr><td><button>Public&nbsp;+</button></td><td>17.00%</td><td>16.70%</td></tr>
    </tbody>
  </table>
</section>
"""

QUICK_RATIOS_WITH_ROA = """
<ul>
  <li><span class="name">5Yrs <span class="sub">avg</span> PE</span>
      <span class="nowrap value"><span class="number">21.0</span></span></li>
  <li><span class="name">5Yrs PBV</span>
      <span class="nowrap value"><span class="number">3.1</span></span></li>
  <li><span class="name">Return on assets</span>
      <span class="nowrap value"><span class="number">1.95</span> %</span></li>
</ul>
"""

QUICK_RATIOS_NO_ROA = """
<ul>
  <li><span class="name">5Yrs <span class="sub">avg</span> PE</span>
      <span class="nowrap value"><span class="number">21.0</span></span></li>
  <li><span class="name">5Yrs PBV</span>
      <span class="nowrap value"><span class="number">3.1</span></span></li>
</ul>
"""


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------
class TestBankPageParsing:
    def test_revenue_row_maps_to_sales_and_npa_rows_parse(self):
        qs = extract_quarterly_results(BANK_PAGE)
        assert [q["quarter_label"] for q in qs] == ["Sep 2025", "Dec 2025", "Mar 2026", "Jun 2026"]
        jun = qs[-1]
        assert jun["sales"] == D("80200")          # "Revenue" row
        assert jun["net_profit"] == D("18700")
        assert jun["gross_npa_pct"] == D("1.36")
        assert jun["net_npa_pct"] == D("0.45")

    def test_non_lender_page_has_no_npa(self):
        from plutus.tests.test_fundamentals_quarterly import PAGE_HTML
        qs = extract_quarterly_results(PAGE_HTML)
        assert all(q["gross_npa_pct"] is None and q["net_npa_pct"] is None for q in qs)

    def test_total_assets_latest_column(self):
        assert extract_total_assets(BANK_PAGE) == D("4150000")   # ₹ Cr as printed
        assert extract_total_assets("<html></html>") is None

    def test_roa_quick_ratio_only_when_configured(self):
        with_roa = extract_ratios(BANK_PAGE, QUICK_RATIOS_WITH_ROA)
        assert with_roa["roa"] == D("1.95")
        without = extract_ratios(BANK_PAGE, QUICK_RATIOS_NO_ROA)
        assert without["roa"] is None
        assert without["pe_5yr_avg"] == D("21.0")


# Consolidated bank page: NPA rows present, every cell blank (what Screener
# really serves for HDFCBANK / SBIN / ...). The standalone page has them.
CONSOLIDATED_BLANK_NPA = BANK_PAGE.replace(
    "<tr><td>Gross NPA %</td><td>1.40%</td><td>1.42%</td><td>1.33%</td><td>1.36%</td></tr>",
    "<tr><td>Gross NPA %</td><td></td><td></td><td></td><td></td></tr>",
).replace(
    "<tr><td>Net NPA %</td><td>0.46%</td><td>0.46%</td><td>0.43%</td><td>0.45%</td></tr>",
    "<tr><td>Net NPA %</td><td></td><td></td><td></td><td></td></tr>",
)


class TestStandaloneNpaFallback:
    def test_blank_detection(self):
        from plutus.fundamentals.screener_page import quarterly_npa_is_blank
        from plutus.tests.test_fundamentals_quarterly import PAGE_HTML
        q = extract_quarterly_results(CONSOLIDATED_BLANK_NPA)
        assert all(x["gross_npa_pct"] is None for x in q)
        assert quarterly_npa_is_blank(q, CONSOLIDATED_BLANK_NPA) is True
        # Printed NPAs (NBFC) and non-lenders never trigger the extra fetch.
        assert quarterly_npa_is_blank(extract_quarterly_results(BANK_PAGE), BANK_PAGE) is False
        assert quarterly_npa_is_blank(extract_quarterly_results(PAGE_HTML), PAGE_HTML) is False

    def test_fill_by_quarter_label_only_where_missing(self):
        from plutus.fundamentals.screener_page import fill_npa_from
        target = extract_quarterly_results(CONSOLIDATED_BLANK_NPA)
        source = extract_quarterly_results(BANK_PAGE)
        source[0]["gross_npa_pct"] = None            # Sep 2025 unprinted there too
        target[-1]["net_npa_pct"] = D("9.99")         # pre-existing value must survive
        n = fill_npa_from(target, source)
        assert n == 4
        assert target[-1]["gross_npa_pct"] == D("1.36")
        assert target[-1]["net_npa_pct"] == D("9.99")
        assert target[0]["gross_npa_pct"] is None and target[0]["net_npa_pct"] == D("0.46")

    def test_client_bundle_fetches_standalone_once_for_blank_banks(self, monkeypatch):
        from plutus.fundamentals import screener_client as sc

        class _Resp:
            def __init__(self, text, status=200, url="https://www.screener.in/company/X/"):
                self.text, self.status_code, self.url = text, status, url

        class _Session:
            def __init__(self, pages):
                self.pages, self.headers, self.calls = pages, {}, []

            def get(self, url, **kw):
                self.calls.append(url)
                for key, text in self.pages.items():
                    if url.endswith(key):
                        return _Resp(text, url=url)
                return _Resp("", status=404, url=url)

        # Consolidated: numbers + quarters + blank NPA. Standalone: NPA printed.
        sess = _Session({"/company/HDFCBANK/consolidated/": CONSOLIDATED_BLANK_NPA,
                         "/company/HDFCBANK/": BANK_PAGE})
        cli = sc.ScreenerClient(session=sess)
        monkeypatch.setattr(cli, "login", lambda *a, **k: None)
        monkeypatch.setattr(cli, "fetch_quick_ratios_html", lambda *a, **k: QUICK_RATIOS_NO_ROA)
        monkeypatch.setattr(cli, "_company_id", lambda *a, **k: None)
        b = cli.fetch_bundle("HDFCBANK.NS")
        assert b["quarterly"][-1]["gross_npa_pct"] == D("1.36")
        assert b["quarterly"][-1]["net_npa_pct"] == D("0.45")
        assert b["total_assets"] == D("4150000")
        assert sum(1 for u in sess.calls if u.endswith("/company/HDFCBANK/")) == 1

        # NBFC-style page (NPAs printed on consolidated): no standalone call.
        sess2 = _Session({"/company/BAJFINANCE/consolidated/": BANK_PAGE,
                          "/company/BAJFINANCE/": BANK_PAGE})
        cli2 = sc.ScreenerClient(session=sess2)
        monkeypatch.setattr(cli2, "login", lambda *a, **k: None)
        monkeypatch.setattr(cli2, "fetch_quick_ratios_html", lambda *a, **k: None)
        monkeypatch.setattr(cli2, "_company_id", lambda *a, **k: None)
        cli2.fetch_bundle("BAJFINANCE.NS")
        assert not any(u.endswith("/company/BAJFINANCE/") for u in sess2.calls)


# ---------------------------------------------------------------------------
# Row builder — ROA + NPA on the fundamentals rows
# ---------------------------------------------------------------------------
class TestBankRows:
    def _bundle(self, quick_html):
        return {
            "symbol": "HDFCBANK.NS",
            "quarterly": extract_quarterly_results(BANK_PAGE),
            "ratios": extract_ratios(BANK_PAGE, quick_html),
            "shareholding": extract_shareholding(BANK_PAGE),
            "total_assets": extract_total_assets(BANK_PAGE),
        }

    def test_roa_derived_from_ttm_profit_over_assets(self):
        rows = rows_from_bundle(self._bundle(QUICK_RATIOS_NO_ROA))
        r0 = rows[0]
        # TTM NP = 17,000 + 17,600 + 18,200 + 18,700 = 71,500 Cr; / 41,50,000 Cr = 1.72%
        assert r0["roa"] == D("1.72")
        assert r0["total_assets"] == D("41500000000000.00")   # absolute rupees
        assert r0["data_quality_flags"]["roa"] == "derived:ttm_net_profit/total_assets"
        assert r0["data_quality_flags"]["gross_npa_pct"] == "screener.in"
        # Per-quarter NPA on every row; ROA / assets on the newest only.
        assert [r["gross_npa_pct"] for r in rows] == [D("1.36"), D("1.33"), D("1.42"), D("1.40")]
        assert rows[1]["roa"] is None and rows[1]["total_assets"] is None
        assert set(rows[0].keys()) == set(rows[1].keys())

    def test_quick_ratio_roa_wins_over_derived(self):
        rows = rows_from_bundle(self._bundle(QUICK_RATIOS_WITH_ROA))
        assert rows[0]["roa"] == D("1.95")
        assert rows[0]["data_quality_flags"]["roa"] == "screener.in"

    def test_compute_roa_needs_four_quarters_and_positive_assets(self):
        q = [{"net_profit": D("10")}] * 4
        assert compute_roa(q, D("1000")) == D("4.00")
        assert compute_roa(q[:3], D("1000")) is None
        assert compute_roa(q, None) is None
        assert compute_roa(q, D("0")) is None
        assert compute_roa([{"net_profit": None}] + q[:3], D("1000")) is None

    def test_non_lender_rows_keep_nulls(self):
        from plutus.tests.test_fundamentals_quarterly import PAGE_HTML, QUICK_RATIOS_HTML
        rows = rows_from_bundle({
            "symbol": "TCS.NS",
            "quarterly": extract_quarterly_results(PAGE_HTML),
            "ratios": extract_ratios(PAGE_HTML, QUICK_RATIOS_HTML),
            "shareholding": extract_shareholding(PAGE_HTML),
        })
        assert rows[0]["roa"] is None            # only 2 quarters, no assets
        assert rows[0]["gross_npa_pct"] is None
        assert "roa" not in rows[0]["data_quality_flags"]


# ---------------------------------------------------------------------------
# Engine aggregates
# ---------------------------------------------------------------------------
class TestLenderAggregates:
    def _rows(self, n=4):
        rows = []
        for i, (y, m, dd) in enumerate([(2026, 6, 30), (2026, 3, 31), (2025, 12, 31),
                                         (2025, 9, 30), (2025, 6, 30)][:n]):
            rows.append({"quarter_end_date": date(y, m, dd),
                         "sales": D("100"), "pbt": D("20"), "net_profit": D(str(10 + i)),
                         "gross_npa_pct": D("1.3") if i else None,   # latest quarter unprinted
                         "net_npa_pct": D("0.4") if i else None})
        return rows

    def test_ttm_and_latest_printed_npa(self):
        agg = _quarter_aggregates(self._rows(5))
        assert agg["ttm_net_profit"] == D("46")       # 10+11+12+13
        assert agg["ttm_quarters"] == 4
        assert agg["latest_q_gross_npa_pct"] == D("1.3")   # newest row that printed it
        assert agg["latest_q_net_npa_pct"] == D("0.4")
        assert set(FUNDAMENTAL_AGG_COLS) <= set(agg.keys())

    def test_ttm_none_with_fewer_than_four_quarters(self):
        agg = _quarter_aggregates(self._rows(3))
        assert agg["ttm_net_profit"] is None
        assert agg["ttm_quarters"] == 0

    def test_npa_none_for_non_lenders(self):
        rows = [{"quarter_end_date": date(2026, 6, 30), "sales": D("1"),
                 "pbt": D("1"), "net_profit": D("1")}]
        agg = _quarter_aggregates(rows)
        assert agg["latest_q_gross_npa_pct"] is None
        assert agg["latest_q_net_npa_pct"] is None


# ---------------------------------------------------------------------------
# Strategy — lender branch
# ---------------------------------------------------------------------------
def _bank_snapshot(**overrides):
    """A bank that passes ALL 11 lender checks unless overridden."""
    snap = {
        "symbol": "HDFCBANK.NS",
        "sector_group": "Banks",
        "pe_current": D("19.5"),
        "pb_current": D("2.92"),
        "pe_5y_avg": D("21.0"),
        "pb_5y_avg": D("3.10"),
        "roe": D("14.6"),
        "roa": D("1.72"),
        "roce": D("7.5"),                      # ignored for lenders
        "net_debt_to_equity": None,            # ignored for lenders
        "promoter_pledging_pct": D("0.00"),
        "promoter_holding_pct": D("0.00"),
        "latest_q_sales": D("802000000000"),
        "latest_q_pbt": D("243000000000"),
        "latest_q_net_profit": D("187000000000"),
        "ath_q_sales": D("802000000000"),
        "ath_q_pbt": D("243000000000"),
        "ath_q_net_profit": D("187000000000"),
        "yoy_q_net_profit": D("161000000000"),
        "prev_q_net_profit": D("182000000000"),
        "ttm_net_profit": D("715000000000"),   # 71,500 Cr
        "ttm_quarters": 4,
        "latest_q_gross_npa_pct": D("1.36"),
        "latest_q_net_npa_pct": D("0.45"),
    }
    snap.update(overrides)
    return snap


class TestLenderScore:
    def test_bank_all_pass(self):
        r = FundamentalScreenerStrategy().evaluate(_bank_snapshot(), {})
        assert r.score == 11 and r.status == STATUS_PASS
        ms = r.metrics_snapshot
        assert ms["group"] == "Banks"
        assert ms["points_max"] == POINTS_MAX == 11
        assert all(c["passed"] is True for c in ms["checks"])
        assert r.reasons[0].startswith("[PASS] 1. PE < 30")

    def test_bank_check_ids_and_order(self):
        r = FundamentalScreenerStrategy().evaluate(_bank_snapshot(), {})
        ids = [c["id"] for c in r.metrics_snapshot["checks"]]
        assert ids == ["pe_lt_30", "pe_lt_5yr", "pb_lt_5yr", "roe", "roa",
                       "np_ttm", "np_yoy", "profit_ath", "pledging", "gnpa", "nnpa"]
        # None of the Normal-only checks leak into the lender list.
        assert not {"net_debt", "roce", "sales_ath", "pbt_ath"} & set(ids)

    def test_bank_no_longer_sinks_on_debt_roce_sales(self):
        # A bank with a "bad" Net D/E, ROCE 7.5% and Revenue below its ATH
        # quarter is still a full-marks lender.
        snap = _bank_snapshot(net_debt_to_equity=D("9.5"), roce=D("7.5"),
                              latest_q_sales=D("1"), ath_q_sales=D("100"))
        r = FundamentalScreenerStrategy().evaluate(snap, {})
        assert r.score == 11

    def test_bank_thresholds(self):
        s = FundamentalScreenerStrategy()
        by = lambda snap: {c["id"]: c for c in s.evaluate(snap, {}).metrics_snapshot["checks"]}  # noqa: E731
        assert by(_bank_snapshot(pe_current=D("30")))["pe_lt_30"]["passed"] is False
        assert by(_bank_snapshot(roe=D("12")))["roe"]["passed"] is False
        assert by(_bank_snapshot(roe=D("12.1")))["roe"]["passed"] is True
        assert by(_bank_snapshot(roa=D("1.2")))["roa"]["passed"] is False
        assert by(_bank_snapshot(roa=D("1.21")))["roa"]["passed"] is True
        assert by(_bank_snapshot(latest_q_gross_npa_pct=D("3")))["gnpa"]["passed"] is False
        assert by(_bank_snapshot(latest_q_net_npa_pct=D("1")))["nnpa"]["passed"] is False
        # TTM floor is 1,000 Cr in absolute rupees.
        assert by(_bank_snapshot(ttm_net_profit=D("10000000000")))["np_ttm"]["passed"] is False
        assert by(_bank_snapshot(ttm_net_profit=D("10000000001")))["np_ttm"]["passed"] is True

    def test_nbfc_is_stricter_on_roe_and_roa(self):
        s = FundamentalScreenerStrategy()
        nbfc = _bank_snapshot(sector_group="NBFC", roe=D("14.6"), roa=D("1.72"))
        r = s.evaluate(nbfc, {})
        by = {c["id"]: c for c in r.metrics_snapshot["checks"]}
        assert r.metrics_snapshot["group"] == "NBFC"
        assert by["roe"]["label"] == "ROE > 15%" and by["roe"]["passed"] is False
        assert by["roa"]["label"] == "ROA > 2%" and by["roa"]["passed"] is False
        assert r.score == 9

    def test_missing_lender_inputs_are_na(self):
        snap = _bank_snapshot(roa=None, latest_q_gross_npa_pct=None,
                              latest_q_net_npa_pct=None, ttm_net_profit=None)
        r = FundamentalScreenerStrategy().evaluate(snap, {})
        by = {c["id"]: c for c in r.metrics_snapshot["checks"]}
        assert by["roa"]["passed"] is None
        assert by["gnpa"]["passed"] is None
        assert by["nnpa"]["passed"] is None
        assert by["np_ttm"]["passed"] is None
        assert r.metrics_snapshot["unknown"] == 4
        assert r.score == 7 and r.status == STATUS_FAIL

    def test_group_overrides_via_config(self):
        cfg = {"thresholds": {"groups": {"Banks": {"roa_min": "1.8"}},
                              "pledging_max": "0.5"}}
        snap = _bank_snapshot(promoter_pledging_pct=D("1"))
        r = FundamentalScreenerStrategy().evaluate(snap, cfg)
        by = {c["id"]: c for c in r.metrics_snapshot["checks"]}
        assert by["roa"]["passed"] is False           # 1.72 < 1.8
        assert by["pledging"]["passed"] is False      # shared key inherited: 1 > 0.5
        assert by["pledging"]["label"] == "Pledging < 0.5%"

    def test_group_thresholds_resolution(self):
        t = group_thresholds("NBFC", {})
        assert t == GROUP_DEFAULTS["NBFC"]
        t = group_thresholds("Banks", {"groups": {"Banks": {"pe_max": "25"}}, "ath_tolerance": "0.8"})
        assert t["pe_max"] == D("25") and t["ath_tolerance"] == D("0.8")
        assert t["roe_min"] == D("12")

    def test_normal_and_unknown_groups_take_legacy_list(self):
        from plutus.tests.test_strategy_fundamental import _snapshot
        for grp in ("Normal", None, "", "weird"):
            r = FundamentalScreenerStrategy().evaluate(_snapshot(sector_group=grp), {})
            assert r.metrics_snapshot["group"] == "Normal"
            assert [c["id"] for c in r.metrics_snapshot["checks"]][3] == "net_debt"
            assert r.score == 11
        assert resolve_group("banks") == "Banks" and resolve_group("nbfc") == "NBFC"

    def test_data_block_carries_lender_metrics(self):
        r = FundamentalScreenerStrategy().evaluate(_bank_snapshot(), {})
        data = r.metrics_snapshot["data"]
        assert data["roa"] == D("1.72")
        assert data["gross_npa"] == D("1.36")
        assert data["net_npa"] == D("0.45")
        assert data["ttm_profit"] == D("715000000000")


# ---------------------------------------------------------------------------
# Extension thresholds + backfill planner
# ---------------------------------------------------------------------------
class TestWiring:
    def test_extension_thresholds_include_groups(self):
        from plutus.api import extension as ext
        t = ext.default_thresholds()["fundamental"]
        assert t["groups"]["Banks"]["roa_min"] == D("1.2")
        assert t["groups"]["NBFC"]["roe_min"] == D("15")
        assert t["groups"]["Banks"]["pe_max"] == D("30")
        assert t["pe_max"] == D("70")   # Normal list untouched

    def test_backfill_planner(self):
        from plutus.scripts.backfill_sector_group import plan_updates
        stocks = [
            {"symbol": "HDFCBANK.NS", "sector": "Financial Services", "industry": "Banks - Regional", "sector_group": None},
            {"symbol": "BAJFINANCE.NS", "sector": "Financial Services", "industry": "Credit Services", "sector_group": None},
            {"symbol": "HDFCAMC.NS", "sector": "Financial Services", "industry": "Asset Management", "sector_group": None},
            {"symbol": "TCS.NS", "sector": "Technology", "industry": "IT Services", "sector_group": "Normal"},   # already set
            {"symbol": "SBIN.NS", "sector": "Financial Services", "industry": "Banks - Regional", "sector_group": "NBFC"},  # manual, kept
            {"symbol": "NEW.NS", "sector": None, "industry": None, "sector_group": None},   # nothing known
        ]
        plan = plan_updates(stocks)
        assert {u["symbol"]: u["to"] for u in plan} == {
            "HDFCBANK.NS": "Banks", "BAJFINANCE.NS": "NBFC", "HDFCAMC.NS": "Normal"}
        # --overwrite re-classifies the manual row too.
        plan = plan_updates(stocks, overwrite=True)
        assert {u["symbol"]: u["to"] for u in plan}["SBIN.NS"] == "Banks"
        assert "TCS.NS" not in {u["symbol"] for u in plan}   # unchanged answer

    def test_backfill_planner_fetches_when_nothing_stored(self):
        from plutus.adapters.result import Result
        from plutus.scripts.backfill_sector_group import plan_updates
        calls = []

        def fake_fetch(sym):
            calls.append(sym)
            return Result.success({"longName": "Chola Fin", "sector": "Financial Services",
                                   "industry": "Credit Services"})

        plan = plan_updates([{"symbol": "CHOLAFIN.NS", "sector_group": None}], fetch_info=fake_fetch)
        assert calls == ["CHOLAFIN.NS"]
        assert plan[0]["to"] == "NBFC" and plan[0]["source"] == "yfinance"
        assert plan[0]["industry"] == "Credit Services" and plan[0]["name"] == "Chola Fin"
