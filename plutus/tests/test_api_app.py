"""End-to-end route tests for the FastAPI app using TestClient.

Skipped automatically when FastAPI is not installed (minimal CI envs).
"""
from __future__ import annotations

from decimal import Decimal

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from plutus.api import create_app  # noqa: E402
from plutus.tests.test_api_repository import FakeSupabase  # reuse fixture  # noqa: E402


@pytest.fixture
def client():
    fake = FakeSupabase({
        "pools": [
            {"code": "F40", "name": "Forever 40", "display_order": 1,
             "strategies": ["envelope"], "description": "", "metadata": {}},
        ],
        "stocks": [
            {"id": "1", "symbol": "TCS", "name": "TCS", "sector": "IT",
             "industry": "IT Svc", "exchange": "NSE", "active": True,
             "pools": ["F40"], "cap_type_manual": None, "metadata": {}},
        ],
        "daily_snapshots": [
            {"symbol": "TCS", "snapshot_date": "2025-01-15",
             "close": Decimal("3500.50"), "open": Decimal("3495"),
             "high": Decimal("3510"), "low": Decimal("3490"),
             "adj_close": Decimal("3500.50"), "volume": 1000000},
        ],
        "scans": [
            {"id": "scan-1", "pool_code": "F40",
             "snapshot_date": "2025-01-15",
             "started_at": "2025-01-15T18:00:00", "status": "COMPLETED"},
        ],
        "scan_results": [
            {"scan_id": "scan-1", "symbol": "TCS",
             "strategy_id": "envelope", "status": "BUY_ZONE",
             "score": Decimal("100")},
        ],
        "sync_jobs": [
            {"id": "j1", "job_type": "daily_sync",
             "started_at": "2025-01-15T17:00:00", "status": "SUCCESS"},
        ],
        "fundamentals": [
            {"symbol": "TCS", "quarter_end_date": "2024-12-31",
             "roce": Decimal("46.8"), "roe": Decimal("43.5")},
        ],
    })
    app = create_app(supabase_client=fake)
    return TestClient(app)


class TestHealth:
    def test_health(self, client):
        r = client.get("/api/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


class TestPools:
    def test_list(self, client):
        r = client.get("/api/pools")
        assert r.status_code == 200
        body = r.json()
        assert body["pools"][0]["code"] == "F40"


class TestStocks:
    def test_list(self, client):
        r = client.get("/api/stocks")
        assert r.status_code == 200
        body = r.json()
        assert body["count"] == 1

    def test_filter_by_pool(self, client):
        r = client.get("/api/stocks?pool=F40")
        assert r.status_code == 200
        assert r.json()["stocks"][0]["symbol"] == "TCS"

    def test_get_one_hit(self, client):
        r = client.get("/api/stocks/TCS")
        assert r.status_code == 200
        assert r.json()["stock"]["symbol"] == "TCS"

    def test_get_one_miss_404(self, client):
        r = client.get("/api/stocks/NOPE")
        assert r.status_code == 404


class TestSnapshots:
    def test_latest_returns_decimals_as_strings(self, client):
        r = client.get("/api/snapshots/latest?pool=F40")
        assert r.status_code == 200
        body = r.json()
        assert body["count"] == 1
        snap = body["snapshots"][0]
        # Money-safety: close MUST be a string, never a float.
        assert isinstance(snap["close"], str)
        assert snap["close"] == "3500.50"

    def test_history(self, client):
        r = client.get("/api/snapshots/TCS/history?days=5")
        assert r.status_code == 200
        assert r.json()["symbol"] == "TCS"


class TestScans:
    def test_latest_scan(self, client):
        r = client.get("/api/scans/latest?pool=F40")
        assert r.status_code == 200
        assert r.json()["scan"]["id"] == "scan-1"

    def test_scan_results(self, client):
        r = client.get("/api/scan_results?scan_id=scan-1")
        assert r.status_code == 200
        body = r.json()
        assert body["count"] == 1
        assert body["results"][0]["score"] == "100"  # Decimal -> string

    def test_scan_results_status_filter(self, client):
        r = client.get(
            "/api/scan_results?scan_id=scan-1&status=BUY_ZONE,OPPORTUNITY"
        )
        assert r.status_code == 200
        assert r.json()["count"] == 1


class TestSyncAndFund:
    def test_sync_jobs(self, client):
        r = client.get("/api/sync_jobs/latest")
        assert r.status_code == 200
        assert r.json()["count"] == 1

    def test_fund_hit(self, client):
        r = client.get("/api/fundamentals/TCS/latest")
        assert r.status_code == 200
        assert r.json()["fundamentals"]["roce"] == "46.8"

    def test_fund_miss_404(self, client):
        r = client.get("/api/fundamentals/NOPE/latest")
        assert r.status_code == 404


class TestReadOnlyContract:
    """Market-data routes expose zero write verbs. The personal tools —
    Trading Journal (/api/journal/*), Expense Tracker (/api/expenses/*),
    Position Sizer (/api/sizing/*) and Net Worth (/api/networth/*) — are
    the only DB-writable surfaces; the admin trigger (/api/admin/trigger)
    POSTs to the GitHub API only — it never writes to the database."""

    def test_no_post_routes(self, client):
        for route in client.app.routes:
            path = getattr(route, "path", "")
            if path.startswith(("/api/journal", "/api/expenses",
                                "/api/sizing", "/api/networth",
                                "/api/admin/trigger")):
                continue
            methods = getattr(route, "methods", set()) or set()
            assert "POST" not in methods, f"Write route leaked: {path}"
            assert "PUT" not in methods, f"Write route leaked: {path}"
            assert "PATCH" not in methods, f"Write route leaked: {path}"
            assert "DELETE" not in methods, f"Write route leaked: {path}"

    def test_journal_routes_mounted(self, client):
        journal = [getattr(r, "path", "") for r in client.app.routes
                   if getattr(r, "path", "").startswith("/api/journal")]
        assert "/api/journal/settings" in journal
        assert "/api/journal/trades" in journal
        assert "/api/journal/opportunities" in journal
        assert "/api/journal/positions" in journal
