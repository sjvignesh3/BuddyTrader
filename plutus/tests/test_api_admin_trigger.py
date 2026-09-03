"""Tests for the on-demand GitHub Actions trigger routes.

Two layers:
  * validate_trigger_payload — pure function, no FastAPI needed.
  * route tests via TestClient with the GitHub seam monkeypatched, so no
    network and no real PAT is ever involved.
"""
from __future__ import annotations

import pytest

from plutus.api import admin_trigger
from plutus.api.admin_trigger import validate_trigger_payload


# ---------------------------------------------------------------------------
# validate_trigger_payload
# ---------------------------------------------------------------------------
class TestValidatePayload:
    def test_minimal_daily(self):
        out = validate_trigger_payload({"workflow": "daily"})
        assert out == {"workflow": "daily", "inputs": {}}

    def test_pool_all_normalised_to_blank(self):
        out = validate_trigger_payload({"workflow": "daily", "pool": "ALL"})
        assert out["inputs"] == {}
        out = validate_trigger_payload({"workflow": "daily", "pool": "all"})
        assert out["inputs"] == {}

    def test_named_pool_passes_through(self):
        out = validate_trigger_payload({"workflow": "quarterly", "pool": "F40"})
        assert out["inputs"] == {"pool": "F40"}

    def test_playarea_pool(self):
        out = validate_trigger_payload({"workflow": "daily", "pool": "PlayArea"})
        assert out["inputs"] == {"pool": "PlayArea"}

    def test_unknown_pool_rejected(self):
        with pytest.raises(ValueError, match="unknown pool"):
            validate_trigger_payload({"workflow": "daily", "pool": "XXX"})

    def test_unknown_workflow_rejected(self):
        with pytest.raises(ValueError, match="unknown workflow"):
            validate_trigger_payload({"workflow": "nope"})

    def test_symbols_upper_dedup_joined(self):
        out = validate_trigger_payload({
            "workflow": "daily",
            "symbols": ["tcs.ns", "TCS.NS", " infy.ns "],
        })
        assert out["inputs"]["symbols"] == "TCS.NS,INFY.NS"

    def test_symbols_ampersand_and_hyphen_ok(self):
        out = validate_trigger_payload({
            "workflow": "ratios",
            "symbols": ["M&M.NS", "BAJAJ-AUTO.NS"],
        })
        assert out["inputs"]["symbols"] == "M&M.NS,BAJAJ-AUTO.NS"

    def test_bad_symbol_rejected(self):
        with pytest.raises(ValueError, match="invalid symbols"):
            validate_trigger_payload({
                "workflow": "daily",
                "symbols": ["TCS"],  # no .NS/.BO suffix
            })
        with pytest.raises(ValueError, match="invalid symbols"):
            validate_trigger_payload({
                "workflow": "daily",
                "symbols": ["$(rm -rf).NS"],
            })

    def test_too_many_symbols_rejected(self):
        syms = [f"S{i}.NS" for i in range(admin_trigger.MAX_SYMBOLS + 1)]
        with pytest.raises(ValueError, match="too many symbols"):
            validate_trigger_payload({"workflow": "daily", "symbols": syms})

    def test_dry_run_and_limit(self):
        out = validate_trigger_payload({
            "workflow": "daily", "dry_run": True, "limit": "5",
        })
        assert out["inputs"] == {"dry_run": "true", "limit": "5"}

    def test_bad_limit_rejected(self):
        with pytest.raises(ValueError, match="limit"):
            validate_trigger_payload({"workflow": "daily", "limit": "x"})
        with pytest.raises(ValueError, match="limit"):
            validate_trigger_payload({"workflow": "daily", "limit": 0})


# ---------------------------------------------------------------------------
# Routes (FastAPI TestClient; GitHub seam faked)
# ---------------------------------------------------------------------------
fastapi = pytest.importorskip("fastapi")


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient

    from plutus.api import create_app

    monkeypatch.setenv("PLUTUS_GITHUB_TOKEN", "gh-test-token")
    monkeypatch.setenv("PLUTUS_GITHUB_REPO", "owner/repo")
    monkeypatch.setenv("PLUTUS_ADMIN_TOKEN", "s3cret")
    monkeypatch.setenv("PLUTUS_ENV", "prod")
    return TestClient(create_app(supabase_client=object()))


class TestStatus:
    def test_status_is_public(self, client):
        r = client.get("/api/admin/trigger/status")
        assert r.status_code == 200
        body = r.json()
        assert body["configured"] is True
        assert body["auth_required"] is True
        assert "daily" in body["workflows"]
        assert "PlayArea" in body["pools"]


class TestTrigger:
    def test_requires_token(self, client):
        r = client.post("/api/admin/trigger", json={"workflow": "daily"})
        assert r.status_code == 401

    def test_dispatches_with_token(self, client, monkeypatch):
        calls = []

        def fake_request(method, url, token, payload=None):
            calls.append((method, url, token, payload))
            return 204, None

        monkeypatch.setattr(admin_trigger, "_github_request", fake_request)
        r = client.post(
            "/api/admin/trigger",
            json={"workflow": "daily", "pool": "PlayArea",
                  "symbols": ["TCS.NS"]},
            headers={"X-Plutus-Admin-Token": "s3cret"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["queued"] is True
        assert body["file"] == "plutus-daily-sync.yml"
        method, url, token, payload = calls[0]
        assert method == "POST"
        assert url.endswith(
            "/repos/owner/repo/actions/workflows/plutus-daily-sync.yml/dispatches")
        assert token == "gh-test-token"
        assert payload == {"ref": "main",
                           "inputs": {"symbols": "TCS.NS", "pool": "PlayArea"}}

    def test_github_rejection_surfaces_502(self, client, monkeypatch):
        monkeypatch.setattr(
            admin_trigger, "_github_request",
            lambda *a, **k: (422, {"message": "Unexpected inputs"}))
        r = client.post(
            "/api/admin/trigger", json={"workflow": "daily"},
            headers={"X-Plutus-Admin-Token": "s3cret"})
        assert r.status_code == 502
        assert "Unexpected inputs" in r.json()["error"]

    def test_bad_payload_is_400(self, client):
        r = client.post(
            "/api/admin/trigger", json={"workflow": "daily", "pool": "XXX"},
            headers={"X-Plutus-Admin-Token": "s3cret"})
        assert r.status_code == 400

    def test_prod_without_admin_token_is_503(self, client, monkeypatch):
        monkeypatch.delenv("PLUTUS_ADMIN_TOKEN")
        r = client.post("/api/admin/trigger", json={"workflow": "daily"})
        assert r.status_code == 503

    def test_missing_github_config_is_503(self, client, monkeypatch):
        monkeypatch.delenv("PLUTUS_GITHUB_TOKEN")
        r = client.post(
            "/api/admin/trigger", json={"workflow": "daily"},
            headers={"X-Plutus-Admin-Token": "s3cret"})
        assert r.status_code == 503


class TestRuns:
    def test_lists_runs(self, client, monkeypatch):
        monkeypatch.setattr(
            admin_trigger, "_github_request",
            lambda *a, **k: (200, {"workflow_runs": [{
                "id": 1, "run_number": 7, "status": "in_progress",
                "conclusion": None, "event": "workflow_dispatch",
                "created_at": "2026-09-03T10:00:00Z",
                "html_url": "https://github.com/owner/repo/actions/runs/1",
            }]}))
        r = client.get(
            "/api/admin/trigger/runs?workflow=daily",
            headers={"X-Plutus-Admin-Token": "s3cret"})
        assert r.status_code == 200
        body = r.json()
        assert body["count"] == 1
        assert body["runs"][0]["status"] == "in_progress"

    def test_unknown_workflow_is_400(self, client):
        r = client.get(
            "/api/admin/trigger/runs?workflow=nope",
            headers={"X-Plutus-Admin-Token": "s3cret"})
        assert r.status_code == 400
