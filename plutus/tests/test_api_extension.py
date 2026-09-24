"""Browser-extension routes: /api/extension/*, /api/strategy_configs and the
/api/watchlists CRUD. Offline — fake Supabase client, FastAPI TestClient."""
from __future__ import annotations

from decimal import Decimal

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from plutus.api import create_app  # noqa: E402
from plutus.api import extension as ext  # noqa: E402
from plutus.api import watchlists as wl  # noqa: E402
from plutus.tests.test_api_universe import FakeDB  # noqa: E402


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

class TestSymbols:
    def test_plain(self):
        assert ext.plain_symbol("TCS.NS") == "TCS"
        assert ext.plain_symbol("500325.BO") == "500325"
        assert ext.plain_symbol(" m&m.ns ") == "M&M"

    def test_tradingview_form(self):
        assert ext.tv_symbol("TCS.NS") == "NSE:TCS"
        assert ext.tv_symbol("M&M.NS") == "NSE:M_M"
        assert ext.tv_symbol("BAJAJ-AUTO.NS") == "NSE:BAJAJ_AUTO"
        assert ext.tv_symbol("500325.BO") == "BSE:500325"


class TestThresholds:
    def test_defaults_come_from_strategy_constants(self):
        t = ext.default_thresholds()
        assert t["fundamental"]["pe_max"] == Decimal("70")
        assert t["fundamental"]["roce_min"] == Decimal("15")
        assert t["fundamental"]["points_max"] == 11
        assert t["envelope"]["buy_zone_below_dma_pct"] == Decimal("14.0")
        assert t["ath_fall_pct_by_cap"]["Small"] == Decimal("40")
        assert t["pointers"]["public_holding_max_pct"] == Decimal("30")


class TestStockEntry:
    def test_best_status_and_points(self):
        results = [
            {"strategy_id": "envelope_200dma", "status": "OPPORTUNITY"},
            {"strategy_id": "week52_high_low", "status": "BUY_ZONE"},
            {"strategy_id": "fundamental_screener", "status": "PASS",
             "score": Decimal("9"), "metrics_snapshot": {"points": 9}},
        ]
        assert ext.best_technical_status(results) == "BUY_ZONE"
        assert ext.funda_points(results) == 9

    def test_funda_points_falls_back_to_score(self):
        assert ext.funda_points([{"strategy_id": "fundamental_screener",
                                  "score": Decimal("7")}]) == 7
        assert ext.funda_points([]) is None

    def test_entry_prefers_snapshot_cap_over_manual(self):
        stock = {"symbol": "TCS.NS", "name": "TCS", "pools": ["F40"],
                 "cap_type_manual": "Mid"}
        snap = {"cap_bucket": "Large", "close": Decimal("3500"),
                "below_200dma_pct": Decimal("-3.2"), "volume": 1}
        e = ext.stock_entry(stock, snap, [])
        assert e["cap"] == "Large"
        assert e["tv"] == "NSE:TCS"
        assert e["plain"] == "TCS"
        assert e["close"] == Decimal("3500")
        assert "volume" not in e            # only whitelisted snapshot keys
        assert e["best_status"] is None and e["funda_points"] is None

    def test_entry_without_snapshot_uses_manual_cap(self):
        e = ext.stock_entry({"symbol": "NEW.NS", "pools": [], "cap_type_manual": "Small"}, None, [])
        assert e["cap"] == "Small"
        assert "close" not in e


class TestWatchlistHelpers:
    def test_normalise_symbols_dedupes_and_canonicalises(self):
        assert wl.normalise_symbols(["tcs", "TCS.NS", "infy", "", None, "bad symbol!"]) \
            == ["TCS.NS", "INFY.NS"]

    def test_normalise_symbols_accepts_pasted_text(self):
        assert wl.normalise_symbols("TCS, INFY; M&M\nBAJAJ-AUTO") \
            == ["TCS.NS", "INFY.NS", "M&M.NS", "BAJAJ-AUTO.NS"]

    def test_clean_payload_rejects_blank_name(self):
        with pytest.raises(ValueError):
            wl.clean_payload({"name": "  "})
        assert wl.clean_payload({"junk": 1, "symbols": ["tcs"]}) == {"symbols": ["TCS.NS"]}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def _stock(sym, pools, **kw):
    base = {"id": kw.pop("id", 1), "symbol": sym, "name": sym.split(".")[0], "sector": "IT",
            "industry": "IT Svc", "exchange": "NSE", "active": True, "pools": list(pools),
            "cap_type_manual": None, "sector_group": "Normal", "metadata": {}}
    base.update(kw)
    return base


@pytest.fixture
def db():
    return FakeDB({
        "pools": [
            {"code": "F40", "name": "Flagship 40", "display_order": 10, "description": "",
             "strategies": [], "metadata": {}},
            {"code": "PlayArea", "name": "Play Area", "display_order": 40, "description": "",
             "strategies": [], "metadata": {}},
        ],
        "stocks": [
            _stock("TCS.NS", ["F40"], id=1),
            _stock("INFY.NS", ["F40", "PlayArea"], id=2, cap_type_manual="Large"),
            _stock("OLD.NS", ["F40"], id=3, active=False),
        ],
        "daily_snapshots": [
            {"symbol": "TCS.NS", "snapshot_date": "2026-09-22", "close": Decimal("3500.50"),
             "cap_bucket": "Large", "below_200dma_pct": Decimal("12.5"),
             "fall_from_ath_pct": Decimal("22.1"), "volume": 10},
            {"symbol": "INFY.NS", "snapshot_date": "2026-09-22", "close": Decimal("1500"),
             "cap_bucket": None, "below_200dma_pct": Decimal("-1"), "volume": 10},
            {"symbol": "TCS.NS", "snapshot_date": "2026-09-21", "close": Decimal("3400"),
             "cap_bucket": "Large", "volume": 10},
        ],
        "scan_results": [
            {"id": 1, "scan_id": "s1", "symbol": "TCS.NS", "strategy_id": "envelope_200dma",
             "status": "OPPORTUNITY", "score": Decimal("70"), "metrics_snapshot": {}},
            {"id": 2, "scan_id": "s1", "symbol": "TCS.NS", "strategy_id": "fundamental_screener",
             "status": "PASS", "score": Decimal("9"),
             "metrics_snapshot": {"points": 9, "points_max": 11, "checks": []}},
            # Older scan (lower id) — must lose to the newer OPPORTUNITY row above.
            {"id": 0, "scan_id": "s0", "symbol": "TCS.NS", "strategy_id": "envelope_200dma",
             "status": "BUY_ZONE", "score": Decimal("100"), "metrics_snapshot": {}},
        ],
        "fundamentals": [
            {"symbol": "TCS.NS", "quarter_end_date": "2026-06-30", "roce": Decimal("46.8")},
        ],
        "strategy_configs": [],
        "watchlists": [
            {"id": 1, "name": "S1", "symbols": ["TCS.NS"], "display_order": 10},
            {"id": 2, "name": "S2", "symbols": [], "display_order": 20},
        ],
    })


@pytest.fixture
def client(db, monkeypatch):
    monkeypatch.delenv("PLUTUS_APP_PASSWORD", raising=False)   # gate off (dev)
    monkeypatch.setenv("PLUTUS_ENV", "dev")
    return TestClient(create_app(supabase_client=db))


class TestBootstrap:
    def test_shape(self, client):
        r = client.get("/api/extension/bootstrap")
        assert r.status_code == 200
        body = r.json()
        assert body["version"] == ext.BOOTSTRAP_VERSION
        assert body["snapshot_date"] == "2026-09-22"
        assert [p["code"] for p in body["pools"]] == ["F40", "PlayArea"]
        assert body["pools"][0]["count"] == 2           # active F40 members only
        syms = {s["symbol"]: s for s in body["stocks"]}
        assert set(syms) == {"TCS.NS", "INFY.NS"}        # inactive excluded
        tcs = syms["TCS.NS"]
        assert tcs["tv"] == "NSE:TCS" and tcs["plain"] == "TCS"
        assert tcs["close"] == "3500.50"                  # money stays a string
        assert tcs["cap"] == "Large"
        assert tcs["best_status"] == "OPPORTUNITY"        # newest result wins over old BUY_ZONE
        assert tcs["funda_points"] == 9
        infy = syms["INFY.NS"]
        assert infy["cap"] == "Large"                     # manual fallback
        assert infy["best_status"] is None
        assert body["thresholds"]["fundamental"]["pe_max"] == "70"
        assert body["thresholds"]["ath_fall_pct_by_cap"]["Mid"] == "30"

    def test_include_inactive(self, client):
        r = client.get("/api/extension/bootstrap?include_inactive=true")
        assert {s["symbol"] for s in r.json()["stocks"]} == {"TCS.NS", "INFY.NS", "OLD.NS"}

    def test_is_open_read_even_when_gate_is_on(self, db, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "secret")
        c = TestClient(create_app(supabase_client=db))
        assert c.get("/api/extension/bootstrap").status_code == 200
        assert c.get("/api/strategy_configs").status_code == 200


class TestStock:
    def test_full_bundle(self, client):
        r = client.get("/api/extension/stock/tcs")
        assert r.status_code == 200
        body = r.json()
        assert body["symbol"] == "TCS.NS"
        assert body["in_universe"] is True
        assert body["snapshot"]["close"] == "3500.50"
        assert body["fundamentals"]["roce"] == "46.8"
        ids = {r["strategy_id"] for r in body["scan_results"]}
        assert ids == {"envelope_200dma", "fundamental_screener"}
        assert body["summary"]["funda_points"] == 9

    def test_unknown_symbol_404(self, client):
        assert client.get("/api/extension/stock/NOPE").status_code == 404

    def test_bad_symbol_400(self, client):
        assert client.get("/api/extension/stock/bad%20sym!").status_code == 400


class TestStrategyConfigs:
    def test_defaults_and_rows(self, client):
        body = client.get("/api/strategy_configs").json()
        assert body["defaults"]["fundamental"]["roce_min"] == "15"
        assert body["configs"] == []


class TestWatchlists:
    def test_list(self, client):
        body = client.get("/api/watchlists").json()
        assert [w["name"] for w in body["watchlists"]] == ["S1", "S2"]

    def test_create_and_conflict(self, client):
        r = client.post("/api/watchlists", json={"name": "Banks", "symbols": ["hdfcbank", "ICICIBANK.NS"]})
        assert r.status_code == 200
        w = r.json()["watchlist"]
        assert w["symbols"] == ["HDFCBANK.NS", "ICICIBANK.NS"]
        assert w["display_order"] == 30
        assert client.post("/api/watchlists", json={"name": "banks"}).status_code == 409
        assert client.post("/api/watchlists", json={"name": ""}).status_code == 400

    def test_add_and_remove_symbols(self, client):
        r = client.post("/api/watchlists/1/symbols", json={"symbol": "infy"})
        assert r.status_code == 200
        assert r.json()["watchlist"]["symbols"] == ["TCS.NS", "INFY.NS"]
        assert r.json()["added"] == ["INFY.NS"]
        # idempotent
        r = client.post("/api/watchlists/1/symbols", json={"symbols": ["INFY"]})
        assert r.json()["watchlist"]["symbols"] == ["TCS.NS", "INFY.NS"]
        assert r.json()["added"] == []
        r = client.delete("/api/watchlists/1/symbols/TCS")
        assert r.json()["watchlist"]["symbols"] == ["INFY.NS"]
        assert r.json()["removed"] == "TCS.NS"
        assert client.post("/api/watchlists/1/symbols", json={"symbols": []}).status_code == 400
        assert client.post("/api/watchlists/99/symbols", json={"symbol": "TCS"}).status_code == 404

    def test_rename_and_delete(self, client):
        r = client.put("/api/watchlists/2", json={"name": "Scratch", "junk": True})
        assert r.status_code == 200 and r.json()["watchlist"]["name"] == "Scratch"
        assert client.put("/api/watchlists/2", json={"name": "S1"}).status_code == 409
        assert client.put("/api/watchlists/2", json={}).status_code == 400
        assert client.delete("/api/watchlists/2").json() == {"deleted": 2}
        assert client.delete("/api/watchlists/2").status_code == 404

    def test_gated_when_password_set(self, db, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "secret")
        c = TestClient(create_app(supabase_client=db))
        assert c.get("/api/watchlists").status_code == 401
        tok = c.post("/api/auth/login", json={"password": "secret"}).json()["token"]
        assert c.get("/api/watchlists", headers={"X-Plutus-Auth": tok}).status_code == 200
