"""Unit tests for the Expense Tracker routes — offline, fake Supabase.

The shared FakeSupabase in test_api_repository is read-only, so this file
carries its own writable fake (insert / update / delete / gte / lte /
ilike / is_) — just enough PostgREST surface for the expense routes.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from plutus.api import create_app  # noqa: E402


# ---------------------------------------------------------------------------
# Writable in-memory fake Supabase client.
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, data: List[Dict[str, Any]]):
        self.data = data


class _WQuery:
    def __init__(self, store: "WritableFake", name: str):
        self._store = store
        self._name = name
        self._filters: List[Any] = []
        self._order: List[tuple] = []
        self._limit: int | None = None
        self._op: str = "select"
        self._payload: Any = None

    # -- verbs ---------------------------------------------------------------
    def select(self, *_a, **_k):
        self._op = "select"
        return self

    def insert(self, payload):
        self._op = "insert"
        self._payload = payload
        return self

    def update(self, payload):
        self._op = "update"
        self._payload = payload
        return self

    def delete(self):
        self._op = "delete"
        return self

    # -- filters ---------------------------------------------------------------
    def eq(self, col, value):
        self._filters.append(lambda r: r.get(col) == value)
        return self

    def gte(self, col, value):
        self._filters.append(lambda r: r.get(col) is not None and str(r.get(col)) >= str(value))
        return self

    def lte(self, col, value):
        self._filters.append(lambda r: r.get(col) is not None and str(r.get(col)) <= str(value))
        return self

    def is_(self, col, value):
        if value in ("null", None):
            self._filters.append(lambda r: r.get(col) is None)
        return self

    def ilike(self, col, pattern):
        # Un-escape PostgREST-escaped wildcards, then case-insensitive match.
        rx = "^" + re.escape(pattern).replace(r"\\%", "\0").replace(r"\\_", "\1") \
            .replace("%", ".*").replace("_", ".") \
            .replace("\0", "%").replace("\1", "_") + "$"
        self._filters.append(
            lambda r: re.match(rx, str(r.get(col) or ""), re.IGNORECASE) is not None)
        return self

    def order(self, col, desc=False):
        self._order.append((col, desc))
        return self

    def limit(self, n):
        self._limit = n
        return self

    # -- exec -------------------------------------------------------------------
    def _matched(self, rows):
        out = rows
        for f in self._filters:
            out = [r for r in out if f(r)]
        return out

    def execute(self):
        rows = self._store.tables.setdefault(self._name, [])
        if self._op == "insert":
            payload = self._payload if isinstance(self._payload, list) else [self._payload]
            added = []
            for p in payload:
                row = dict(p)
                row.setdefault("id", self._store.next_id())
                rows.append(row)
                added.append(row)
            return _Result(added)
        if self._op == "update":
            hit = self._matched(rows)
            for r in hit:
                r.update(self._payload)
            return _Result(list(hit))
        if self._op == "delete":
            hit = self._matched(rows)
            self._store.tables[self._name] = [r for r in rows if r not in hit]
            return _Result(list(hit))
        out = self._matched(rows)
        for col, desc in reversed(self._order):
            out = sorted(out, key=lambda r: (r.get(col) is None, r.get(col)),
                         reverse=desc)
        if self._limit is not None:
            out = out[: self._limit]
        return _Result(list(out))


class WritableFake:
    def __init__(self, tables: Dict[str, List[Dict[str, Any]]] | None = None):
        self.tables = tables or {}
        self._id = 1000

    def next_id(self) -> int:
        self._id += 1
        return self._id

    def table(self, name: str) -> _WQuery:
        return _WQuery(self, name)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def fake():
    return WritableFake({
        "expense_categories": [
            {"id": 1, "name": "Food & Dining", "parent_id": None,
             "default_intent": None, "exclude_from_spending": False,
             "sort_order": 1, "archived": False},
            {"id": 2, "name": "Snacks & Cravings", "parent_id": 1,
             "default_intent": "want", "exclude_from_spending": False,
             "sort_order": 1, "archived": False},
        ],
        "expense_items": [
            {"id": 10, "name": "Tea", "category_id": 2, "intent": "want",
             "payment_method": "UPI", "last_amount": "15", "use_count": 3,
             "pinned": False},
        ],
        "expenses": [],
        "expense_recurring": [],
        "expense_budgets": [],
    })


@pytest.fixture
def client(fake):
    return TestClient(create_app(supabase_client=fake))


# ---------------------------------------------------------------------------
# Expenses CRUD + item memory
# ---------------------------------------------------------------------------

class TestExpenses:
    def test_create_requires_name_and_amount(self, client):
        assert client.post("/api/expenses", json={"amount": 10}).status_code == 400
        assert client.post("/api/expenses", json={"name": "Tea"}).status_code == 400

    def test_create_defaults_date_and_remembers_item(self, client, fake):
        r = client.post("/api/expenses", json={"name": "Tea", "amount": 15,
                                               "category_id": 2, "intent": "want"})
        assert r.status_code == 200
        exp = r.json()["expense"]
        assert exp["expense_date"]  # defaulted to today
        assert exp["name"] == "Tea"
        item = fake.tables["expense_items"][0]
        assert item["use_count"] == 4          # bumped
        assert str(item["last_amount"]) == "15"

    def test_create_learns_new_item(self, client, fake):
        r = client.post("/api/expenses", json={"name": "Vada Pav", "amount": 20})
        assert r.status_code == 200
        names = [i["name"] for i in fake.tables["expense_items"]]
        assert "Vada Pav" in names

    def test_unknown_fields_dropped(self, client, fake):
        r = client.post("/api/expenses", json={"name": "Tea", "amount": 5,
                                               "evil_column": "x"})
        assert r.status_code == 200
        assert "evil_column" not in fake.tables["expenses"][0]

    def test_invalid_intent_nulled(self, client, fake):
        r = client.post("/api/expenses", json={"name": "Tea", "amount": 5,
                                               "intent": "luxury"})
        assert r.status_code == 200
        assert fake.tables["expenses"][0].get("intent") is None

    def test_list_with_date_range(self, client):
        client.post("/api/expenses", json={"name": "A", "amount": 1,
                                           "expense_date": "2026-08-01"})
        client.post("/api/expenses", json={"name": "B", "amount": 2,
                                           "expense_date": "2026-09-01"})
        r = client.get("/api/expenses?from=2026-08-15")
        assert r.status_code == 200
        assert [e["name"] for e in r.json()["expenses"]] == ["B"]

    def test_update_and_delete(self, client, fake):
        rid = client.post("/api/expenses", json={"name": "Tea", "amount": 5}) \
            .json()["expense"]["id"]
        r = client.put(f"/api/expenses/{rid}", json={"amount": 7})
        assert r.status_code == 200
        assert str(r.json()["expense"]["amount"]) == "7"
        assert client.put("/api/expenses/9999", json={"amount": 1}).status_code == 404
        assert client.delete(f"/api/expenses/{rid}").status_code == 200
        assert fake.tables["expenses"] == []


class TestImport:
    def test_import_resolves_and_creates_categories(self, client, fake):
        r = client.post("/api/expenses/import", json={"expenses": [
            {"name": "Tea", "amount": 15, "expense_date": "2026-08-01",
             "category": "food & dining"},
            {"name": "Rent", "amount": 1865, "expense_date": "2026-08-11",
             "category": "House Rent"},           # new — gets created
            {"name": "", "amount": 5, "expense_date": "2026-08-01"},  # skipped
        ]})
        assert r.status_code == 200
        assert r.json() == {"imported": 2, "skipped": 1}
        cats = {c["name"] for c in fake.tables["expense_categories"]}
        assert "House Rent" in cats
        tea = next(e for e in fake.tables["expenses"] if e["name"] == "Tea")
        assert tea["category_id"] == 1
        assert "category" not in tea               # name key never persisted


class TestItemsCategories:
    def test_items_listed_by_use(self, client):
        r = client.get("/api/expenses/items")
        assert r.status_code == 200
        assert r.json()["items"][0]["name"] == "Tea"

    def test_category_crud(self, client, fake):
        r = client.post("/api/expenses/categories", json={"name": "Pets"})
        assert r.status_code == 200
        cid = r.json()["category"]["id"]
        r = client.put(f"/api/expenses/categories/{cid}", json={"icon": "🐕"})
        assert r.status_code == 200
        assert client.delete(f"/api/expenses/categories/{cid}").status_code == 200

    def test_category_requires_name(self, client):
        assert client.post("/api/expenses/categories", json={}).status_code == 400


class TestRecurring:
    def test_recurring_validation(self, client):
        assert client.post("/api/expenses/recurring",
                           json={"name": "Rent"}).status_code == 400
        assert client.post("/api/expenses/recurring",
                           json={"name": "Rent", "amount": 100,
                                 "frequency": "fortnightly"}).status_code == 400

    def test_log_recurring_creates_linked_expense(self, client, fake):
        rid = client.post("/api/expenses/recurring", json={
            "name": "Rent", "amount": 1865, "category_id": 1,
            "frequency": "monthly", "due_day": 11, "intent": "need",
        }).json()["recurring"]["id"]
        r = client.post(f"/api/expenses/recurring/{rid}/log", json={})
        assert r.status_code == 200
        exp = r.json()["expense"]
        assert exp["recurring_id"] == rid
        assert str(exp["amount"]) == "1865"
        # override amount on log (bills vary)
        r = client.post(f"/api/expenses/recurring/{rid}/log",
                        json={"amount": 1900})
        assert str(r.json()["expense"]["amount"]) == "1900"

    def test_log_missing_recurring_404(self, client):
        assert client.post("/api/expenses/recurring/999/log", json={}) \
            .status_code == 404


class TestBudgets:
    def test_budget_upsert_by_category(self, client, fake):
        r = client.post("/api/expenses/budgets",
                        json={"category_id": 1, "monthly_amount": 6000})
        assert r.status_code == 200
        r = client.post("/api/expenses/budgets",
                        json={"category_id": 1, "monthly_amount": 7000})
        assert r.status_code == 200
        assert len(fake.tables["expense_budgets"]) == 1
        assert str(fake.tables["expense_budgets"][0]["monthly_amount"]) == "7000"

    def test_overall_budget_null_category(self, client, fake):
        client.post("/api/expenses/budgets", json={"monthly_amount": 20000})
        client.post("/api/expenses/budgets", json={"monthly_amount": 25000})
        overall = [b for b in fake.tables["expense_budgets"]
                   if b.get("category_id") is None]
        assert len(overall) == 1
        assert str(overall[0]["monthly_amount"]) == "25000"
