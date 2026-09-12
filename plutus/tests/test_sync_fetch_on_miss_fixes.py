"""Regression tests for the 2026-09-12 sync-failure diagnosis.

Root causes (see SyncLogs/ and UserData/quarterlysync.log):
  1. PostgREST caps responses at 1000 rows -> `_find_missing` reported ~350
     of 437 symbols "missing" fundamentals every day, and the scan engine
     saw only 2-3 quarters per symbol.
  2. The daily workflow had no Screener credentials -> the fetch-on-miss
     child wrote a 357-symbol "partial" quarterly_sync row daily, and could
     overwrite the real quarterly run's audit row (same conflict key).
  3. Screener's /consolidated/ page was accepted whenever any top ratio was
     present, even with an EMPTY quarters table (banks / subsidiaries) ->
     12 symbols failed with "no quarterly rows extracted" every run.

Fully offline: fake Supabase query builders, fake HTTP session.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional

from plutus.adapters import supabase_client as sb
from plutus.fundamentals.screener_client import ScreenerClient
from plutus.scan.engine import ScanEngine
from plutus.scripts import run_daily_sync as cli


# ---------------------------------------------------------------------------
# Fake PostgREST: a table with N rows, served in .range() pages, capped at
# 1000 rows per response exactly like Supabase does.
# ---------------------------------------------------------------------------
class _Res:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, table: "_Table"):
        self._t = table
        self._syms: Optional[set] = None
        self._range = None

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def in_(self, _col, values):
        self._syms = set(values)
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, start, end):
        self._range = (start, end)
        self._t.range_calls.append((start, end))
        return self

    def execute(self):
        rows = [r for r in self._t.rows
                if self._syms is None or r["symbol"] in self._syms]
        if self._range is None:
            return _Res(rows[:1000])          # the silent PostgREST cap
        s, e = self._range
        return _Res(rows[s:e + 1][:1000])


@dataclass
class _Table:
    rows: List[Dict[str, Any]]
    range_calls: List[tuple] = field(default_factory=list)


class _FakeClient:
    def __init__(self, tables: Dict[str, List[Dict[str, Any]]]):
        self.tables = {k: _Table(v) for k, v in tables.items()}

    def table(self, name):
        return _Query(self.tables[name])


def _fundamentals_rows(symbols, quarters=12):
    rows = []
    for s in symbols:
        for q in range(quarters):
            rows.append({"symbol": s,
                         "quarter_end_date": f"20{25 - q // 4:02d}-{(3 * (4 - q % 4)):02d}-30",
                         "quarter_label": f"Q{q}", "sales": 100.0 + q,
                         "pbt": 10.0 + q, "net_profit": 5.0 + q,
                         "roce": 12.0, "roe": 11.0})
    return rows


# ---------------------------------------------------------------------------
# 1. fetch_all pages past the 1000-row cap
# ---------------------------------------------------------------------------
class TestFetchAll:
    def test_pages_until_short_page(self):
        client = _FakeClient({"t": [{"symbol": f"S{i}"} for i in range(2500)]})
        rows = sb.fetch_all(lambda: client.table("t").select("symbol"))
        assert len(rows) == 2500
        assert client.tables["t"].range_calls == [(0, 999), (1000, 1999), (2000, 2999)]

    def test_exact_multiple_issues_one_extra_empty_page(self):
        client = _FakeClient({"t": [{"symbol": f"S{i}"} for i in range(1000)]})
        rows = sb.fetch_all(lambda: client.table("t").select("symbol"))
        assert len(rows) == 1000
        assert len(client.tables["t"].range_calls) == 2

    def test_empty_table(self):
        client = _FakeClient({"t": []})
        assert sb.fetch_all(lambda: client.table("t").select("symbol")) == []


# ---------------------------------------------------------------------------
# 2. _find_missing sees every symbol, not just the first ~80
# ---------------------------------------------------------------------------
class TestFindMissing:
    def test_only_truly_missing_symbols_reported(self):
        universe = [f"S{i}.NS" for i in range(437)]
        have = universe[:425]                 # 12 truly missing, like prod
        client = _FakeClient({"fundamentals": _fundamentals_rows(have)})
        # Sanity: the uncapped query WOULD have been truncated.
        assert len(client.table("fundamentals").select("symbol")
                   .in_("symbol", universe).execute().data) == 1000

        missing = cli._find_missing(universe, "fundamentals",
                                    supabase_client=client)
        assert missing == universe[425:]


# ---------------------------------------------------------------------------
# 3. enrich_missing_fundamentals: credential guard, own job types, reasons
# ---------------------------------------------------------------------------
@dataclass
class _Rep:
    symbol: str
    ok: bool
    error: Optional[str] = None


@dataclass
class _WorkerRep:
    symbols_ok: int
    per_symbol: List[_Rep]


class _FakeWorker:
    def __init__(self, fail: Dict[str, str] = None):
        self.calls: List[List[str]] = []
        self.fail = fail or {}

    def run_all(self, symbols, as_of=None, *, dry_run=False):
        self.calls.append(list(symbols))
        per = [_Rep(s, s not in self.fail, self.fail.get(s)) for s in symbols]
        return _WorkerRep(symbols_ok=sum(1 for p in per if p.ok), per_symbol=per)


def _finder_from(have: Dict[str, set]):
    def _finder(symbols, table, supabase_client=None):
        return [s for s in symbols if s not in have[table]]
    return _finder


class TestEnrichment:
    def test_skipped_without_credentials_and_no_worker_runs(self):
        qw, rw = _FakeWorker(), _FakeWorker()
        out = cli.enrich_missing_fundamentals(
            ["A.NS", "B.NS"], quarterly_worker=qw, ratios_worker=rw,
            find_missing=_finder_from({"fundamentals": set(),
                                       "screener_ratios": {"A.NS"}}),
            have_credentials=False)
        assert qw.calls == [] and rw.calls == []
        assert out["skipped"] and "not configured" in out["skipped"]
        assert "2 symbols without fundamentals" in out["skipped"]
        assert out["errors"] == []            # a skip is not a failure
        assert out["missing_fundamentals"] == ["A.NS", "B.NS"]

    def test_nothing_missing_never_checks_credentials(self):
        out = cli.enrich_missing_fundamentals(
            ["A.NS"], find_missing=_finder_from(
                {"fundamentals": {"A.NS"}, "screener_ratios": {"A.NS"}}),
            have_credentials=False)
        assert out["skipped"] is None

    def test_failed_symbols_carry_reason(self):
        qw = _FakeWorker(fail={"B.NS": "no quarterly rows extracted"})
        rw = _FakeWorker()
        out = cli.enrich_missing_fundamentals(
            ["A.NS", "B.NS"], quarterly_worker=qw, ratios_worker=rw,
            find_missing=_finder_from({"fundamentals": set(),
                                       "screener_ratios": {"A.NS", "B.NS"}}),
            have_credentials=True)
        assert out["fundamentals_fetched"] == 1
        assert out["failed_symbols"] == {
            "fundamentals B.NS": "no quarterly rows extracted"}
        assert out["errors"] == ["fundamentals B.NS: no quarterly rows extracted"]

    def test_live_children_get_their_own_job_type(self, monkeypatch):
        """The child rows must not upsert over the scheduled runs."""
        import plutus.sync.quarterly as qmod
        import plutus.sync.weekly_ratios as wmod
        built: Dict[str, Dict[str, Any]] = {}

        class _Q:
            def __init__(self, **kw):
                built["q"] = kw
            def run_all(self, symbols):
                return _WorkerRep(len(symbols), [])

        class _W:
            def __init__(self, **kw):
                built["w"] = kw
            def run_all(self, symbols):
                return _WorkerRep(len(symbols), [])

        monkeypatch.setattr(qmod, "QuarterlySyncWorker", _Q)
        monkeypatch.setattr(wmod, "WeeklyRatiosWorker", _W)
        cli.enrich_missing_fundamentals(
            ["A.NS"], find_missing=_finder_from(
                {"fundamentals": set(), "screener_ratios": set()}),
            have_credentials=True, context={"via": "x"})
        assert built["q"]["job_type"] == cli.ON_MISS_QUARTERLY_JOB_TYPE
        assert built["w"]["job_type"] == cli.ON_MISS_RATIOS_JOB_TYPE
        assert built["q"]["job_type"] not in ("quarterly_sync", "weekly_ratios")
        assert built["w"]["job_type"] not in ("quarterly_sync", "weekly_ratios")
        for jt in (cli.ON_MISS_QUARTERLY_JOB_TYPE, cli.ON_MISS_RATIOS_JOB_TYPE):
            assert len(jt) <= 30             # sync_jobs.job_type VARCHAR(30)


class TestEnrichmentAlertReport:
    def test_green_is_none(self):
        assert cli.enrichment_alert_report(
            {"failed_symbols": {}, "errors": [], "skipped": None},
            date(2026, 9, 12)) is None

    def test_failures_become_partial_report(self):
        rep = cli.enrichment_alert_report({
            "failed_symbols": {"fundamentals B.NS": "no quarterly rows extracted"},
            "errors": ["fundamentals B.NS: no quarterly rows extracted"],
            "missing_fundamentals": ["A.NS", "B.NS"], "missing_ratios": [],
            "fundamentals_fetched": 1, "ratios_fetched": 0, "skipped": None,
        }, date(2026, 9, 12))
        assert rep["symbols_total"] == 2 and rep["symbols_failed"] == 1
        assert rep["symbols_ok"] == 1
        assert rep["per_symbol"][0]["symbol"] == "fundamentals B.NS"
        assert rep["as_of_date"] == "2026-09-12"
        from plutus.alerts.sync_hook import _severity_for
        assert _severity_for(rep) == "warning"

    def test_credential_skip_is_alerted(self):
        rep = cli.enrichment_alert_report({
            "failed_symbols": {}, "errors": [], "missing_fundamentals": ["A.NS"],
            "missing_ratios": [], "skipped": "SCREENER_EMAIL not configured"},
            date(2026, 9, 12))
        assert rep is not None and rep["symbols_failed"] == 1
        assert "not configured" in rep["per_symbol"][0]["error"]


# ---------------------------------------------------------------------------
# 4. ScreenerClient prefers the statement view that HAS quarterly results
# ---------------------------------------------------------------------------
_QUARTERS = """
<section id="quarters"><table class="data-table"><thead>
<tr><th></th><th>Jun 2025</th><th>Sep 2025</th></tr></thead><tbody>
<tr><td>Sales +</td><td>100</td><td>110</td></tr>
<tr><td>Profit before tax</td><td>10</td><td>12</td></tr>
<tr><td>Net Profit +</td><td>8</td><td>9</td></tr>
</tbody></table></section>"""

_RATIOS_ONLY = ('<ul id="top-ratios"><li>Market Cap <span class="number">'
                '48,887</span></li></ul>')


class _Resp:
    def __init__(self, url, text, status=200):
        self.url = url
        self.text = text
        self.status_code = status


class _FakeSession:
    def __init__(self, pages: Dict[str, _Resp]):
        self.pages = pages
        self.headers: Dict[str, str] = {}
        self.calls: List[str] = []

    def get(self, url, **_kw):
        self.calls.append(url)
        for suffix, resp in self.pages.items():
            if url.endswith(suffix):
                return resp
        return _Resp(url, "", status=404)


def _client(pages):
    c = ScreenerClient(session=_FakeSession(pages))
    c._logged_in = True
    return c


class TestScreenerStatementFallback:
    def test_consolidated_with_quarters_wins_immediately(self):
        c = _client({"/company/TCS/consolidated/": _Resp(
            "x/consolidated/", _RATIOS_ONLY + _QUARTERS)})
        html = c.fetch_company_html("TCS.NS")
        assert html and "Jun 2025" in html
        assert c._s.calls == ["https://www.screener.in/company/TCS/consolidated/"]

    def test_empty_consolidated_quarters_falls_back_to_standalone(self):
        """COLPAL / AUBANK / PFIZER shape: ratios present, quarters empty."""
        c = _client({
            "/company/COLPAL/consolidated/": _Resp("x/consolidated/", _RATIOS_ONLY),
            "/company/COLPAL/": _Resp("x/", _RATIOS_ONLY + _QUARTERS),
        })
        html = c.fetch_company_html("COLPAL.NS")
        assert html and "Jun 2025" in html
        assert len(c._s.calls) == 2

    def test_neither_view_has_quarters_returns_ratios_page(self):
        """Weekly ratios must still work for a company with no quarters."""
        c = _client({
            "/company/NEWIPO/consolidated/": _Resp("x/consolidated/", _RATIOS_ONLY),
            "/company/NEWIPO/": _Resp("x/", _RATIOS_ONLY),
        })
        html = c.fetch_company_html("NEWIPO.NS")
        assert html == _RATIOS_ONLY

    def test_unpopulated_pages_still_return_none(self):
        c = _client({
            "/company/X/consolidated/": _Resp("x/consolidated/", "<span class=\"number\"></span>"),
            "/company/X/": _Resp("x/", "<span class=\"number\"> </span>"),
        })
        assert c.fetch_company_html("X.NS") is None


# ---------------------------------------------------------------------------
# 5. Scan engine loads the FULL quarter history for every symbol
# ---------------------------------------------------------------------------
class TestScanEngineFundamentalsPaging:
    def test_all_symbols_and_all_quarters_loaded(self):
        symbols = [f"S{i}.NS" for i in range(414)]
        client = _FakeClient({"fundamentals": _fundamentals_rows(symbols, quarters=12)})
        eng = ScanEngine(supabase_client=client)
        out = eng._default_fetch_fundamentals(symbols)
        assert len(out) == 414
        # 414 x 12 = 4968 rows -> 5 pages
        assert len(client.tables["fundamentals"].range_calls) == 5
        # Aggregates saw every quarter (oldest has the highest sales),
        # not just the newest 2-3 a capped response used to return.
        sample = out["S413.NS"]
        assert sample["latest_q_sales"] == Decimal("100")
        assert sample["ath_q_sales"] == Decimal("111")
