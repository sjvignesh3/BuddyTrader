"""US market, phase 1 — markets module, US sync / scan paths, Universe API.

100% offline: Yahoo and Supabase are stubbed. The point of most of these
tests is that the Indian behaviour is unchanged and the US path differs only
where it must (symbols, calendar, valuation source, no Screener, no cap bucket).
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from plutus import markets
from plutus.adapters.result import Result
from plutus.adapters.validators import sanity_check_market_symbol, sanity_check_symbol
from plutus.api import admin_trigger, repository
from plutus.api.universe import (
    fields_from_info, needs_enrichment, parse_import_rows, parse_us_symbol_list,
    stored_symbol,
)
from plutus.scripts import run_daily_sync, run_scan
from plutus.sync.history_builder import quote_session_date, valuation_from_info
from plutus.sync.worker import DailySyncWorker
from plutus.tests.test_api_universe import FakeDB, _stock
from plutus.tests.test_run_scan_cli import _StubEngine
from plutus.tests.test_sync_worker import (
    _FakeUpsert, _fake_ratios_loader, _ok_fetch_history, _ok_fetch_info,
)

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "026_markets.sql"


# ---------------------------------------------------------------------------
# plutus.markets
# ---------------------------------------------------------------------------
class TestSymbols:
    @pytest.mark.parametrize("sym, market", [
        ("TCS.NS", "IN"), ("500325.BO", "IN"), ("tcs.ns", "IN"),
        ("NVDA", "US"), ("BRK-B", "US"),
    ])
    def test_market_of(self, sym, market):
        assert markets.market_of(sym) == market

    @pytest.mark.parametrize("raw, expected", [
        ("tcs", "TCS.NS"), ("TCS.NS", "TCS.NS"), ("M&M", "M&M.NS"), ("500325.bo", "500325.BO"),
        ("NVDA", "NVDA.NS"),          # a bare ticker in an Indian pool is Indian, as before
    ])
    def test_canonical_in_is_unchanged(self, raw, expected):
        assert markets.canonical_symbol(raw) == expected

    @pytest.mark.parametrize("raw, expected", [
        ("nvda", "NVDA"), (" SNDK ", "SNDK"), ("BRK.B", "BRK-B"), ("brk-b", "BRK-B"),
    ])
    def test_canonical_us(self, raw, expected):
        assert markets.canonical_symbol(raw, "US") == expected

    @pytest.mark.parametrize("raw", ["TCS.NS", "500325", "TOOLONG", "M&M", "", None, "NV DA"])
    def test_canonical_us_rejects(self, raw):
        assert markets.canonical_symbol(raw, "US") is None

    def test_split_and_filter(self):
        syms = ["TCS.NS", "NVDA", "INFY.NS", "CAT"]
        assert markets.split_by_market(syms) == {"IN": ["TCS.NS", "INFY.NS"], "US": ["NVDA", "CAT"]}
        assert markets.filter_market(syms, "US") == ["NVDA", "CAT"]

    def test_validators(self):
        assert sanity_check_market_symbol("nvda") == "NVDA"
        assert sanity_check_market_symbol("tcs.ns") == "TCS.NS"
        with pytest.raises(ValueError):
            sanity_check_market_symbol("NV DA")
        # The Screener-side check stays strictly Indian.
        with pytest.raises(ValueError):
            sanity_check_symbol("NVDA")


class TestMarketFacts:
    def test_pool_market_defaults_to_in(self):
        assert markets.pool_market({"code": "F40"}) == "IN"          # column absent
        assert markets.pool_market({"code": "F40", "market": None}) == "IN"
        assert markets.pool_market({"code": "USMEGA", "market": "US"}) == "US"
        assert markets.pool_market({"market": "junk"}) == "IN"

    def test_job_types_never_collide(self):
        assert markets.get_market("IN").daily_job_type == "daily_sync"
        assert markets.get_market("US").daily_job_type == "daily_sync_us"
        assert len(markets.get_market("US").daily_job_type) <= 30   # sync_jobs.job_type width

    def test_only_india_uses_screener(self):
        assert markets.get_market("IN").uses_screener is True
        assert markets.get_market("US").uses_screener is False

    def test_us_exchange_codes(self):
        assert markets.us_exchange("NMS") == "NASDAQ"
        assert markets.us_exchange("NYQ") == "NYSE"
        assert markets.us_exchange("nasdaq") == "NASDAQ"
        assert markets.us_exchange("XYZ") is None
        assert markets.default_exchange("NVDA") == "NASDAQ"
        assert markets.default_exchange("TCS.NS") == "NSE"
        assert markets.default_exchange("500325.BO") == "BSE"

    def test_today_is_on_the_markets_own_calendar(self):
        # 2026-11-11 21:30 UTC = 03:00 IST on the 12th, 16:30 New York on the 11th.
        now = datetime(2026, 11, 11, 21, 30, tzinfo=timezone.utc)
        assert markets.today_in("IN", now) == date(2026, 11, 12)
        assert markets.today_in("US", now) == date(2026, 11, 11)

    def test_us_close_is_dated_in_new_york(self):
        # 16:00 New York close on 2026-11-10 (EST) = 21:00 UTC = 02:30 IST on the 11th.
        ts = int(datetime(2026, 11, 10, 21, 0, tzinfo=timezone.utc).timestamp())
        info = {"regularMarketTime": ts}
        assert quote_session_date(info, markets.get_market("US").tz) == date(2026, 11, 10)
        assert quote_session_date(info) == date(2026, 11, 11)   # IST — the bug this avoids


# ---------------------------------------------------------------------------
# Daily sync
# ---------------------------------------------------------------------------
class TestUsWorker:
    def _worker(self, **kw):
        calls = {"ratios": 0}

        def ratios(client=None):
            calls["ratios"] += 1
            return _fake_ratios_loader(client)

        w = DailySyncWorker.for_market(
            "US", fetch_info=_ok_fetch_info, fetch_history=_ok_fetch_history,
            upsert=_FakeUpsert(), load_screener_ratios=ratios, **kw)
        return w, calls

    def test_valuation_comes_from_yahoo_and_cap_bucket_stays_empty(self):
        w, calls = self._worker()
        rep, row = w.run_symbol("NVDA", date(2024, 6, 1))
        assert rep.ok and row["symbol"] == "NVDA"
        assert row["pe_current"] == Decimal("22.5")
        assert row["pb_current"] == Decimal("4.1")
        assert row["market_cap"] == Decimal("800000000000")
        assert isinstance(row["market_cap"], Decimal)
        assert row["cap_bucket"] is None
        assert calls["ratios"] == 0          # Screener table never read

    def test_run_all_uses_its_own_job_type(self):
        w, calls = self._worker()
        report = w.run_all(["NVDA", "CAT"], as_of=date(2024, 6, 1), dry_run=True)
        assert report.job_type == "daily_sync_us"
        assert report.symbols_ok == 2 and calls["ratios"] == 0

    def test_indian_worker_is_unchanged(self):
        w = DailySyncWorker(fetch_info=_ok_fetch_info, fetch_history=_ok_fetch_history,
                            upsert=_FakeUpsert(), load_screener_ratios=_fake_ratios_loader)
        assert w.market == "IN" and w.job_type == "daily_sync"
        _, row = w.run_symbol("RELIANCE.NS", date(2024, 6, 1))
        assert row["pe_current"] == Decimal("22.50")       # Screener value, not Yahoo's 22.5
        assert row["cap_bucket"] in ("Large", "Mid", "Small", "Micro")

    def test_valuation_from_info_skips_junk(self):
        assert valuation_from_info({"marketCap": 1e12, "trailingPE": float("nan"),
                                    "priceToBook": -3}) == {
            "market_cap": Decimal("1000000000000"), "pe": None, "pb": None}
        assert valuation_from_info({}) == {}
        assert valuation_from_info({"trailingPE": None}) == {}


class _RecWorker:
    run_context = None

    def __init__(self):
        self.symbols = None

    def run_all(self, symbols, as_of=None, dry_run=False):
        self.symbols = list(symbols)
        return DailySyncWorker(
            fetch_info=_ok_fetch_info, fetch_history=_ok_fetch_history,
            upsert=_FakeUpsert(), load_screener_ratios=_fake_ratios_loader,
        ).run_all([], as_of=as_of, dry_run=True)


class TestDailySyncCli:
    UNIVERSE = ["TCS.NS", "NVDA", "INFY.NS", "CAT", "SBIN.NS", "GS"]

    def _loader(self, *, pool, limit):
        return self.UNIVERSE[:limit] if limit is not None else list(self.UNIVERSE)

    def test_resolve_market(self):
        assert run_daily_sync.resolve_market(None, []) == "IN"
        assert run_daily_sync.resolve_market("us", []) == "US"
        assert run_daily_sync.resolve_market(None, ["NVDA", "CAT"]) == "US"
        assert run_daily_sync.resolve_market(None, ["TCS.NS"]) == "IN"
        with pytest.raises(ValueError, match="mixes"):
            run_daily_sync.resolve_market(None, ["TCS.NS", "NVDA"])
        with pytest.raises(ValueError, match="does not match"):
            run_daily_sync.resolve_market("IN", ["NVDA"])
        with pytest.raises(ValueError):
            run_daily_sync.resolve_market("UK", [])

    def test_default_run_syncs_indian_symbols_only(self, capsys):
        w = _RecWorker()
        run_daily_sync.main(["--dry-run"], worker=w, load_symbols=self._loader)
        assert w.symbols == ["TCS.NS", "INFY.NS", "SBIN.NS"]

    def test_us_run_syncs_us_symbols_only(self, capsys):
        w = _RecWorker()
        run_daily_sync.main(["--dry-run", "--market", "US"], worker=w, load_symbols=self._loader)
        assert w.symbols == ["NVDA", "CAT", "GS"]

    def test_limit_applies_within_the_market(self, capsys):
        w = _RecWorker()
        run_daily_sync.main(["--dry-run", "--market", "US", "--limit", "2"],
                            worker=w, load_symbols=self._loader)
        assert w.symbols == ["NVDA", "CAT"]

    def test_mixed_symbols_are_refused(self, capsys):
        w = _RecWorker()
        rc = run_daily_sync.main(["--dry-run", "--symbols", "TCS.NS,NVDA"], worker=w)
        assert rc == 2 and w.symbols is None

    def test_us_run_never_calls_screener_enrichment(self, monkeypatch, capsys):
        called = []
        monkeypatch.setattr(run_daily_sync, "enrich_missing_fundamentals",
                            lambda *a, **k: called.append(a) or {"errors": []})
        w = _RecWorker()
        run_daily_sync.main(["--market", "US", "--symbols", "NVDA"], worker=w)
        assert called == [] and w.symbols == ["NVDA"]
        assert w.run_context["market"] == "US"


# ---------------------------------------------------------------------------
# Scan CLI
# ---------------------------------------------------------------------------
class _MarketEngine(_StubEngine):
    """Stub with the per-pool hooks the real engine has."""

    def __init__(self, *, dates, us_pools=("USMEGA",), **kw):
        super().__init__(**kw)
        self.dates = dates
        self.us_pools = list(us_pools)

    def resolve_snapshot_date(self, on_or_before):
        return max(d for d in self.dates.values() if d is not None)

    def resolve_pool_snapshot_date(self, pool, on_or_before):
        return self.dates.get(pool)

    def pool_market_code(self, pool):
        return "US" if pool in self.us_pools else "IN"

    def list_pool_codes(self, market):
        return list(self.us_pools) if market == "US" else list(run_scan.ALL_POOLS)


class TestScanCli:
    def test_us_all_scans_us_pools_without_the_fundamental_score(self, capsys):
        eng = _MarketEngine(dates={"USMEGA": date(2026, 11, 10)})
        rc = run_scan.main(["--pool", "ALL", "--market", "US"], engine=eng)
        assert rc == 0
        assert [c["pool_code"] for c in eng.calls] == ["USMEGA"]
        assert eng.calls[0]["snapshot_date"] == date(2026, 11, 10)
        assert "fundamental_screener" not in eng.calls[0]["strategy_ids"]
        assert "envelope_200dma" in eng.calls[0]["strategy_ids"]

    def test_single_us_pool_infers_its_market(self, capsys):
        eng = _MarketEngine(dates={"USMEGA": date(2026, 11, 10)})
        run_scan.main(["--pool", "USMEGA"], engine=eng)
        assert "fundamental_screener" not in eng.calls[0]["strategy_ids"]

    def test_each_pool_is_scanned_on_its_own_newest_session(self, capsys):
        # The table's newest date (the 11th) is a day only the US traded.
        eng = _MarketEngine(dates={"F40": date(2026, 11, 10), "E40": date(2026, 11, 10),
                                   "S200": date(2026, 11, 10), "PlayArea": None,
                                   "USMEGA": date(2026, 11, 11)})
        rc = run_scan.main(["--pool", "ALL"], engine=eng)
        assert rc == 0
        assert [(c["pool_code"], c["snapshot_date"]) for c in eng.calls] == [
            ("F40", date(2026, 11, 10)), ("E40", date(2026, 11, 10)),
            ("S200", date(2026, 11, 10))]
        assert eng.calls[0]["strategy_ids"] is None        # India: every strategy, as before

    def test_us_all_without_pools_is_an_error(self, capsys):
        eng = _MarketEngine(dates={"F40": date(2026, 11, 10)}, us_pools=())
        assert run_scan.main(["--pool", "ALL", "--market", "US"], engine=eng) == 2

    def test_strategies_for_market(self):
        assert run_scan.strategies_for_market("IN") is None
        assert run_scan.strategies_for_market("US") == [
            "envelope_200dma", "week52_high_low", "rally_20_percent"]


# ---------------------------------------------------------------------------
# Read API — newest session per pool
# ---------------------------------------------------------------------------
class TestLatestDatePerPool:
    def _db(self):
        return FakeDB({
            "pools": [{"code": "F40", "display_order": 10},
                      {"code": "USMEGA", "display_order": 110, "market": "US"}],
            "stocks": [_stock("TCS.NS", ["F40"]), _stock("NVDA", ["USMEGA"], exchange="NASDAQ")],
            "daily_snapshots": [
                {"symbol": "TCS.NS", "snapshot_date": "2026-11-11", "close": 1},
                {"symbol": "TCS.NS", "snapshot_date": "2026-11-10", "close": 2},
                {"symbol": "NVDA", "snapshot_date": "2026-11-10", "close": 3},
            ],
        })

    def test_each_market_gets_its_own_latest_date(self):
        db = self._db()
        assert repository.latest_snapshot_date_for(["TCS.NS"], client=db) == "2026-11-11"
        assert repository.latest_snapshot_date_for(["NVDA"], client=db) == "2026-11-10"
        assert repository.latest_snapshot_date_for([], client=db) is None

    def test_us_pool_is_not_empty_after_an_indian_sync(self):
        rows = repository.snapshots_for_pool("USMEGA", client=self._db())
        assert [(r["symbol"], r["snapshot_date"]) for r in rows] == [("NVDA", "2026-11-10")]

    def test_indian_pool_still_reads_its_newest_session(self):
        rows = repository.snapshots_for_pool("F40", client=self._db())
        assert [(r["symbol"], r["snapshot_date"]) for r in rows] == [("TCS.NS", "2026-11-11")]

    def test_pools_route_reports_market(self):
        pools = repository.list_pools(client=self._db())
        assert [markets.pool_market(p) for p in pools] == ["IN", "US"]


# ---------------------------------------------------------------------------
# Universe API
# ---------------------------------------------------------------------------
class TestUniverseHelpers:
    def test_parse_us_symbol_list_reads_tradingview_prefixes(self):
        syms, rejects, hints = parse_us_symbol_list("NASDAQ:SNDK, NYSE:CAT\nnvda; BRK.B, 12345, NASDAQ:SNDK")
        assert syms == ["SNDK", "CAT", "NVDA", "BRK-B"]
        assert rejects == ["12345"]
        assert hints == {"SNDK": "NASDAQ", "CAT": "NYSE"}

    def test_fields_from_info_us_has_exchange_but_no_cap_or_group(self):
        info = {"longName": "Sandisk Corporation", "sector": "Technology",
                "industry": "Computer Hardware", "marketCap": 1.2e11, "exchange": "NMS"}
        assert fields_from_info(info, "US") == {
            "name": "Sandisk Corporation", "sector": "Technology",
            "industry": "Computer Hardware", "exchange": "NASDAQ"}
        assert "cap_type_manual" in fields_from_info(info)     # India unchanged

    def test_needs_enrichment_ignores_indian_only_columns_for_us(self):
        row = {"name": "X", "sector": "Y", "industry": "Z"}
        assert needs_enrichment(row, "US") is False
        assert needs_enrichment(row) is True

    def test_import_rows_us(self):
        rows, rejects = parse_import_rows(
            [{"symbol": "nvda", "name": "NVIDIA", "exchange": "nasdaq", "cap": "Large"},
             {"symbol": "TCS.NS"}], "US")
        assert rows == [{"symbol": "NVDA", "exchange": "NASDAQ", "name": "NVIDIA"}]
        assert rejects == [{"symbol": "TCS.NS", "reason": "not a valid US ticker"}]

    def test_stored_symbol(self):
        assert stored_symbol("nvda") == "NVDA"
        assert stored_symbol("tcs.ns") == "TCS.NS"


def _fake_fetch_info(symbol):
    data = {
        "SNDK": {"longName": "Sandisk Corporation", "sector": "Technology",
                 "industry": "Computer Hardware", "exchange": "NMS", "marketCap": 1.2e11},
        "CAT": {"longName": "Caterpillar Inc.", "sector": "Industrials",
                "industry": "Farm & Heavy Construction Machinery", "exchange": "NYQ"},
    }
    if symbol in data:
        return Result.success(data[symbol], symbol=symbol)
    return Result.failure("not found", symbol=symbol)


@pytest.fixture
def db():
    return FakeDB({
        "pools": [
            {"code": "F40", "name": "Flagship 40", "display_order": 10, "metadata": {}},
            {"code": "USMEGA", "name": "US Mega Cap", "display_order": 110,
             "metadata": {}, "market": "US"},
        ],
        "stocks": [_stock("TCS.NS", ["F40"]),
                   _stock("NVDA", ["USMEGA"], exchange="NASDAQ", name="NVIDIA Corporation")],
        "journal_trades": [], "journal_opportunities": [], "universe_syncs": [],
    })


@pytest.fixture
def client(db):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from plutus.api import create_app
    return TestClient(create_app(supabase_client=db, fetch_info=_fake_fetch_info))


def _row(db, sym):
    return next((r for r in db.tables["stocks"] if r["symbol"] == sym), None)


class TestUniverseRoutesUs:
    def test_us_pool_is_editable(self, client):
        body = client.get("/api/universe").json()
        assert "USMEGA" in body["editable_pools"] and "F40" in body["editable_pools"]

    def test_add_member_keeps_the_plain_ticker(self, client, db):
        r = client.post("/api/universe/pools/USMEGA/members",
                        json={"symbol": "cat", "exchange": "NYSE"})
        assert r.status_code == 200, r.text
        row = _row(db, "CAT")
        assert row["exchange"] == "NYSE" and row["pools"] == ["USMEGA"]
        assert _row(db, "CAT.NS") is None

    def test_same_ticker_in_an_indian_pool_is_still_indian(self, client, db):
        r = client.post("/api/universe/pools/F40/members", json={"symbol": "CAT"})
        assert r.status_code == 200 and _row(db, "CAT.NS")["exchange"] == "NSE"

    def test_indian_symbol_is_refused_in_a_us_pool(self, client):
        r = client.post("/api/universe/pools/USMEGA/members", json={"symbol": "TCS.NS"})
        assert r.status_code == 400

    def test_remove_and_edit_a_us_stock(self, client, db):
        r = client.put("/api/universe/stocks/NVDA", json={"sector": "Technology"})
        assert r.status_code == 200 and _row(db, "NVDA")["sector"] == "Technology"
        r = client.delete("/api/universe/pools/USMEGA/members/NVDA")
        assert r.status_code == 200 and r.json()["retired"] is True

    def test_edit_by_bare_indian_symbol_still_works(self, client, db):
        r = client.put("/api/universe/stocks/TCS", json={"sector": "IT"})
        assert r.status_code == 200 and _row(db, "TCS.NS")["sector"] == "IT"

    def test_paste_tradingview_list(self, client, db):
        r = client.post("/api/universe/pools/USMEGA/paste",
                        json={"text": "NASDAQ:SNDK, NYSE:CAT, NYSE:ZZZZ"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["fetched"] == 2 and body["failed"] == 1
        sndk = _row(db, "SNDK")
        assert sndk["exchange"] == "NASDAQ" and sndk["name"] == "Sandisk Corporation"
        assert not sndk.get("cap_type_manual") and not sndk.get("sector_group")
        assert _row(db, "CAT")["exchange"] == "NYSE"
        assert _row(db, "ZZZZ")["exchange"] == "NYSE"       # lookup failed — prefix hint used


# ---------------------------------------------------------------------------
# Trigger API + migration
# ---------------------------------------------------------------------------
class TestTriggerUs:
    def test_daily_us_accepts_us_tickers_and_pools(self):
        out = admin_trigger.validate_trigger_payload(
            {"workflow": "daily_us", "pool": "USMEGA"})
        assert out == {"workflow": "daily_us", "inputs": {"pool": "USMEGA"}}
        out = admin_trigger.validate_trigger_payload(
            {"workflow": "daily_us", "symbols": ["nvda", "BRK-B"]})
        assert out["inputs"] == {"symbols": "NVDA,BRK-B"}
        assert admin_trigger.WORKFLOWS["daily_us"] == "plutus-daily-sync-us.yml"

    @pytest.mark.parametrize("payload", [
        {"workflow": "daily_us", "pool": "F40"},
        {"workflow": "daily_us", "pool": "US MEGA; rm"},
        {"workflow": "daily_us", "symbols": ["TCS.NS"]},
        {"workflow": "daily", "symbols": ["NVDA"]},
        {"workflow": "daily", "pool": "USMEGA"},
    ])
    def test_markets_do_not_cross(self, payload):
        with pytest.raises(ValueError):
            admin_trigger.validate_trigger_payload(payload)


class TestMigration026:
    sql = MIGRATION.read_text(encoding="utf-8")

    def test_idempotent_and_defaults_to_in(self):
        assert "ADD COLUMN IF NOT EXISTS market VARCHAR(2) NOT NULL DEFAULT 'IN'" in self.sql
        assert "CHECK (market IN ('IN', 'US'))" in self.sql
        assert self.sql.count("ON CONFLICT") == 2
        assert "CREATE TABLE" not in self.sql and "DROP " not in self.sql

    def test_seeds_the_pool_and_17_plain_tickers(self):
        import re
        tickers = re.findall(r"^\s+\('([A-Z]+)',\s+'", self.sql, flags=re.M)
        assert tickers[0] == "USMEGA"
        assert len(tickers) == 18 and len(set(tickers)) == 18
        assert all(markets.canonical_symbol(t, "US") == t for t in tickers[1:])
        assert "'rally_20_percent'" in self.sql and "fundamental_screener" not in self.sql.split("INSERT INTO pools")[1]

    def test_us_workflow_exists_and_runs_the_us_market(self):
        wf = (MIGRATION.parents[2] / ".github" / "workflows" / "plutus-daily-sync-us.yml")
        text = wf.read_text(encoding="utf-8")
        assert 'cron: "0 23 * * 1-5"' in text
        jobs = text.split("jobs:")[1]
        assert jobs.count("--market US") == 2          # the sync step and the scan step
        assert "SCREENER_" not in jobs
