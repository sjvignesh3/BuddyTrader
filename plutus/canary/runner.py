"""Canary drift runner.

Reads active fixtures from ``canary_checks``, joins each against
``daily_snapshots`` on ``(symbol, check_date)``, computes drift, and
writes the observation back to the fixture row. Emits a single alert
per run when at least one canary drifts.

Money-safety:
  * All comparisons in ``Decimal``. No ``float(`` anywhere.
  * Drift = ``(observed - expected) / expected``. If ``expected == 0``
    (impossible in practice) we mark the check as ``error`` and skip.
  * A missing snapshot row is a ``missing`` outcome, NOT a drift — the
    canary system must distinguish "we have no data" from "the data
    disagrees".
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Dict, List, Optional

from plutus.alerts.notifier import AlertPayload, dispatch_alert

logger = logging.getLogger(__name__)

CANARY_TABLE = "canary_checks"
SNAPSHOT_TABLE = "daily_snapshots"

STATUS_OK = "ok"
STATUS_DRIFT = "drift"
STATUS_MISSING = "missing"
STATUS_ERROR = "error"


@dataclass
class CanaryOutcome:
    symbol: str
    check_date: str
    expected_close: str
    observed_close: Optional[str]
    tolerance_pct: str
    drift_pct: Optional[str]
    status: str
    error: Optional[str] = None

    def as_json(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class CanaryRunReport:
    started_at: str
    finished_at: str
    checked: int
    ok: int
    drift: int
    missing: int
    error: int
    outcomes: List[CanaryOutcome] = field(default_factory=list)
    # Set when the fixtures could not be loaded at all (DB down, bad creds,
    # missing table). Distinct from per-fixture errors — the canary was
    # unable to guard anything and the CLI must exit 2, not 0.
    load_error: Optional[str] = None

    def as_json(self) -> Dict[str, Any]:
        return {
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "checked": self.checked,
            "ok": self.ok,
            "drift": self.drift,
            "missing": self.missing,
            "error": self.error,
            "load_error": self.load_error,
            "outcomes": [o.as_json() for o in self.outcomes],
        }


def _as_decimal(v: Any) -> Optional[Decimal]:
    """Precision-safe cast for values read back from PostgREST.

    NUMERIC columns arrive as JSON numbers → Python float; the shortest-
    repr str() round-trip is exact for our NUMERIC(18,4) fixtures, so a
    float here is converted, not refused (refusing made every live canary
    read report 'missing'). NaN/Inf still map to None.
    """
    if v is None:
        return None
    if isinstance(v, Decimal):
        return v
    if isinstance(v, float):
        import math
        if math.isnan(v) or math.isinf(v):
            return None
        return Decimal(str(v))
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None


@dataclass
class CanaryRunner:
    """Fetches fixtures, computes drift, updates rows, alerts on drift."""

    supabase_client: Any = None
    dispatcher: Callable[..., Any] = dispatch_alert

    # ---- Fixture I/O ------------------------------------------------------
    def _load_fixtures(self) -> List[Dict[str, Any]]:
        if self.supabase_client is None:
            from plutus.adapters.supabase_client import get_client
            self.supabase_client = get_client()
        res = (
            self.supabase_client.table(CANARY_TABLE)
            .select("id,symbol,check_date,expected_close,tolerance_pct,active")
            .eq("active", True)
            .execute()
        )
        return list(getattr(res, "data", None) or [])

    def _load_observed(self, symbol: str, check_date: str) -> Optional[Dict[str, Any]]:
        res = (
            self.supabase_client.table(SNAPSHOT_TABLE)
            .select("close")
            .eq("symbol", symbol)
            .eq("snapshot_date", check_date)
            .limit(1)
            .execute()
        )
        rows = getattr(res, "data", None) or []
        return rows[0] if rows else None

    def _update_fixture(self, fixture_id: str, outcome: CanaryOutcome) -> None:
        patch = {
            "last_observed_close": outcome.observed_close,
            "last_drift_pct": outcome.drift_pct,
            "last_status": outcome.status,
            "last_checked_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            self.supabase_client.table(CANARY_TABLE).update(patch).eq(
                "id", fixture_id
            ).execute()
        except Exception as exc:  # noqa: BLE001 — never crash caller
            _log("canary.update_failed", id=fixture_id,
                 error=f"{type(exc).__name__}: {exc}")

    # ---- Core evaluator (pure) -------------------------------------------
    @staticmethod
    def evaluate(
        expected: Decimal,
        observed: Optional[Decimal],
        tolerance_pct: Decimal,
    ) -> tuple[str, Optional[Decimal]]:
        """Pure function — no I/O. Returns (status, drift_pct)."""
        if observed is None:
            return STATUS_MISSING, None
        if expected == 0:
            return STATUS_ERROR, None
        drift = (observed - expected) / expected
        if abs(drift) <= tolerance_pct:
            return STATUS_OK, drift
        return STATUS_DRIFT, drift

    # ---- Orchestration ---------------------------------------------------
    def run(self, *, alert: bool = True) -> CanaryRunReport:
        started = datetime.now(timezone.utc)
        outcomes: List[CanaryOutcome] = []
        counts = {STATUS_OK: 0, STATUS_DRIFT: 0, STATUS_MISSING: 0, STATUS_ERROR: 0}

        load_error: Optional[str] = None
        try:
            fixtures = self._load_fixtures()
        except Exception as exc:  # noqa: BLE001
            load_error = f"{type(exc).__name__}: {exc}"
            _log("canary.load_failed", error=load_error)
            fixtures = []

        for fx in fixtures:
            sym = fx.get("symbol") or ""
            check_date = str(fx.get("check_date") or "")
            expected = _as_decimal(fx.get("expected_close"))
            # Explicit None check — `or` would silently replace a deliberate
            # zero-tolerance fixture (Decimal("0") is falsy) with the default.
            tolerance = _as_decimal(fx.get("tolerance_pct"))
            if tolerance is None:
                tolerance = Decimal("0.005")
            fx_id = fx.get("id")

            if expected is None or not sym or not check_date or not fx_id:
                outcome = CanaryOutcome(
                    symbol=sym, check_date=check_date,
                    expected_close=str(fx.get("expected_close")),
                    observed_close=None,
                    tolerance_pct=str(tolerance),
                    drift_pct=None,
                    status=STATUS_ERROR,
                    error="invalid_fixture",
                )
                counts[STATUS_ERROR] += 1
                outcomes.append(outcome)
                continue

            observed_val: Optional[Decimal] = None
            err: Optional[str] = None
            try:
                snap = self._load_observed(sym, check_date)
                observed_val = _as_decimal(snap.get("close")) if snap else None
            except Exception as exc:  # noqa: BLE001
                err = f"{type(exc).__name__}: {exc}"

            if err is not None:
                status, drift = STATUS_ERROR, None
            else:
                status, drift = self.evaluate(expected, observed_val, tolerance)

            outcome = CanaryOutcome(
                symbol=sym,
                check_date=check_date,
                expected_close=str(expected),
                observed_close=str(observed_val) if observed_val is not None else None,
                tolerance_pct=str(tolerance),
                drift_pct=str(drift) if drift is not None else None,
                status=status,
                error=err,
            )
            counts[status] = counts.get(status, 0) + 1
            outcomes.append(outcome)
            self._update_fixture(fx_id, outcome)

        finished = datetime.now(timezone.utc)
        report = CanaryRunReport(
            started_at=started.isoformat(),
            finished_at=finished.isoformat(),
            checked=len(outcomes),
            ok=counts[STATUS_OK],
            drift=counts[STATUS_DRIFT],
            missing=counts[STATUS_MISSING],
            error=counts[STATUS_ERROR],
            outcomes=outcomes,
            load_error=load_error,
        )

        if alert and (report.drift > 0 or report.error > 0 or report.missing > 0):
            self._dispatch_alert(report)

        _log("canary.done", **{k: v for k, v in report.as_json().items()
                                if k != "outcomes"})
        return report

    # ---- Alerting ---------------------------------------------------------
    def _dispatch_alert(self, report: CanaryRunReport) -> None:
        severity = "error" if report.drift > 0 else "warning"
        lines = [
            f"checked: {report.checked}",
            f"ok:      {report.ok}",
            f"drift:   {report.drift}",
            f"missing: {report.missing}",
            f"error:   {report.error}",
            "",
            "offenders:",
        ]
        for o in report.outcomes:
            if o.status in (STATUS_DRIFT, STATUS_MISSING, STATUS_ERROR):
                lines.append(
                    f"  {o.symbol} @ {o.check_date} — {o.status}"
                    f" expected={o.expected_close}"
                    f" observed={o.observed_close}"
                    f" drift={o.drift_pct}"
                )
        payload = AlertPayload(
            title="Plutus canary drift detected",
            body="\n".join(lines),
            severity=severity,
            context={"drift": report.drift, "missing": report.missing,
                     "error": report.error},
        )
        try:
            self.dispatcher(payload)
        except Exception:  # noqa: BLE001 — alerting must never break the runner
            pass


# ---------------------------------------------------------------------------
def _log(event: str, **fields: Any) -> None:
    try:
        logger.info(json.dumps({"event": event, **fields}, default=str))
    except Exception:  # noqa: BLE001
        logger.info("event=%s %s", event, fields)


__all__ = ["CanaryOutcome", "CanaryRunReport", "CanaryRunner"]
