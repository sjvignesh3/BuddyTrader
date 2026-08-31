"""Unit tests for plutus.api.repository — offline, fake Supabase client."""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, List, Optional

import pytest

from plutus.api import repository as repo


# ---------------------------------------------------------------------------
# Minimal in-memory fake Supabase client.
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, data: List[Dict[str, Any]]):
        self.data = data


class _Query:
    """
    Records the query builder chain and filters the fake table's rows.

    Supports: select, eq, in_, order, limit, execute.
    """

    def __init__(self, rows: List[Dict[str, Any]]):
        self._rows = list(rows)
        self.chain: List[tuple] = []

    def select(self, *args, **kwargs):
        self.chain.append(("select", args, kwargs))
        return self

    def eq(self, col: str, value: Any):
        self.chain.append(("eq", col, value))
        self._rows = [r for r in self._rows if r.get(col) == value]
        return self

    def in_(self, col: str, values):
        self.chain.append(("in_", col, list(values)))
        vs = set(values)
        self._rows = [r for r in self._rows if r.get(col) in vs]
        return self

    def order(self, col: str, desc: bool = False):
        self.chain.append(("order", col, desc))
        self._rows = sorted(
            self._rows,
            key=lambda r: (r.get(col) is None, r.get(col)),
            reverse=desc,
        )
        return self

    def limit(self, n: int):
        self.chain.append(("limit", n))
        self._rows = self._rows[:n]
        return self

    def execute(self):
        return _Result(self._rows)


class FakeSupabase:
    def __init__(self, tables: Dict[str, List[Dict[str, Any]]]):
        self._tables = tables
        self.last_query: Optional[_Query] = None

    def table(self, name: str) -> _Query:
        q = _Query(self._tables.get(name, []))
        self.last_query = q
        return q


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_client() -> FakeSupabase:
    return FakeSupabase({
        "pools": [
            {"code": "F40", "name": "Forever 40", "display_order": 1,
             "strategies": ["envelope"], "description": "", "metadata": {}},
            {"code": "E40", "name": "Emerging 40", "display_order": 2,
             "strategies": ["envelope", "week52"], "description": "",
             "metadata": {}},
        ],
        "stocks": [
            {"id": "1", "symbol": "TCS", "name": "TCS", "sector": "IT",
             "industry": "IT Svc", "exchange": "NSE", "active": True,
             "pools": ["F40"], "cap_type_manual": None, "metadata": {}},
            {"id": "2", "symbol": "INFY", "name": "Infosys", "sector": "IT",
             "industry": "IT Svc", "exchange": "NSE", "active": True,
             "pools": ["F40", "E40"], "cap_type_manual": None, "metadata": {}},
            {"id": "3", "symbol": "OLD", "name": "Delisted", "sector": None,
             "industry": None, "exchange": "NSE", "active": False,
             "pools": ["F40"], "cap_type_manual": None, "metadata": {}},
        ],
        "daily_snapshots": [
            {"symbol": "TCS", "snapshot_date": "2025-01-15",
             "close": Decimal("3500.50"), "open": Decimal("3495"),
             "high": Decimal("3510"), "low": Decimal("3490"),
             "adj_close": Decimal("3500.50"), "volume": 1000000},
            {"symbol": "INFY", "snapshot_date": "2025-01-15",
             "close": Decimal("1800.25"), "open": Decimal("1795"),
             "high": Decimal("1810"), "low": Decimal("1790"),
             "adj_close": Decimal("1800.25"), "volume": 500000},
            {"symbol": "TCS", "snapshot_date": "2025-01-14",
             "close": Decimal("3480.00"), "open": Decimal("3470"),
             "high": Decimal("3495"), "low": Decimal("3465"),
             "adj_close": Decimal("3480.00"), "volume": 900000},
        ],
        "scans": [
            {"id": "scan-1", "pool_code": "F40", "snapshot_date": "2025-01-14",
             "started_at": "2025-01-14T18:00:00", "status": "COMPLETED"},
            {"id": "scan-2", "pool_code": "F40", "snapshot_date": "2025-01-15",
             "started_at": "2025-01-15T18:00:00", "status": "COMPLETED"},
            {"id": "scan-3", "pool_code": "E40", "snapshot_date": "2025-01-15",
             "started_at": "2025-01-15T18:00:00", "status": "COMPLETED"},
        ],
        "scan_results": [
            {"scan_id": "scan-2", "symbol": "TCS",
             "strategy_id": "envelope", "status": "BUY_ZONE",
             "score": Decimal("100")},
            {"scan_id": "scan-2", "symbol": "INFY",
             "strategy_id": "envelope", "status": "OPPORTUNITY",
             "score": Decimal("70")},
            {"scan_id": "scan-2", "symbol": "TCS",
             "strategy_id": "week52", "status": "NO_SIGNAL",
             "score": Decimal("0")},
        ],
        "sync_jobs": [
            {"id": "j1", "job_type": "daily_sync",
             "started_at": "2025-01-15T17:00:00", "status": "SUCCESS"},
            {"id": "j2", "job_type": "quarterly_sync",
             "started_at": "2025-01-15T02:00:00", "status": "SUCCESS"},
            {"id": "j3", "job_type": "daily_sync",
             "started_at": "2025-01-14T17:00:00", "status": "SUCCESS"},
        ],
        "fundamentals": [
            {"symbol": "TCS", "quarter_end_date": "2024-09-30",
             "roce": Decimal("45.2"), "roe": Decimal("42.1")},
            {"symbol": "TCS", "quarter_end_date": "2024-12-31",
             "roce": Decimal("46.8"), "roe": Decimal("43.5")},
        ],
    })


# ---------------------------------------------------------------------------
# Pools
# ---------------------------------------------------------------------------

class TestListPools:
    def test_returns_all_pools_sorted(self, fake_client):
        rows = repo.list_pools(client=fake_client)
        assert [r["code"] for r in rows] == ["F40", "E40"]

    def test_never_calls_get_client_when_injected(self, fake_client, monkeypatch):
        # Guard: injection path must not touch adapters.supabase_client.
        def _boom():
            raise AssertionError("get_client() must not be called")
        monkeypatch.setattr("plutus.adapters.supabase_client.get_client", _boom)
        repo.list_pools(client=fake_client)


# ---------------------------------------------------------------------------
# Stocks
# ---------------------------------------------------------------------------

class TestListStocks:
    def test_active_only_default(self, fake_client):
        rows = repo.list_stocks(client=fake_client)
        symbols = {r["symbol"] for r in rows}
        assert "OLD" not in symbols
        assert symbols == {"TCS", "INFY"}

    def test_include_inactive(self, fake_client):
        rows = repo.list_stocks(active_only=False, client=fake_client)
        assert {r["symbol"] for r in rows} == {"TCS", "INFY", "OLD"}

    def test_filter_by_pool(self, fake_client):
        rows = repo.list_stocks(pool_code="E40", client=fake_client)
        assert {r["symbol"] for r in rows} == {"INFY"}

    def test_get_stock_hit(self, fake_client):
        row = repo.get_stock("TCS", client=fake_client)
        assert row["symbol"] == "TCS"

    def test_get_stock_miss(self, fake_client):
        assert repo.get_stock("NOPE", client=fake_client) is None


# ---------------------------------------------------------------------------
# Snapshots
# ---------------------------------------------------------------------------

class TestSnapshots:
    def test_latest_snapshot_date(self, fake_client):
        assert repo.latest_snapshot_date(client=fake_client) == "2025-01-15"

    def test_snapshots_for_pool_uses_latest_date(self, fake_client):
        rows = repo.snapshots_for_pool("F40", client=fake_client)
        assert {r["symbol"] for r in rows} == {"TCS", "INFY"}
        assert all(r["snapshot_date"] == "2025-01-15" for r in rows)

    def test_snapshots_for_pool_explicit_date(self, fake_client):
        rows = repo.snapshots_for_pool(
            "F40", snapshot_date="2025-01-14", client=fake_client
        )
        assert len(rows) == 1
        assert rows[0]["symbol"] == "TCS"

    def test_empty_pool_returns_empty(self, fake_client):
        rows = repo.snapshots_for_pool("NONEXISTENT", client=fake_client)
        assert rows == []

    def test_history_orders_desc_and_limits(self, fake_client):
        rows = repo.snapshot_history("TCS", days=5, client=fake_client)
        assert [r["snapshot_date"] for r in rows] == ["2025-01-15", "2025-01-14"]


# ---------------------------------------------------------------------------
# Scans
# ---------------------------------------------------------------------------

class TestScans:
    def test_latest_scan_picks_newest_snapshot_date(self, fake_client):
        row = repo.latest_scan("F40", client=fake_client)
        assert row["id"] == "scan-2"

    def test_latest_scan_missing_pool(self, fake_client):
        assert repo.latest_scan("NONE", client=fake_client) is None

    def test_scan_results_by_scan_id(self, fake_client):
        rows = repo.scan_results("scan-2", client=fake_client)
        assert len(rows) == 3

    def test_scan_results_filter_strategy(self, fake_client):
        rows = repo.scan_results(
            "scan-2", strategy_id="envelope", client=fake_client
        )
        assert {r["symbol"] for r in rows} == {"TCS", "INFY"}
        assert all(r["strategy_id"] == "envelope" for r in rows)

    def test_scan_results_filter_status(self, fake_client):
        rows = repo.scan_results(
            "scan-2", status_in=["BUY_ZONE", "OPPORTUNITY"], client=fake_client
        )
        assert {r["status"] for r in rows} == {"BUY_ZONE", "OPPORTUNITY"}


# ---------------------------------------------------------------------------
# Sync jobs + Fundamentals
# ---------------------------------------------------------------------------

class TestSyncAndFundamentals:
    def test_latest_sync_jobs_all_types(self, fake_client):
        rows = repo.latest_sync_jobs(client=fake_client)
        assert len(rows) == 3
        # Ordered desc by started_at.
        assert rows[0]["started_at"] >= rows[-1]["started_at"]

    def test_latest_sync_jobs_filter_type(self, fake_client):
        rows = repo.latest_sync_jobs(job_type="daily_sync", client=fake_client)
        assert {r["id"] for r in rows} == {"j1", "j3"}

    def test_latest_fundamentals_picks_newest_quarter(self, fake_client):
        row = repo.latest_fundamentals("TCS", client=fake_client)
        assert row["quarter_end_date"] == "2024-12-31"

    def test_latest_fundamentals_miss(self, fake_client):
        assert repo.latest_fundamentals("NOPE", client=fake_client) is None
