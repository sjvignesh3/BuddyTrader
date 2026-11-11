"""Trading Journal API — India unchanged, US rows kept apart (migration 027).

100% offline. The fake client is the Universe test's in-memory builder; it
enforces no constraints, so every rule checked here is the API's own.
"""
from __future__ import annotations

import re
from decimal import Decimal
from pathlib import Path

import pytest

from plutus.api.journal import (
    clean_qty, of_market, parse_qty, qty_wire, row_market, stamp_market,
)
from plutus.tests.test_api_universe import FakeDB, _stock

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "027_journal_markets.sql"


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------
class TestQty:
    @pytest.mark.parametrize("raw, expected", [
        (10, Decimal("10")), ("25", Decimal("25")), (10.0, Decimal("10.0")), ("1,000", Decimal("1000")),
    ])
    def test_india_takes_whole_numbers(self, raw, expected):
        assert parse_qty(raw) == expected

    @pytest.mark.parametrize("raw", [0.5, "2.25", 0, -1, "abc", None, True, float("nan")])
    def test_india_rejects_fractions_and_junk(self, raw):
        with pytest.raises(ValueError):
            parse_qty(raw)

    @pytest.mark.parametrize("raw, expected", [
        (0.5, Decimal("0.5")), ("2.2575", Decimal("2.2575")), (3, Decimal("3")),
    ])
    def test_us_takes_up_to_four_decimals(self, raw, expected):
        assert parse_qty(raw, "US") == expected

    @pytest.mark.parametrize("raw", ["0.12345", 0, -0.5, "x"])
    def test_us_rejects(self, raw):
        with pytest.raises(ValueError):
            parse_qty(raw, "US")

    def test_qty_always_leaves_as_a_number(self):
        assert qty_wire(10.0) == 10 and isinstance(qty_wire(10.0), int)
        assert qty_wire("10.0000") == 10 and isinstance(qty_wire("10.0000"), int)
        assert qty_wire(Decimal("2.2500")) == 2.25
        assert qty_wire(None) is None
        assert clean_qty({"qty": "5"}, "IN") == {"qty": 5}
        assert clean_qty({"symbol": "X"}, "IN") == {"symbol": "X"}


class TestMarketHelpers:
    def test_row_without_the_column_is_indian(self):
        assert row_market({"symbol": "TCS"}) == "IN"
        assert row_market({"symbol": "NVDA", "market": "US"}) == "US"
        assert row_market({"market": None}) == "IN"

    def test_filter(self):
        rows = [{"id": 1}, {"id": 2, "market": "US"}, {"id": 3, "market": "IN"}]
        assert [r["id"] for r in of_market(rows, "IN")] == [1, 3]
        assert [r["id"] for r in of_market(rows, "US")] == [2]

    def test_indian_inserts_never_name_the_column(self):
        # So the Indian journal keeps writing on a database without migration 027.
        assert stamp_market({"symbol": "TCS"}, "IN") == {"symbol": "TCS"}
        assert stamp_market({"symbol": "TCS", "market": "US"}, "IN") == {"symbol": "TCS"}
        assert stamp_market({"symbol": "NVDA"}, "US") == {"symbol": "NVDA", "market": "US"}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@pytest.fixture
def db():
    return FakeDB({
        "journal_settings": [{"id": 1, "capital": 300000}],
        "journal_opportunities": [], "journal_trades": [], "journal_stock_notes": [],
        "sizing_plans": [],
        "pools": [{"code": "F40", "display_order": 10, "metadata": {}},
                  {"code": "USMEGA", "display_order": 110, "metadata": {}, "market": "US"}],
        "stocks": [_stock("TCS.NS", ["F40"]), _stock("NVDA", [], exchange="NASDAQ"),
                   _stock("IDEA.NS", [])],
        "universe_syncs": [],
    })


@pytest.fixture
def client(db):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from plutus.api import create_app
    return TestClient(create_app(supabase_client=db))


def _trade(client, **over):
    # status is sent explicitly: the fake applies no column defaults.
    body = {"symbol": "tcs", "buy_date": "2026-11-01", "buy_price": "3500", "qty": 10,
            "status": "OPEN"}
    body.update(over)
    r = client.post("/api/journal/trades", json=body)
    assert r.status_code == 200, r.text
    return r.json()["trade"]


def _us_trade(client, **over):
    body = {"market": "US", "symbol": "nvda", "buy_price": "150", "qty": 2.5}
    body.update(over)
    return _trade(client, **body)


class TestIndiaUnchanged:
    def test_trade_roundtrip(self, client, db):
        t = _trade(client)
        assert t["symbol"] == "TCS" and t["qty"] == 10
        assert "market" not in db.tables["journal_trades"][0]      # never sent
        listed = client.get("/api/journal/trades").json()
        assert listed["count"] == 1 and listed["market"] == "IN"
        assert listed["trades"][0]["qty"] == 10

    def test_qty_is_a_number_even_when_the_db_returns_a_float(self, client, db):
        # NUMERIC(14,4) comes back from PostgREST as 10.0 — it must not turn
        # into the string "10.0" (the frontend ADDS quantities).
        db.tables["journal_trades"].append(
            {"id": 9, "symbol": "TCS", "buy_date": "2026-11-01", "buy_price": 3500.0,
             "qty": 10.0, "status": "OPEN"})
        t = client.get("/api/journal/trades").json()["trades"][0]
        assert t["qty"] == 10 and isinstance(t["qty"], int)
        assert t["buy_price"] == "3500.0"                           # money stays a string
        p = client.get("/api/journal/positions").json()["positions"][0]
        assert p == {"symbol": "TCS", "qty": 10, "invested": 35000.0,
                     "cap_bucket": None, "lots": 1}

    def test_fractional_qty_is_refused(self, client):
        r = client.post("/api/journal/trades", json={
            "symbol": "TCS", "buy_date": "2026-11-01", "buy_price": "3500", "qty": 1.5})
        assert r.status_code == 400 and "whole number" in r.json()["error"]

    def test_partial_close_splits_the_lot(self, client, db):
        t = _trade(client)
        r = client.post(f"/api/journal/trades/{t['id']}/close",
                        json={"sell_date": "2026-11-05", "sell_price": "3600", "qty": 4})
        body = r.json()
        assert r.status_code == 200, r.text
        assert body["closed"]["qty"] == 4 and body["closed"]["status"] == "CLOSED"
        assert body["remainder"]["qty"] == 6
        assert all("market" not in row for row in db.tables["journal_trades"])

    def test_close_guards(self, client):
        t = _trade(client)
        url = f"/api/journal/trades/{t['id']}/close"
        base = {"sell_date": "2026-11-05", "sell_price": "3600"}
        assert client.post(url, json={**base, "qty": 11}).status_code == 400
        assert client.post(url, json={**base, "qty": 2.5}).status_code == 400
        assert client.post(url, json=base).json()["closed"]["qty"] == 10
        assert client.post(url, json=base).status_code == 400       # no longer OPEN

    def test_capital(self, client, db):
        assert client.get("/api/journal/settings").json()["settings"]["capital"] == 300000
        r = client.put("/api/journal/settings", json={"capital": 500000})
        assert r.status_code == 200 and db.tables["journal_settings"][0]["capital"] == 500000
        assert "capital_usd" not in db.tables["journal_settings"][0]


class TestUsJournal:
    def test_fractional_trade_is_stored_as_us(self, client, db):
        t = _us_trade(client)
        assert t["symbol"] == "NVDA" and t["qty"] == 2.5 and t["market"] == "US"
        assert db.tables["journal_trades"][0]["market"] == "US"

    def test_markets_never_mix(self, client):
        _trade(client)
        _us_trade(client)
        _trade(client, symbol="IDEA", buy_price="10", qty=100)
        _us_trade(client, symbol="IDEA", buy_price="20", qty=1)     # same spelling, US ticker
        india = client.get("/api/journal/trades").json()
        us = client.get("/api/journal/trades?market=US").json()
        assert sorted(t["symbol"] for t in india["trades"]) == ["IDEA", "TCS"]
        assert sorted(t["symbol"] for t in us["trades"]) == ["IDEA", "NVDA"]
        assert us["market"] == "US"
        one = client.get("/api/journal/trades?market=US&symbol=idea").json()["trades"]
        assert len(one) == 1 and one[0]["buy_price"] == "20"

    def test_positions_are_per_market(self, client):
        _trade(client)
        _us_trade(client)
        _us_trade(client, qty=0.25, buy_price="160")
        us = client.get("/api/journal/positions?market=us").json()
        assert us["positions"] == [{"symbol": "NVDA", "qty": 2.75, "invested": 415.0,
                                    "cap_bucket": None, "lots": 2}]
        assert [p["symbol"] for p in client.get("/api/journal/positions").json()["positions"]] == ["TCS"]

    def test_partial_close_keeps_the_market_and_fractions(self, client, db):
        t = _us_trade(client)
        r = client.post(f"/api/journal/trades/{t['id']}/close",
                        json={"sell_date": "2026-11-05", "sell_price": "170", "qty": 0.75})
        body = r.json()
        assert r.status_code == 200, r.text
        assert body["closed"]["qty"] == 0.75 and body["closed"]["market"] == "US"
        assert body["remainder"]["qty"] == 1.75
        assert {row["market"] for row in db.tables["journal_trades"]} == {"US"}
        r = client.post(f"/api/journal/trades/{t['id']}/close",
                        json={"sell_date": "2026-11-05", "sell_price": "170", "qty": 5})
        assert r.status_code == 400

    def test_edit_validates_qty_against_the_rows_own_market(self, client):
        us, india = _us_trade(client), _trade(client)
        assert client.put(f"/api/journal/trades/{us['id']}", json={"qty": 1.125}).status_code == 200
        assert client.put(f"/api/journal/trades/{india['id']}", json={"qty": 1.5}).status_code == 400
        assert client.put(f"/api/journal/trades/{us['id']}", json={"qty": "1.23456"}).status_code == 400
        assert client.put("/api/journal/trades/999", json={"qty": 1}).status_code == 404

    def test_opportunity_converts_into_its_own_market(self, client, db):
        r = client.post("/api/journal/opportunities", json={
            "market": "US", "symbol": "nvda", "buy_price": "140", "qty": 1.5, "action_filter": "GTT"})
        opp = r.json()["opportunity"]
        assert r.status_code == 200 and opp["market"] == "US" and opp["qty"] == 1.5
        assert client.get("/api/journal/opportunities").json()["count"] == 0
        assert client.get("/api/journal/opportunities?market=US").json()["count"] == 1
        trade = client.post(f"/api/journal/opportunities/{opp['id']}/convert", json={}).json()["trade"]
        assert trade["market"] == "US" and trade["qty"] == 1.5 and trade["order_type"] == "GTT"

    def test_us_capital_is_separate(self, client, db):
        r = client.put("/api/journal/settings", json={"capital": 8000, "market": "US"})
        assert r.status_code == 200
        row = db.tables["journal_settings"][0]
        assert row["capital_usd"] == 8000 and row["capital"] == 300000
        assert client.get("/api/journal/settings").json()["settings"]["capital_usd"] == 8000

    def test_notes_are_per_market(self, client):
        client.post("/api/journal/notes", json={"symbol": "idea", "content": "India view"})
        client.post("/api/journal/notes", json={"symbol": "idea", "content": "US view", "market": "US"})
        assert [n["content"] for n in client.get("/api/journal/notes?symbol=IDEA").json()["notes"]] == ["India view"]
        assert [n["content"] for n in
                client.get("/api/journal/notes?symbol=IDEA&market=US").json()["notes"]] == ["US view"]

    def test_import_is_one_market(self, client, db):
        r = client.post("/api/journal/import", json={"market": "US", "trades": [
            {"symbol": "nvda", "buy_date": "2026-10-01", "buy_price": "120", "qty": "0.5"},
            {"symbol": "cat", "buy_date": "2026-10-02", "buy_price": "600", "qty": 1}]})
        assert r.status_code == 200 and r.json()["imported"]["trades"] == 2
        assert {t["market"] for t in db.tables["journal_trades"]} == {"US"}
        r = client.post("/api/journal/import", json={"trades": [
            {"symbol": "tcs", "buy_date": "2026-10-01", "buy_price": "3500", "qty": "0.5"}]})
        assert r.status_code == 400                                 # Indian fraction

    def test_bad_market_is_400(self, client):
        assert client.get("/api/journal/trades?market=UK").status_code == 400
        assert client.post("/api/journal/trades", json={
            "market": "UK", "symbol": "X", "buy_date": "2026-11-01",
            "buy_price": "1", "qty": 1}).status_code == 400

    def test_sizing_plans_are_per_market(self, client, db):
        plan = {"symbol": "nvda", "capital": "8000", "risk_pct": "1", "entry": "150",
                "stop": "140", "qty": 8}
        assert client.post("/api/sizing/plans", json={**plan, "market": "US"}).status_code == 200
        assert client.post("/api/sizing/plans", json={**plan, "symbol": "tcs"}).status_code == 200
        assert db.tables["sizing_plans"][0]["market"] == "US"
        assert "market" not in db.tables["sizing_plans"][1]
        assert [p["symbol"] for p in client.get("/api/sizing/plans?market=US").json()["plans"]] == ["NVDA"]
        assert [p["symbol"] for p in client.get("/api/sizing/plans").json()["plans"]] == ["TCS"]

    def test_universe_keeps_a_held_us_stock_and_ignores_a_same_named_indian_trade(self, client, db):
        # An INDIAN open trade in 'NVDA' must not pin the US stock NVDA...
        _trade(client, symbol="NVDA", buy_price="10", qty=1)
        db.tables["stocks"][1]["pools"] = ["USMEGA"]
        r = client.delete("/api/universe/pools/USMEGA/members/NVDA")
        assert r.status_code == 200 and r.json()["retired"] is True
        # ...but a US open trade does.
        db.tables["stocks"][1].update({"pools": ["USMEGA"], "active": True})
        _us_trade(client)
        r = client.delete("/api/universe/pools/USMEGA/members/NVDA")
        assert r.status_code == 200 and r.json()["retired"] is False
        refs = client.get("/api/universe").json()["journal_refs"]
        assert refs["US:NVDA"]["open_trades"] == 1 and refs["NVDA"]["open_trades"] == 1


# ---------------------------------------------------------------------------
# Migration 027
# ---------------------------------------------------------------------------
class TestMigration027:
    sql = MIGRATION.read_text(encoding="utf-8")

    def test_every_journal_table_gets_a_market_defaulting_to_in(self):
        for table in ("journal_opportunities", "journal_trades", "journal_stock_notes",
                      "sizing_plans"):
            assert re.search(
                rf"ALTER TABLE {table}\s+ADD COLUMN IF NOT EXISTS market VARCHAR\(2\) "
                r"NOT NULL DEFAULT 'IN'", self.sql), table
            assert f"{table}_market_check" in self.sql

    def test_fractional_qty_only_for_us(self):
        for table in ("journal_opportunities", "journal_trades"):
            assert f"ALTER TABLE {table}" in self.sql
            assert re.search(rf"ALTER TABLE {table}\s+ALTER COLUMN qty TYPE NUMERIC\(14,4\)", self.sql)
        assert "CHECK (market <> 'IN' OR qty = trunc(qty))" in self.sql

    def test_us_capital_is_its_own_nullable_column(self):
        assert "ADD COLUMN IF NOT EXISTS capital_usd NUMERIC(14,2)" in self.sql
        assert "capital_usd IS NULL OR capital_usd > 0" in self.sql

    def test_conventions(self):
        low = self.sql.lower()
        assert "to anon" not in low and "to public" not in low
        code = "\n".join(line.split("--")[0] for line in self.sql.splitlines())
        for banned in ("FLOAT", "REAL", "DOUBLE PRECISION"):
            assert not re.search(rf"\b{banned}\b", code, re.IGNORECASE)
        assert "CREATE TABLE" not in code and "DROP " not in code
        readme = (MIGRATION.parent / "README.md").read_text(encoding="utf-8")
        assert "027_journal_markets.sql" in readme
