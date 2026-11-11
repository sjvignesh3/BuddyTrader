"""Notes page API — /api/journal/notebook (migration 025)."""
from __future__ import annotations

import pytest

from plutus.api.notebook import clean_item, finalise
from plutus.tests.test_api_ipo import FakeDB

URL = "/api/journal/notebook"


class TestClean:
    def test_whitelist_and_normalise(self):
        out = clean_item({"kind": "task", "title": "  Call broker ", "market": "us",
                          "symbol": " nvda ", "due_date": "2026-11-20T10:00:00",
                          "done": False, "id": 99, "junk": 1})
        assert out == {"kind": "TASK", "title": "Call broker", "market": "US",
                       "symbol": "NVDA", "due_date": "2026-11-20", "done": False}

    def test_blank_clears_optional_fields(self):
        out = clean_item({"body": "  ", "market": "", "symbol": "", "due_date": ""})
        assert out == {"body": None, "market": None, "symbol": None, "due_date": None}

    @pytest.mark.parametrize("payload, needle", [
        ({"kind": "IDEA"}, "kind"),
        ({"title": "   "}, "title is required"),
        ({"title": "x" * 201}, "longer than 200"),
        ({"market": "UK"}, "market"),
        ({"symbol": "TATA MOTORS"}, "not a valid ticker"),
        ({"due_date": "20 Nov"}, "due_date"),
        ({"done": "yes"}, "done must be true or false"),
    ])
    def test_bad_values(self, payload, needle):
        with pytest.raises(ValueError, match=needle):
            clean_item(payload)

    def test_finalise_defaults_and_nse_suffix(self):
        assert finalise({"title": "A"})["kind"] == "NOTE"
        assert finalise({"title": "A", "market": "IN", "symbol": "TCS.NS"})["symbol"] == "TCS"
        # A US ticker keeps its dot (BRK.B); only IN drops the exchange suffix.
        assert finalise({"title": "A", "market": "US", "symbol": "BRK.B"})["symbol"] == "BRK.B"
        with pytest.raises(ValueError, match="title is required"):
            finalise({"kind": "TASK"})


@pytest.fixture
def db():
    return FakeDB()


@pytest.fixture
def client(db):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from plutus.api import create_app
    return TestClient(create_app(supabase_client=db))


def _create(client, **over):
    body = {"kind": "TASK", "title": "Daily tasks update"}
    body.update(over)
    r = client.post(URL, json=body)
    assert r.status_code == 200, r.text
    return r.json()["item"]


class TestRoutes:
    def test_create_list_roundtrip(self, client):
        _create(client)
        _create(client, kind="WATCH", title="Wait for pullback", market="US", symbol="nvda")
        listed = client.get(URL).json()
        assert listed["count"] == 2
        newest = listed["items"][0]
        assert newest["kind"] == "WATCH" and newest["symbol"] == "NVDA"

    def test_kind_defaults_to_note(self, client):
        r = client.post(URL, json={"title": "Just a thought"})
        assert r.status_code == 200 and r.json()["item"]["kind"] == "NOTE"

    def test_bad_input_is_400_not_502(self, client, db):
        r = client.post(URL, json={"kind": "TASK"})
        assert r.status_code == 400 and "title" in r.json()["error"]
        assert db.tables.get("notebook_items", []) == []

    def test_update_toggles_and_clears(self, client, db):
        item = _create(client, due_date="2026-11-30", market="IN", symbol="HDFCBANK")
        r = client.put(f"{URL}/{item['id']}", json={"done": True, "pinned": True,
                                                   "due_date": ""})
        assert r.status_code == 200, r.text
        row = db.tables["notebook_items"][0]
        assert row["done"] is True and row["pinned"] is True and row["due_date"] is None
        assert row["symbol"] == "HDFCBANK" and row["title"] == "Daily tasks update"

    def test_update_strips_nse_suffix_when_market_becomes_in(self, client, db):
        item = _create(client, market="US", symbol="TCS.NS")
        assert item["symbol"] == "TCS.NS"
        r = client.put(f"{URL}/{item['id']}", json={"market": "IN"})
        assert r.status_code == 200 and db.tables["notebook_items"][0]["symbol"] == "TCS"

    def test_update_guards(self, client):
        item = _create(client)
        assert client.put(f"{URL}/{item['id']}", json={"junk": 1}).status_code == 400
        assert client.put(f"{URL}/{item['id']}", json={"title": ""}).status_code == 400
        assert client.put(f"{URL}/9999", json={"done": True}).status_code == 404

    def test_delete(self, client, db):
        item = _create(client)
        assert client.delete(f"{URL}/{item['id']}").json() == {"deleted": item["id"]}
        assert db.tables["notebook_items"] == []
        assert client.delete(f"{URL}/{item['id']}").status_code == 404
