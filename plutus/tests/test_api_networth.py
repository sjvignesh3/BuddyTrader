"""Unit tests for the Net Worth routes — offline, writable fake Supabase."""
from __future__ import annotations

from datetime import date

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from plutus.api import create_app  # noqa: E402
from plutus.api.networth import (  # noqa: E402
    month_start, validate_asset, validate_liability, validate_snapshot,
)
from plutus.tests.test_api_expenses import WritableFake  # noqa: E402


@pytest.fixture
def fake():
    return WritableFake({
        "networth_assets": [],
        "networth_liabilities": [],
        "networth_snapshots": [],
        "networth_income": [],
        "networth_milestones": [],
        "networth_settings": [{"id": 1, "ff_target_corpus": None,
                               "ff_real_return_pct": 6, "ff_monthly_savings": None}],
    })


@pytest.fixture
def client(fake):
    return TestClient(create_app(supabase_client=fake))


# ---------------------------------------------------------------------------
# Pure validators
# ---------------------------------------------------------------------------

class TestValidators:
    def test_month_start(self):
        assert month_start("2026-09-17") == "2026-09-01"
        assert month_start("2026-09") == "2026-09-01"
        assert month_start("2026-09-17T10:00:00") == "2026-09-01"
        assert month_start("nope") is None
        today = date.today()
        assert month_start(None) == date(today.year, today.month, 1).isoformat()

    def test_asset(self):
        ok = {"name": "HDFC savings", "asset_class": "Cash", "current_value": 50000}
        assert validate_asset(ok, partial=False) is None
        assert "name" in validate_asset({**ok, "name": None}, partial=False)
        assert "asset_class" in validate_asset({**ok, "asset_class": "Stocks"}, partial=False)
        assert "current_value" in validate_asset({**ok, "current_value": -1}, partial=False)
        assert "cost_basis" in validate_asset({**ok, "cost_basis": "x"}, partial=False)
        # partial update: only validate what is present
        assert validate_asset({"current_value": 10}, partial=True) is None
        assert validate_asset({"asset_class": "Gold"}, partial=True) is None
        assert "asset_class" in validate_asset({"asset_class": "Nope"}, partial=True)

    def test_liability(self):
        ok = {"name": "Car", "kind": "Car Loan", "outstanding": 250000, "emi": 8000}
        assert validate_liability(ok, partial=False) is None
        assert "kind" in validate_liability({**ok, "kind": "Mortgage"}, partial=False)
        assert "outstanding" in validate_liability({"name": "x", "kind": "Other"}, partial=False)
        assert "emi" in validate_liability({**ok, "emi": -1}, partial=False)

    def test_snapshot_must_be_self_consistent(self):
        good = {"equity_value": "100", "assets_value": "50", "liabilities_value": "30",
                "net_worth": "120"}
        assert validate_snapshot(good) is None
        assert "net_worth must equal" in validate_snapshot({**good, "net_worth": "130"})
        assert "equity_value" in validate_snapshot({**good, "equity_value": None})
        assert "breakdown" in validate_snapshot({**good, "breakdown": []})


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

class TestAssets:
    def test_crud_and_archive_filter(self, client, fake):
        r = client.post("/api/networth/assets", json={
            "name": "HDFC savings", "asset_class": "Cash", "current_value": 50000,
            "evil": "x",
        })
        assert r.status_code == 200, r.text
        aid = r.json()["asset"]["id"]
        assert "evil" not in fake.tables["networth_assets"][0]
        r = client.put(f"/api/networth/assets/{aid}", json={"current_value": 55000})
        assert r.status_code == 200
        assert str(r.json()["asset"]["current_value"]) == "55000"
        # archive → hidden by default, visible with include_archived
        client.put(f"/api/networth/assets/{aid}", json={"archived": True})
        assert client.get("/api/networth/assets").json()["count"] == 0
        assert client.get("/api/networth/assets?include_archived=true").json()["count"] == 1
        assert client.put("/api/networth/assets/999", json={"notes": "x"}).status_code == 404
        assert client.delete(f"/api/networth/assets/{aid}").status_code == 200
        assert fake.tables["networth_assets"] == []

    def test_validation_errors(self, client):
        assert client.post("/api/networth/assets", json={"asset_class": "Cash",
                                                        "current_value": 1}).status_code == 400
        assert client.post("/api/networth/assets", json={"name": "x", "asset_class": "Zzz",
                                                        "current_value": 1}).status_code == 400
        assert client.post("/api/networth/assets", json={"name": "x", "asset_class": "Cash",
                                                        "current_value": -5}).status_code == 400


class TestLiabilities:
    def test_crud(self, client, fake):
        r = client.post("/api/networth/liabilities", json={
            "name": "Car loan", "kind": "Car Loan", "outstanding": 250000,
            "interest_rate": 9.5, "emi": 8000,
        })
        assert r.status_code == 200, r.text
        lid = r.json()["liability"]["id"]
        r = client.put(f"/api/networth/liabilities/{lid}", json={"outstanding": 240000})
        assert str(r.json()["liability"]["outstanding"]) == "240000"
        assert client.post("/api/networth/liabilities",
                           json={"name": "x", "kind": "Loan", "outstanding": 1}).status_code == 400
        assert client.delete(f"/api/networth/liabilities/{lid}").status_code == 200


class TestSnapshots:
    BODY = {"snapshot_date": "2026-09-17", "equity_value": "250000",
            "assets_value": "400000", "liabilities_value": "100000",
            "net_worth": "550000", "breakdown": {"equity": "250000",
                                                 "assets": {"Cash": "400000"}}}

    def test_snapshot_is_idempotent_per_month(self, client, fake):
        r = client.post("/api/networth/snapshots", json=self.BODY)
        assert r.status_code == 200, r.text
        assert r.json()["replaced"] is False
        assert r.json()["snapshot"]["snapshot_date"] == "2026-09-01"
        # Same month, new numbers → replaces the row rather than adding one.
        r = client.post("/api/networth/snapshots", json={
            **self.BODY, "snapshot_date": "2026-09-30", "equity_value": "260000",
            "net_worth": "560000"})
        assert r.status_code == 200
        assert r.json()["replaced"] is True
        assert len(fake.tables["networth_snapshots"]) == 1
        assert str(fake.tables["networth_snapshots"][0]["net_worth"]) == "560000"
        # A different month is a new row; list is newest first.
        client.post("/api/networth/snapshots", json={**self.BODY, "snapshot_date": "2026-10-05"})
        rows = client.get("/api/networth/snapshots").json()["snapshots"]
        assert [s["snapshot_date"] for s in rows] == ["2026-10-01", "2026-09-01"]

    def test_snapshot_rejects_inconsistent_total(self, client):
        r = client.post("/api/networth/snapshots", json={**self.BODY, "net_worth": "1"})
        assert r.status_code == 400
        assert "must equal" in r.json()["error"]

    def test_snapshot_rejects_bad_date(self, client):
        r = client.post("/api/networth/snapshots", json={**self.BODY, "snapshot_date": "soon"})
        assert r.status_code == 400

    def test_delete(self, client, fake):
        sid = client.post("/api/networth/snapshots", json=self.BODY).json()["snapshot"]["id"]
        assert client.delete(f"/api/networth/snapshots/{sid}").status_code == 200
        assert fake.tables["networth_snapshots"] == []


class TestIncome:
    def test_upsert_by_month(self, client, fake):
        r = client.post("/api/networth/income", json={"month": "2026-09", "amount": 120000})
        assert r.status_code == 200, r.text
        assert r.json()["income"]["month"] == "2026-09-01"
        client.post("/api/networth/income", json={"month": "2026-09-20", "amount": 125000})
        assert len(fake.tables["networth_income"]) == 1
        assert str(fake.tables["networth_income"][0]["amount"]) == "125000"
        assert client.post("/api/networth/income", json={"month": "2026-09"}).status_code == 400
        assert client.post("/api/networth/income",
                           json={"month": "2026-09", "amount": -1}).status_code == 400


class TestMilestonesAndSettings:
    def test_milestones(self, client, fake):
        r = client.post("/api/networth/milestones", json={"target": 2500000})
        assert r.status_code == 200
        mid = r.json()["milestone"]["id"]
        assert r.json()["milestone"]["label"]          # auto label when blank
        client.post("/api/networth/milestones", json={"label": "₹10L", "target": 1000000})
        rows = client.get("/api/networth/milestones").json()["milestones"]
        assert [str(m["target"]) for m in rows] == ["1000000", "2500000"]  # ascending
        r = client.put(f"/api/networth/milestones/{mid}", json={"achieved_on": "2026-09-01"})
        assert r.status_code == 200
        assert client.post("/api/networth/milestones", json={"target": 0}).status_code == 400
        assert client.put(f"/api/networth/milestones/{mid}", json={"target": -5}).status_code == 400
        assert client.delete(f"/api/networth/milestones/{mid}").status_code == 200

    def test_settings_roundtrip(self, client, fake):
        r = client.get("/api/networth/settings")
        assert r.status_code == 200
        assert str(r.json()["settings"]["ff_real_return_pct"]) == "6"
        r = client.put("/api/networth/settings",
                       json={"ff_target_corpus": 30000000, "ff_real_return_pct": 5, "junk": 1})
        assert r.status_code == 200
        assert str(r.json()["settings"]["ff_target_corpus"]) == "30000000"
        assert "junk" not in fake.tables["networth_settings"][0]
        assert client.put("/api/networth/settings", json={}).status_code == 400
        assert client.put("/api/networth/settings",
                          json={"ff_real_return_pct": -1}).status_code == 400

    def test_settings_seeds_missing_row(self, fake):
        fake.tables["networth_settings"] = []
        c = TestClient(create_app(supabase_client=fake))
        r = c.get("/api/networth/settings")
        assert r.status_code == 200
        assert len(fake.tables["networth_settings"]) == 1
