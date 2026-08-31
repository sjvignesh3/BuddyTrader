"""Tests for plutus.canary.runner.

Fully offline — Supabase and the alerter are dependency-injected via
tiny in-memory fakes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Dict, List, Optional

import pytest

from plutus.alerts.notifier import AlertDispatchResult, AlertPayload
from plutus.canary.runner import (
    STATUS_DRIFT,
    STATUS_ERROR,
    STATUS_MISSING,
    STATUS_OK,
    CanaryRunner,
)


# ---------------------------------------------------------------------------
# In-memory Supabase fake — implements just the query shape the runner uses.
# ---------------------------------------------------------------------------
@dataclass
class _Res:
    data: List[Dict[str, Any]]


class _Query:
    def __init__(self, table: "_Table", op: str, payload: Any = None) -> None:
        self._t = table
        self._op = op
        self._payload = payload
        self._filters: Dict[str, Any] = {}
        self._limit: Optional[int] = None

    # select() chain -------------------------------------------------------
    def eq(self, col: str, val: Any) -> "_Query":
        self._filters[col] = val
        return self

    def limit(self, n: int) -> "_Query":
        self._limit = n
        return self

    def execute(self) -> _Res:
        if self._op == "update":
            for row in self._t.rows:
                if all(row.get(k) == v for k, v in self._filters.items()):
                    row.update(self._payload)
                    self._t.update_calls.append(dict(row))
            return _Res(data=[])
        # select
        rows = [
            r for r in self._t.rows
            if all(r.get(k) == v for k, v in self._filters.items())
        ]
        if self._limit is not None:
            rows = rows[: self._limit]
        return _Res(data=list(rows))


@dataclass
class _Table:
    rows: List[Dict[str, Any]]
    update_calls: List[Dict[str, Any]] = field(default_factory=list)

    def select(self, _cols: str) -> _Query:
        return _Query(self, "select")

    def update(self, patch: Dict[str, Any]) -> _Query:
        return _Query(self, "update", payload=patch)


class _Client:
    def __init__(self, canary_rows: List[Dict[str, Any]],
                 snapshot_rows: List[Dict[str, Any]]) -> None:
        self.canary = _Table(canary_rows)
        self.snapshots = _Table(snapshot_rows)

    def table(self, name: str) -> _Table:
        if name == "canary_checks":
            return self.canary
        if name == "daily_snapshots":
            return self.snapshots
        raise AssertionError(f"unexpected table: {name}")


class _Alerter:
    def __init__(self) -> None:
        self.calls: List[AlertPayload] = []

    def __call__(self, payload: AlertPayload, *, url: Any = None) -> AlertDispatchResult:
        self.calls.append(payload)
        return AlertDispatchResult(ok=True, attempts=1, status_code=200)


# ---------------------------------------------------------------------------
# Pure evaluator
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "expected,observed,tol,want_status",
    [
        (Decimal("100"),   Decimal("100.4"),  Decimal("0.005"), STATUS_OK),
        (Decimal("100"),   Decimal("100.6"),  Decimal("0.005"), STATUS_DRIFT),
        (Decimal("100"),   Decimal("99.4"),   Decimal("0.005"), STATUS_DRIFT),
        (Decimal("100"),   None,              Decimal("0.005"), STATUS_MISSING),
        (Decimal("0"),     Decimal("1"),      Decimal("0.005"), STATUS_ERROR),
    ],
)
def test_evaluate_pure(expected: Decimal, observed: Optional[Decimal],
                       tol: Decimal, want_status: str) -> None:
    status, drift = CanaryRunner.evaluate(expected, observed, tol)
    assert status == want_status
    if want_status in (STATUS_OK, STATUS_DRIFT):
        assert drift is not None
        # Sign matches direction.
        assert (drift > 0) == (observed > expected)  # type: ignore[operator]
    else:
        assert drift is None


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def test_all_ok_no_alert_dispatched() -> None:
    client = _Client(
        canary_rows=[{
            "id": "fx-1", "symbol": "RELIANCE.NS", "check_date": "2024-01-02",
            "expected_close": "2500.00", "tolerance_pct": "0.005", "active": True,
        }],
        snapshot_rows=[{
            "symbol": "RELIANCE.NS", "snapshot_date": "2024-01-02",
            "close": "2500.10",   # 0.004 % drift → within tolerance
        }],
    )
    alerter = _Alerter()
    runner = CanaryRunner(supabase_client=client, dispatcher=alerter)
    report = runner.run()

    assert report.checked == 1
    assert report.ok == 1
    assert report.drift == 0 == report.missing == report.error
    assert alerter.calls == []
    # Fixture row was updated with observed state.
    assert client.canary.update_calls, "fixture row must be updated"
    upd = client.canary.update_calls[-1]
    assert upd["last_status"] == STATUS_OK
    assert upd["last_observed_close"] == "2500.10"


def test_drift_triggers_error_severity_alert() -> None:
    client = _Client(
        canary_rows=[{
            "id": "fx-1", "symbol": "RELIANCE.NS", "check_date": "2024-01-02",
            "expected_close": "2500.00", "tolerance_pct": "0.005", "active": True,
        }],
        snapshot_rows=[{
            "symbol": "RELIANCE.NS", "snapshot_date": "2024-01-02",
            "close": "2600.00",   # 4 % drift
        }],
    )
    alerter = _Alerter()
    runner = CanaryRunner(supabase_client=client, dispatcher=alerter)
    report = runner.run()

    assert report.drift == 1 and report.ok == 0
    assert len(alerter.calls) == 1
    payload = alerter.calls[0]
    assert payload.severity == "error"
    assert "RELIANCE.NS" in payload.body
    assert "drift" in payload.body.lower()


def test_missing_snapshot_reports_missing_not_drift() -> None:
    client = _Client(
        canary_rows=[{
            "id": "fx-1", "symbol": "PAGEIND.NS", "check_date": "2024-01-02",
            "expected_close": "45000.00", "tolerance_pct": "0.005", "active": True,
        }],
        snapshot_rows=[],   # empty
    )
    alerter = _Alerter()
    runner = CanaryRunner(supabase_client=client, dispatcher=alerter)
    report = runner.run()

    assert report.missing == 1 and report.drift == 0
    # Warning severity — no drift, but we still want a signal.
    assert alerter.calls[0].severity == "warning"


def test_alert_disabled_flag_suppresses_dispatch() -> None:
    client = _Client(
        canary_rows=[{
            "id": "fx-1", "symbol": "X", "check_date": "2024-01-02",
            "expected_close": "100.00", "tolerance_pct": "0.005", "active": True,
        }],
        snapshot_rows=[{
            "symbol": "X", "snapshot_date": "2024-01-02", "close": "200.00",
        }],
    )
    alerter = _Alerter()
    runner = CanaryRunner(supabase_client=client, dispatcher=alerter)
    report = runner.run(alert=False)

    assert report.drift == 1
    assert alerter.calls == []


def test_invalid_fixture_row_marked_error_and_row_not_updated() -> None:
    client = _Client(
        canary_rows=[{
            "id": "fx-1", "symbol": "", "check_date": "2024-01-02",
            "expected_close": None, "tolerance_pct": "0.005", "active": True,
        }],
        snapshot_rows=[],
    )
    alerter = _Alerter()
    runner = CanaryRunner(supabase_client=client, dispatcher=alerter)
    report = runner.run()

    assert report.error == 1
    # No update issued for an invalid fixture.
    assert client.canary.update_calls == []


def test_snapshot_lookup_exception_marks_error() -> None:
    client = _Client(
        canary_rows=[{
            "id": "fx-1", "symbol": "X", "check_date": "2024-01-02",
            "expected_close": "100.00", "tolerance_pct": "0.005", "active": True,
        }],
        snapshot_rows=[],
    )
    # Sabotage snapshot table access to raise.
    def _boom(_cols: str) -> Any:
        raise RuntimeError("db down")
    client.snapshots.select = _boom  # type: ignore[assignment]

    alerter = _Alerter()
    runner = CanaryRunner(supabase_client=client, dispatcher=alerter)
    report = runner.run()

    assert report.error == 1
    assert alerter.calls[0].severity == "warning"


def test_fixture_load_exception_returns_empty_report_without_raising() -> None:
    class _BadClient:
        def table(self, _n: str) -> Any:
            raise RuntimeError("boom")

    runner = CanaryRunner(supabase_client=_BadClient(), dispatcher=_Alerter())
    report = runner.run()
    assert report.checked == 0
