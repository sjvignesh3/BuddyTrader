"""Unit tests for the Position Sizer routes + the journal's new stop_price
field — offline, reusing the writable fake Supabase from the expense tests."""
from __future__ import annotations

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from plutus.api import create_app  # noqa: E402
from plutus.api.sizing import validate_plan  # noqa: E402
from plutus.tests.test_api_expenses import WritableFake  # noqa: E402


@pytest.fixture
def fake():
    return WritableFake({
        "sizing_plans": [],
        "journal_opportunities": [],
        "journal_trades": [],
        "journal_settings": [{"id": 1, "capital": 300000}],
    })


@pytest.fixture
def client(fake):
    return TestClient(create_app(supabase_client=fake))


GOOD = {
    "symbol": "tcs", "cap_bucket": "Large", "capital": 300000, "risk_pct": 1,
    "entry": 450, "stop": 430, "qty": 150,
    "targets": [{"price": 500}, {"price": "550.50"}],
    "ladder": [{"trigger": 450, "qty": 50}, {"trigger": 430, "qty": 50}],
    "notes": "envelope re-entry",
}


class TestValidatePlan:
    def test_valid(self):
        assert validate_plan({**GOOD, "symbol": "TCS"}) is None

    @pytest.mark.parametrize("patch,needle", [
        ({"symbol": None}, "symbol"),
        ({"capital": 0}, "capital"),
        ({"capital": "abc"}, "capital"),
        ({"risk_pct": -1}, "risk_pct"),
        ({"entry": 0}, "entry"),
        ({"stop": 0}, "stop"),
        ({"stop": 450}, "below entry"),        # stop == entry
        ({"stop": 470}, "below entry"),        # stop above entry
        ({"qty": 0}, "qty"),
        ({"qty": "x"}, "qty"),
        ({"cap_bucket": "Mega"}, "cap_bucket"),
    ])
    def test_rejects(self, patch, needle):
        row = {**GOOD, "symbol": "TCS", **patch}
        msg = validate_plan(row)
        assert msg is not None and needle in msg


class TestPlans:
    def test_create_normalises_symbol_and_lists(self, client, fake):
        r = client.post("/api/sizing/plans", json=GOOD)
        assert r.status_code == 200, r.text
        plan = r.json()["plan"]
        assert plan["symbol"] == "TCS"
        # Prices inside JSONB are kept as strings (no float in the row).
        assert plan["targets"] == [{"price": "500"}, {"price": "550.50"}]
        assert plan["ladder"] == [{"trigger": "450", "qty": 50}, {"trigger": "430", "qty": 50}]
        r = client.get("/api/sizing/plans")
        assert r.json()["count"] == 1
        r = client.get("/api/sizing/plans?symbol=tcs")
        assert r.json()["count"] == 1
        assert client.get("/api/sizing/plans?symbol=INFY").json()["count"] == 0

    def test_create_drops_bad_targets_and_unknown_fields(self, client, fake):
        r = client.post("/api/sizing/plans", json={
            **GOOD, "targets": [{"price": -5}, "junk", {"price": 0}, {"price": 480}],
            "ladder": [{"trigger": 440, "qty": 0}, {"trigger": 440, "qty": "3"}],
            "risk_amount": 3000,           # derived — never stored
        })
        assert r.status_code == 200
        row = fake.tables["sizing_plans"][0]
        assert row["targets"] == [{"price": "480"}]
        assert row["ladder"] == [{"trigger": "440", "qty": 3}]
        assert "risk_amount" not in row

    def test_create_rejects_stop_above_entry(self, client):
        r = client.post("/api/sizing/plans", json={**GOOD, "stop": 460})
        assert r.status_code == 400
        assert "below entry" in r.json()["error"]

    def test_update_only_patchable_fields(self, client, fake):
        pid = client.post("/api/sizing/plans", json=GOOD).json()["plan"]["id"]
        r = client.put(f"/api/sizing/plans/{pid}", json={
            "notes": "converted", "opportunity_id": 7, "entry": 1,  # entry ignored
        })
        assert r.status_code == 200
        row = fake.tables["sizing_plans"][0]
        assert row["notes"] == "converted"
        assert row["opportunity_id"] == 7
        assert row["entry"] == 450
        assert client.put("/api/sizing/plans/999", json={"notes": "x"}).status_code == 404
        assert client.put(f"/api/sizing/plans/{pid}", json={"entry": 5}).status_code == 400

    def test_delete(self, client, fake):
        pid = client.post("/api/sizing/plans", json=GOOD).json()["plan"]["id"]
        assert client.delete(f"/api/sizing/plans/{pid}").status_code == 200
        assert fake.tables["sizing_plans"] == []


class TestJournalStopPrice:
    def test_opportunity_and_trade_accept_stop(self, client, fake):
        r = client.post("/api/journal/opportunities", json={
            "symbol": "TCS", "buy_price": 450, "qty": 10, "stop_price": 430,
        })
        assert r.status_code == 200
        assert str(r.json()["opportunity"]["stop_price"]) == "430"
        r = client.post("/api/journal/trades", json={
            "symbol": "TCS", "buy_date": "2026-09-01", "buy_price": 450,
            "qty": 10, "stop_price": "430.5",
        })
        assert r.status_code == 200
        assert r.json()["trade"]["stop_price"] == "430.5"

    def test_convert_carries_stop(self, client, fake):
        oid = client.post("/api/journal/opportunities", json={
            "symbol": "TCS", "buy_price": 450, "qty": 10, "stop_price": 430,
        }).json()["opportunity"]["id"]
        r = client.post(f"/api/journal/opportunities/{oid}/convert", json={})
        assert r.status_code == 200
        assert str(r.json()["trade"]["stop_price"]) == "430"
