"""
Quarterly Sync Worker — Plutus Stage 5.

Shape mirrors Stage 4's DailySyncWorker:
    * `run_symbol(symbol)` — fetch quarterly_financials + info + holders,
      extract registry-shaped rows, return them. Never raises.
    * `run_all(symbols)`   — iterate, batch upsert to `fundamentals`,
      write one `sync_jobs` row.

Trigger cadence: manual button ("Sync Fundamentals") or scheduled quarterly
via pg_cron. Not tied to trading calendar — safe to run any day.
"""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field as dc_field
from datetime import date, datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence

from plutus.adapters import supabase_client as sb
from plutus.adapters.result import Result
from plutus.fundamentals.quarterly import extract_quarterly_rows
from plutus.registry.fields import fields_for
from plutus.sync.worker import _log, SYNC_JOBS_CONFLICT, SYNC_JOBS_TABLE

logger = logging.getLogger(__name__)

FUNDAMENTALS_TABLE = "fundamentals"
FUNDAMENTALS_CONFLICT = ("symbol", "quarter_end_date")
DEFAULT_JOB_TYPE = "quarterly_sync"


# ---------------------------------------------------------------------------
# yfinance quarterly fetcher (dependency-injected for tests)
# ---------------------------------------------------------------------------
def _default_fetch_quarterly(symbol: str) -> Result[Dict[str, Any]]:
    """Live yfinance fetch — returns dict of DataFrames + info."""
    from plutus.adapters.yf_client import _retry, _yf
    from plutus.adapters.validators import sanity_check_symbol

    try:
        sym = sanity_check_symbol(symbol)
    except ValueError as exc:
        return Result.failure(str(exc), symbol=symbol, attempts=0)

    def _do() -> Dict[str, Any]:
        ticker = _yf().Ticker(sym)
        return {
            "info": dict(ticker.info) if ticker.info else {},
            "quarterly_financials": ticker.quarterly_financials,
            "major_holders": ticker.major_holders,
        }

    return _retry(_do, symbol=sym, op="quarterly")


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

    def run_symbol(self, symbol: str) -> tuple[SymbolReport, List[Dict[str, Any]]]:
        rep = SymbolReport(symbol=symbol, ok=False, rows_extracted=0)
        try:
            res = self.fetch_quarterly(symbol)
            if not res.ok:
                rep.error = f"fetch_quarterly: {res.error}"
                return rep, []
            payload = res.value or {}
            rows = extract_quarterly_rows(
                payload.get("quarterly_financials"),
                info=payload.get("info"),
                major_holders=payload.get("major_holders"),
            )
            if not rows:
                rep.error = "no quarterly rows extracted"
                return rep, []
            projected = [_project_row(symbol, r) for r in rows]
            rep.ok = True
            rep.rows_extracted = len(projected)
            return rep, projected
        except Exception as exc:  # noqa: BLE001
            rep.error = f"{type(exc).__name__}: {exc}"
            return rep, []

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

        for sym in symbols:
            rep, rows = self.run_symbol(sym)
            per_symbol.append(rep)
            if rep.ok:
                symbols_ok += 1
                all_rows.extend(rows)
            else:
                symbols_failed += 1

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
