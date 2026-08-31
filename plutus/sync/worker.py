"""
Daily Sync Worker — Plutus Stage 4.

Contract (per Plan §7 and Phased-Development §Stage 4):
  * `run_symbol(symbol)` — fetch, validate, compute, upsert. Never raises.
    Returns a small dict describing what happened. Per-symbol isolation.
  * `run_all(symbols)` — iterates run_symbol, writes a single sync_jobs
    row with per-symbol errors JSONB. Idempotent same-day rerun (uses
    conflict cols on both daily_snapshots and sync_jobs).
  * Dry-run mode:  no upserts, no sync_jobs write; still returns the same
    report shape so the CLI can diff before committing.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass, field as dc_field
from datetime import date, datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

from plutus.adapters import supabase_client as sb
from plutus.adapters import yf_client as yf
from plutus.adapters.result import Result
from plutus.metrics.pipeline import SnapshotInputs, compute_snapshot
from plutus.registry.fields import fields_for
from plutus.sync.history_builder import bars_from_df, extract_meta

logger = logging.getLogger(__name__)

# --- Configuration knobs (kept module-level so tests can monkey-patch) -------
SNAPSHOT_TABLE = "daily_snapshots"
SNAPSHOT_CONFLICT = ("symbol", "snapshot_date")
SYNC_JOBS_TABLE = "sync_jobs"
SYNC_JOBS_CONFLICT = ("job_type", "as_of_date")
DEFAULT_JOB_TYPE = "daily_sync"


# ---------------------------------------------------------------------------
# Small report types
# ---------------------------------------------------------------------------
@dataclass
class SymbolReport:
    symbol: str
    ok: bool
    snapshot_written: bool
    fetch_attempts: int
    warnings: List[str] = dc_field(default_factory=list)
    error: Optional[str] = None

    def as_json(self) -> Dict[str, Any]:
        return {
            "symbol": self.symbol,
            "ok": self.ok,
            "snapshot_written": self.snapshot_written,
            "fetch_attempts": self.fetch_attempts,
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
    snapshots_written: int
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
            "snapshots_written": self.snapshots_written,
            "per_symbol": [s.as_json() for s in self.per_symbol],
            "upsert_errors": list(self.upsert_errors),
            "sync_job_id": self.sync_job_id,
        }


# ---------------------------------------------------------------------------
# Registry-driven row projection
# ---------------------------------------------------------------------------
_SNAPSHOT_FIELDS = tuple(f.name for f in fields_for(SNAPSHOT_TABLE))


def _project_to_snapshot_row(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """
    Drop keys not in the daily_snapshots registry AND capture `errors` into
    a JSONB-friendly `errors_json` column when the schema has it.

    Only registry-declared column names are sent to Supabase — this is the
    grep-gate that stops any drift between metrics code and the DB.
    """
    row: Dict[str, Any] = {}
    for k in _SNAPSHOT_FIELDS:
        if k in snapshot:
            row[k] = snapshot[k]
    # `errors` is book-keeping — carry it as JSONB payload if the migration
    # exposes an `errors_json` column, else drop it.
    if "errors_json" in _SNAPSHOT_FIELDS:
        row["errors_json"] = snapshot.get("errors") or []
    return row


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------
@dataclass
class DailySyncWorker:
    """Orchestrates one daily sync run."""

    supabase_client: Any = None                  # injected supabase.Client
    fetch_info: Callable[[str], Result[Dict[str, Any]]] = yf.fetch_info
    fetch_history: Callable[..., Result[Any]] = yf.fetch_history
    upsert: Callable[..., Any] = sb.bulk_upsert
    job_type: str = DEFAULT_JOB_TYPE

    # ---- Single symbol ----------------------------------------------------
    def run_symbol(
        self,
        symbol: str,
        as_of: date,
        *,
        dry_run: bool = False,
    ) -> tuple[SymbolReport, Optional[Dict[str, Any]]]:
        """
        Returns (report, snapshot_row_or_None).

        The row is None when the pipeline produced no snapshot (empty history
        or malformed inputs).  The caller batches all non-None rows into one
        upsert call at end-of-run for efficiency.
        """
        rep = SymbolReport(symbol=symbol, ok=False,
                           snapshot_written=False, fetch_attempts=0)
        try:
            info_res = self.fetch_info(symbol)
            hist_res = self.fetch_history(symbol)
            rep.fetch_attempts = (info_res.attempts or 0) + (hist_res.attempts or 0)

            if not info_res.ok:
                rep.error = f"fetch_info: {info_res.error}"
                return rep, None
            if not hist_res.ok:
                rep.error = f"fetch_history: {hist_res.error}"
                return rep, None

            bars = bars_from_df(hist_res.value)
            if not bars:
                rep.error = "empty history after normalisation"
                return rep, None

            meta = extract_meta(info_res.value or {})
            inputs = SnapshotInputs(
                symbol=symbol,
                snapshot_date=as_of,
                bars=bars,
                info=info_res.value or {},
                meta=meta,
            )
            snap = compute_snapshot(inputs)
            if snap.get("errors"):
                rep.warnings = list(snap["errors"])
            row = _project_to_snapshot_row(snap)
            rep.ok = True
            rep.snapshot_written = not dry_run
            return rep, row

        except Exception as exc:  # noqa: BLE001 — worker MUST NOT raise
            rep.error = f"{type(exc).__name__}: {exc}"
            return rep, None

    # ---- Full run ---------------------------------------------------------
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
        rows_to_write: List[Dict[str, Any]] = []
        symbols_ok = 0
        symbols_failed = 0

        for sym in symbols:
            rep, row = self.run_symbol(sym, as_of, dry_run=dry_run)
            per_symbol.append(rep)
            if rep.ok:
                symbols_ok += 1
                if row is not None:
                    rows_to_write.append(row)
            else:
                symbols_failed += 1

        upsert_errors: List[str] = []
        snapshots_written = 0
        if rows_to_write and not dry_run:
            report = self.upsert(
                SNAPSHOT_TABLE, rows_to_write,
                conflict_cols=list(SNAPSHOT_CONFLICT),
                client=self.supabase_client,
            )
            snapshots_written = report.succeeded
            upsert_errors = list(report.errors)
            # Mark any per-symbol reports whose write actually failed.
            if report.failed:
                # We do not have per-row error mapping from PostgREST; mark the
                # last-N rows as un-written if the failure count matches.
                # Best-effort: only mutate the `snapshot_written` flag.
                fail_marker = report.failed
                for rep in reversed(per_symbol):
                    if rep.snapshot_written and fail_marker > 0:
                        rep.snapshot_written = False
                        rep.error = rep.error or "upsert failed"
                        fail_marker -= 1

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
            snapshots_written=snapshots_written,
            per_symbol=per_symbol,
            upsert_errors=upsert_errors,
        )

        if not dry_run:
            run_rep.sync_job_id = self._record_sync_job(run_rep)

        _log("sync.done", **{
            k: v for k, v in run_rep.as_json().items()
            if k not in ("per_symbol",)
        })
        return run_rep

    # ---- sync_jobs bookkeeping -------------------------------------------
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
            "snapshots_written": r.snapshots_written,
            "payload_json": {
                "dry_run": r.dry_run,
                "upsert_errors": r.upsert_errors,
                "failed_symbols": {
                    s.symbol: s.error for s in r.per_symbol if not s.ok
                },
            },
        }
        # Only include registry-known columns.
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
            _log("sync.jobs_write_failed", error=f"{type(exc).__name__}: {exc}")
            return None
        return job_id


# ---------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------
def _log(event: str, **fields: Any) -> None:
    try:
        logger.info(json.dumps({"event": event, **fields}, default=str))
    except Exception:
        logger.info("event=%s %s", event, fields)
