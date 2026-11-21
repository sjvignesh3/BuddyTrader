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

    def test_tradingview_form_us(self):
        assert ext.tv_symbol("NVDA", "NASDAQ") == "NASDAQ:NVDA"
        assert ext.tv_symbol("CAT", "NYSE") == "NYSE:CAT"
        assert ext.tv_symbol("BRK-B", "NYQ") == "NYSE:BRK.B"
        assert ext.tv_symbol("NVDA") == "NVDA"            # exchange unknown
        assert ext.tv_symbol("NVDA", "NSE") == "NVDA"     # never an Indian prefix
        e = ext.stock_entry({"symbol": "NVDA", "exchange": "NASDAQ", "pools": ["USMEGA"]}, None, [])
        assert e["tv"] == "NASDAQ:NVDA" and e["market"] == "US" and e["exchange"] == "NASDAQ"


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

    def test_funda_checks_keep_na_as_none(self):
        res = [{"strategy_id": "fundamental_screener", "metrics_snapshot": {"checks": [
            {"id": "a", "passed": True}, {"id": "b", "passed": False}, {"id": "c", "passed": None},
            {"id": "d", "passed": "yes"}, {"label": "no id"}]}}]
        assert ext.funda_checks(res) == {"a": True, "b": False, "c": None, "d": None}
        assert ext.funda_checks([{"strategy_id": "envelope_200dma"}]) is None
        assert ext.check_labels({"X": res}) == {}         # no labels in these checks

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

    def test_color_is_lowercase_hex_or_null(self):
        assert wl.clean_payload({"color": "#1E90FF"}) == {"color": "#1e90ff"}
        assert wl.clean_payload({"color": ""}) == {"color": None}
        assert wl.clean_payload({"color": None}) == {"color": None}
        for bad in ("1e90ff", "#fff", "#12345g", 12, "red"):
            with pytest.raises(ValueError):
                wl.clean_payload({"color": bad})

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
             "fall_from_ath_pct": Decimal("22.1"), "volume": 10,
             "market_cap": Decimal("12000000000000"), "revenue_ttm": Decimal("2500000000000"),
             "ebitda_ttm": Decimal("700000000000"), "pe_current": Decimal("22.50"),
             "pb_current": Decimal("9.00")},
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
             "metrics_snapshot": {"points": 9, "points_max": 11, "checks": [
                 {"id": "pe_lt_70", "label": "PE < 70", "passed": True, "detail": "PE 28"},
                 {"id": "roce", "label": "ROCE > 15%", "passed": False, "detail": "ROCE 12"},
                 {"id": "pledging", "label": "Pledge < 5%", "passed": None, "detail": "n/a"},
             ]}},
            # Older scan (lower id) — must lose to the newer OPPORTUNITY row above.
            {"id": 0, "scan_id": "s0", "symbol": "TCS.NS", "strategy_id": "envelope_200dma",
             "status": "BUY_ZONE", "score": Decimal("100"), "metrics_snapshot": {}},
        ],
        "fundamentals": [
            {"symbol": "TCS.NS", "quarter_end_date": "2026-06-30", "roce": Decimal("46.8"),
             "pe_median_3y": Decimal("28.00"), "pe_median_5y": Decimal("30.00"),
             "pe_median_10y": Decimal("25.00"), "pe_low_10y": Decimal("15.00"),
             "pe_high_10y": Decimal("45.00"), "pb_5y_avg": Decimal("12.0"),
             "operating_profit_ttm": Decimal("700000000000"), "depreciation_ttm": Decimal("50000000000"),
             "interest_ttm": Decimal("10000000000"), "borrowings": Decimal("350000000000")},
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
        # per-rule chips: pass / fail / n/a per check id, labels once at the top
        assert tcs["checks"] == {"pe_lt_70": True, "roce": False, "pledging": None}
        assert infy["checks"] is None                     # no fundamental scan yet
        assert body["check_labels"] == {"pe_lt_70": "PE < 70", "roce": "ROCE > 15%", "pledging": "Pledge < 5%"}
        assert body["pools"][0]["market"] == "IN"
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
        # derived valuation: Decimal on the server, strings on the wire, None when an input is missing
        d = body["derived"]
        assert d["ps"] == "4.80"                              # 12 T / 2.5 T
        assert d["mcap_to_ebitda"] == "17.1"
        assert d["pe_vs_median_3y"] == "0.80"                 # 22.5 / 28
        assert d["pe_vs_median_10y"] == "0.90"
        assert d["pe_range_position_pct"] == "25.0"           # (22.5 - 15) / (45 - 15)
        assert d["pb_vs_5y_avg"] == "0.75"
        assert d["interest_coverage"] == "65.0"               # (700 - 50) / 10
        assert d["debt_to_ebitda"] == "0.50"                  # 350 / 700
        assert d["no_interest_cost"] is False and d["zero_debt"] is False
        assert body["thresholds"]["valuation"]["ps_max"] == "3"
        assert body["thresholds"]["valuation"]["debt_ebitda_max"] == "2.5"
        assert body["fundamentals"]["pe_median_10y"] == "25.00"

    def test_derived_valuation_handles_missing_inputs(self):
        assert ext.derived_valuation(None, None) == {
            "ps": None, "mcap_to_ebitda": None, "interest_coverage": None, "no_interest_cost": False,
            "debt_to_ebitda": None, "zero_debt": False, "pe_vs_median_3y": None, "pe_vs_median_5y": None,
            "pe_vs_median_10y": None, "pe_range_position_pct": None, "pb_vs_5y_avg": None}
        d = ext.derived_valuation({"pe_current": "60", "market_cap": "100", "revenue_ttm": "0"},
                                  {"pe_low_10y": "10", "pe_high_10y": "50"})
        assert d["ps"] is None                                # zero denominator
        assert d["pe_range_position_pct"] == Decimal("100.0")  # clamped above the range
        # no interest cost / no debt are facts, not infinities
        d2 = ext.derived_valuation(None, {"operating_profit_ttm": "100", "depreciation_ttm": "10", "interest_ttm": "0", "borrowings": "0"})
        assert d2["interest_coverage"] is None and d2["no_interest_cost"] is True
        assert d2["debt_to_ebitda"] == Decimal("0.00") and d2["zero_debt"] is True
        d3 = ext.derived_valuation(None, {"operating_profit_ttm": "-5", "interest_ttm": "2", "borrowings": "10"})
        assert d3["debt_to_ebitda"] is None                   # negative EBITDA: ratio meaningless
        assert d3["interest_coverage"] == Decimal("-2.5")

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

    def test_color_round_trip_and_validation(self, client):
        r = client.post("/api/watchlists", json={"name": "Labels", "color": "#2962FF"})
        assert r.status_code == 200
        assert r.json()["watchlist"]["color"] == "#2962ff"
        wid = r.json()["watchlist"]["id"]
        r = client.put(f"/api/watchlists/{wid}", json={"color": ""})
        assert r.status_code == 200 and r.json()["watchlist"]["color"] is None
        assert client.put(f"/api/watchlists/{wid}", json={"color": "blue"}).status_code == 400
        assert client.post("/api/watchlists", json={"name": "X", "color": "#fff"}).status_code == 400

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
