"""
Quarterly Sync Worker — Tier B via Screener.in.

Shape mirrors Stage 4's DailySyncWorker:
    * `run_symbol(symbol)` — fetch the authenticated Screener bundle,
      build registry-shaped rows, return them. Never raises.
    * `run_all(symbols)`   — pre-flight login, iterate with a COOLDOWN
      between live fetches (Screener rate-limit etiquette, default 15 s),
      batch upsert to `fundamentals`, write one `sync_jobs` row.

Source separation (locked): Tier A (daily prices/valuation) = yfinance;
Tier B (quarterly fundamentals) = Screener.in authenticated page. The
manual overrides CSV path remains for one-off corrections.
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field as dc_field
from datetime import date, datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence

from plutus.adapters import supabase_client as sb
from plutus.adapters.result import Result
from plutus.fundamentals.quarterly import rows_from_bundle
from plutus.registry.fields import fields_for
from plutus.sync.worker import _log, SYNC_JOBS_CONFLICT, SYNC_JOBS_TABLE

logger = logging.getLogger(__name__)

FUNDAMENTALS_TABLE = "fundamentals"
FUNDAMENTALS_CONFLICT = ("symbol", "quarter_end_date")
DEFAULT_JOB_TYPE = "quarterly_sync"

# Cooldown between LIVE Screener fetches. Legacy Buddy used 20 s; 15 s is
# fine for a quarterly cadence. Applied only when more than the threshold
# of symbols are fetched (legacy behaviour); small batches use a polite
# half-second gap.
DEFAULT_COOLDOWN_S = 15.0
COOLDOWN_THRESHOLD = 5


def _cooldown_seconds() -> float:
    raw = os.environ.get("PLUTUS_SCREENER_COOLDOWN_S", "").strip()
    if not raw:
        return DEFAULT_COOLDOWN_S
    try:
        return max(0.0, float(raw))
    except ValueError:
        return DEFAULT_COOLDOWN_S


# ---------------------------------------------------------------------------
# Screener fetcher (dependency-injected for tests)
# ---------------------------------------------------------------------------
_client_singleton: Optional[Any] = None


def _get_screener_client() -> Any:
    """One authenticated ScreenerClient per process (one login per run)."""
    global _client_singleton
    if _client_singleton is None:
        from plutus.fundamentals.screener_client import ScreenerClient
        _client_singleton = ScreenerClient()
    return _client_singleton


def reset_screener_client() -> None:
    """Test hook."""
    global _client_singleton
    _client_singleton = None


def _default_fetch_quarterly(symbol: str) -> Result[Dict[str, Any]]:
    """Live Screener.in fetch — returns the parsed bundle."""
    from plutus.adapters.validators import sanity_check_symbol

    try:
        sym = sanity_check_symbol(symbol)
    except ValueError as exc:
        return Result.failure(str(exc), symbol=symbol, attempts=0)

    started = time.monotonic()
    try:
        bundle = _get_screener_client().fetch_bundle(sym)
        latency = int((time.monotonic() - started) * 1000)
        return Result.success(bundle, symbol=sym, attempts=1,
                              latency_ms=latency)
    except Exception as exc:  # noqa: BLE001 — per-symbol isolation
        latency = int((time.monotonic() - started) * 1000)
        return Result.failure(f"{type(exc).__name__}: {exc}", symbol=sym,
                              attempts=1, latency_ms=latency)


# ---------------------------------------------------------------------------
# Report types
# ---------------------------------------------------------------------------
@dataclass
class SymbolReport:
    symbol: str
    ok: bool
    rows_extracted: int
    rows_written: int = 0
    warnings: List[str] = dc_field(default_factory=list)
    error: Optional[str] = None

    def as_json(self) -> Dict[str, Any]:
        return {
            "symbol": self.symbol,
            "ok": self.ok,
            "rows_extracted": self.rows_extracted,
            "rows_written": self.rows_written,
            "warnings": list(self.warnings),
            "error": self.error,
        }


@dataclass
class RunReport:
    as_of_date: date
    job_type: str
    dry_run: bool
    started_at: datetime
    finished_at: datetime
    symbols_total: int
    symbols_ok: int
    symbols_failed: int
    rows_written: int
    per_symbol: List[SymbolReport] = dc_field(default_factory=list)
    upsert_errors: List[str] = dc_field(default_factory=list)
    sync_job_id: Optional[str] = None

    def as_json(self) -> Dict[str, Any]:
        return {
            "as_of_date": self.as_of_date.isoformat(),
            "job_type": self.job_type,
            "dry_run": self.dry_run,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat(),
            "duration_ms": int(
                (self.finished_at - self.started_at).total_seconds() * 1000
            ),
            "symbols_total": self.symbols_total,
            "symbols_ok": self.symbols_ok,
            "symbols_failed": self.symbols_failed,
            "rows_written": self.rows_written,
            "per_symbol": [s.as_json() for s in self.per_symbol],
            "upsert_errors": list(self.upsert_errors),
            "sync_job_id": self.sync_job_id,
        }


# ---------------------------------------------------------------------------
# Registry-driven projection
# ---------------------------------------------------------------------------
_FUND_FIELDS = tuple(f.name for f in fields_for(FUNDAMENTALS_TABLE))


def _project_row(sym: str, row: Dict[str, Any]) -> Dict[str, Any]:
    projected = {"symbol": sym}
    for k in _FUND_FIELDS:
        if k in row:
            projected[k] = row[k]
    return projected


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------
@dataclass
class QuarterlySyncWorker:
    supabase_client: Any = None
    fetch_quarterly: Callable[[str], Result[Dict[str, Any]]] = _default_fetch_quarterly
    upsert: Callable[..., Any] = sb.bulk_upsert
    job_type: str = DEFAULT_JOB_TYPE
    # Stamped into sync_jobs.payload_json["context"] — trigger/pool/symbols.
    run_context: Optional[Dict[str, Any]] = None

    def run_symbol(self, symbol: str) -> tuple[SymbolReport, List[Dict[str, Any]]]:
        rep = SymbolReport(symbol=symbol, ok=False, rows_extracted=0)
        try:
            res = self.fetch_quarterly(symbol)
            if not res.ok:
                rep.error = f"fetch_quarterly: {res.error}"
                return rep, []
            bundle = res.value or {}
            rows = rows_from_bundle(bundle)
            if not rows:
                rep.error = "no quarterly rows extracted"
                return rep, []
            if rows[0].get("promoter_pledging_pct") is None:
                rep.warnings.append(
                    "pledging not on page (add 'Pledged percentage' quick "
                    "ratio on screener.in, or use the overrides CSV)")
            projected = [_project_row(symbol, r) for r in rows]
            rep.ok = True
            rep.rows_extracted = len(projected)
            return rep, projected
        except Exception as exc:  # noqa: BLE001
            rep.error = f"{type(exc).__name__}: {exc}"
            return rep, []

    def _preflight_login(self) -> Optional[str]:
        """Login ONCE before the loop when using the live fetcher, so a bad
        credential fails the run in seconds instead of burning the cooldown
        on 400+ identical failures. Returns an error string, or None."""
        if self.fetch_quarterly is not _default_fetch_quarterly:
            return None  # injected fetcher (tests) — no network, no login
        try:
            _get_screener_client().login()
            return None
        except Exception as exc:  # noqa: BLE001
            return f"{type(exc).__name__}: {exc}"

    def run_all(
        self,
        symbols: Sequence[str],
        as_of: Optional[date] = None,
        *,
        dry_run: bool = False,
    ) -> RunReport:
        as_of = as_of or date.today()
        started = datetime.now(timezone.utc)

        per_symbol: List[SymbolReport] = []
        all_rows: List[Dict[str, Any]] = []
        symbols_ok = 0
        symbols_failed = 0

        auth_error = self._preflight_login()
        if auth_error is not None:
            logger.error("screener auth failed — aborting run: %s", auth_error)
            for sym in symbols:
                per_symbol.append(SymbolReport(
                    symbol=sym, ok=False, rows_extracted=0,
                    error=f"screener auth: {auth_error}"))
            symbols_failed = len(per_symbol)
            symbols = []

        # Cooldown applies only to LIVE fetches (legacy throttle rule:
        # active above the threshold; small batches use a polite 0.5 s).
        live = self.fetch_quarterly is _default_fetch_quarterly
        cooldown = 0.0
        if live:
            cooldown = _cooldown_seconds() if len(symbols) > COOLDOWN_THRESHOLD else 0.5
            if len(symbols) > COOLDOWN_THRESHOLD:
                logger.info(
                    "screener cooldown ACTIVE: %d symbols x %.0fs ≈ %.0f min total",
                    len(symbols), cooldown, len(symbols) * cooldown / 60)

        for i, sym in enumerate(symbols):
            rep, rows = self.run_symbol(sym)
            per_symbol.append(rep)
            if rep.ok:
                symbols_ok += 1
                all_rows.extend(rows)
            else:
                symbols_failed += 1
            if (i + 1) % 10 == 0:
                logger.info("quarterly sync progress: %d/%d", i + 1, len(symbols))
            # Never sleep after the last symbol.
            if cooldown and i < len(symbols) - 1:
                time.sleep(cooldown)

        upsert_errors: List[str] = []
        rows_written = 0
        if all_rows and not dry_run:
            report = self.upsert(
                FUNDAMENTALS_TABLE, all_rows,
                conflict_cols=list(FUNDAMENTALS_CONFLICT),
                client=self.supabase_client,
            )
            rows_written = report.succeeded
            upsert_errors = list(report.errors)
            # Best-effort mark rows_written per symbol proportional to intake.
            if report.succeeded == report.total_rows:
                for rep in per_symbol:
                    if rep.ok:
                        rep.rows_written = rep.rows_extracted

        finished = datetime.now(timezone.utc)
        run_rep = RunReport(
            as_of_date=as_of,
            job_type=self.job_type,
            dry_run=dry_run,
            started_at=started,
            finished_at=finished,
            symbols_total=len(per_symbol),
            symbols_ok=symbols_ok,
            symbols_failed=symbols_failed,
            rows_written=rows_written,
            per_symbol=per_symbol,
            upsert_errors=upsert_errors,
        )

        if not dry_run:
            run_rep.sync_job_id = self._record_sync_job(run_rep)

        _log("quarterly.done", **{
            k: v for k, v in run_rep.as_json().items()
            if k not in ("per_symbol",)
        })
        return run_rep

    def _record_sync_job(self, r: RunReport) -> Optional[str]:
        job_id = str(uuid.uuid4())
        row = {
            "job_id": job_id,
            "job_type": r.job_type,
            "as_of_date": r.as_of_date.isoformat(),
            "started_at": r.started_at.isoformat(),
            "finished_at": r.finished_at.isoformat(),
            "status": "ok" if r.symbols_failed == 0 and not r.upsert_errors else "partial",
            "symbols_total": r.symbols_total,
            "symbols_ok": r.symbols_ok,
            "symbols_failed": r.symbols_failed,
            "snapshots_written": r.rows_written,   # reuse column for row count
            "payload_json": {
                "dry_run": r.dry_run,
                "duration_ms": int(
                    (r.finished_at - r.started_at).total_seconds() * 1000),
                "context": dict(self.run_context or {}),
                "upsert_errors": r.upsert_errors,
                "failed_symbols": {
                    s.symbol: s.error for s in r.per_symbol if not s.ok
                },
            },
        }
        known = {f.name for f in fields_for(SYNC_JOBS_TABLE)}
        if known:
            row = {k: v for k, v in row.items() if k in known}
        try:
            self.upsert(
                SYNC_JOBS_TABLE, [row],
                conflict_cols=list(SYNC_JOBS_CONFLICT),
                client=self.supabase_client,
            )
        except Exception as exc:  # noqa: BLE001
            _log("quarterly.jobs_write_failed",
                 error=f"{type(exc).__name__}: {exc}")
            return None
        return job_id


# ---------------------------------------------------------------------------
# Manual CSV upload — ROCE / ROE / promoter_pledging_pct
# ---------------------------------------------------------------------------
def apply_manual_overrides(
    csv_rows: Sequence[Dict[str, Any]],
    *,
    upsert: Callable[..., Any] = sb.bulk_upsert,
    client: Any = None,
) -> Dict[str, Any]:
    """
    Admin CSV round-trip: takes rows like
        {"symbol": "RELIANCE.NS", "quarter_end_date": "2024-09-30",
         "roce": 18.4, "roe": 12.1, "promoter_pledging_pct": 0.0}
    and upserts them into `fundamentals`, only over-writing the columns
    supplied. Symbol + quarter_end_date is the conflict key.
    """
    from decimal import Decimal

    normalized: List[Dict[str, Any]] = []
    errors: List[str] = []
    for raw in csv_rows:
        try:
            sym = str(raw["symbol"]).strip().upper()
            q = raw["quarter_end_date"]
            if isinstance(q, str):
                q = datetime.strptime(q[:10], "%Y-%m-%d").date()
            row: Dict[str, Any] = {"symbol": sym, "quarter_end_date": q,
                                   "promoter_holding_source": "manual",
                                   "data_source": "manual_csv"}
            for k in ("roce", "roe", "promoter_pledging_pct",
                     "promoter_holding_pct"):
                v = raw.get(k)
                if v not in (None, ""):
                    row[k] = Decimal(str(v))
            normalized.append(row)
        except Exception as exc:
            errors.append(f"{raw}: {exc}")

    if not normalized:
        return {"rows_written": 0, "errors": errors}

    report = upsert(
        FUNDAMENTALS_TABLE, normalized,
        conflict_cols=list(FUNDAMENTALS_CONFLICT),
        client=client,
    )
    errors.extend(report.errors)
    return {"rows_written": report.succeeded, "errors": errors}
