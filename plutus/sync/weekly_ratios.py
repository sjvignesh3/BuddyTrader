"""
Weekly Ratios Sync — Screener.in PE / PB / Market Cap -> `screener_ratios`.

Source decision (2026-09-01): valuation ratios come from Screener.in on a
WEEKLY cadence (Saturday 05:00 IST workflow). The DAILY sync then stamps
the latest stored values into every day's `daily_snapshots` row, so scans
compare Screener PE against Screener 5Y-avg PE — same source, same TTM
convention (the rule legacy Buddy enforced).

Shape mirrors the quarterly worker: pre-flight login, per-symbol isolation,
15 s cooldown between live fetches (>5 symbols), `sync_jobs` audit row.
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field as dc_field
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Dict, List, Optional, Sequence

from plutus.adapters import supabase_client as sb
from plutus.adapters.result import Result
from plutus.registry.types import round_half_up
from plutus.sync.quarterly import COOLDOWN_THRESHOLD, _cooldown_seconds
from plutus.sync.worker import _log, SYNC_JOBS_CONFLICT, SYNC_JOBS_TABLE

logger = logging.getLogger(__name__)

RATIOS_TABLE = "screener_ratios"
RATIOS_CONFLICT = ("symbol",)
DEFAULT_JOB_TYPE = "weekly_ratios"

_CRORE = Decimal(10_000_000)


def _default_fetch_ratios(symbol: str) -> Result[Dict[str, Any]]:
    from plutus.adapters.validators import sanity_check_symbol
    from plutus.sync.quarterly import _get_screener_client

    try:
        sym = sanity_check_symbol(symbol)
    except ValueError as exc:
        return Result.failure(str(exc), symbol=symbol, attempts=0)
    started = time.monotonic()
    try:
        ratios = _get_screener_client().fetch_ratios_only(sym)
        latency = int((time.monotonic() - started) * 1000)
        return Result.success(ratios, symbol=sym, attempts=1, latency_ms=latency)
    except Exception as exc:  # noqa: BLE001 — per-symbol isolation
        latency = int((time.monotonic() - started) * 1000)
        return Result.failure(f"{type(exc).__name__}: {exc}", symbol=sym,
                              attempts=1, latency_ms=latency)


def row_from_ratios(symbol: str, ratios: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Ratios dict (screener_page.extract_ratios) -> screener_ratios row.
    Returns None when the page yielded nothing usable."""
    mcap_cr = ratios.get("market_cap_cr")
    pe = ratios.get("current_pe")
    pb = ratios.get("current_pb")
    if mcap_cr is None and pe is None and pb is None:
        return None
    return {
        "symbol": symbol,
        "market_cap": round_half_up(mcap_cr * _CRORE, 2) if mcap_cr is not None else None,
        "pe": pe,
        "pb": pb,
        "current_price": ratios.get("current_price"),
        "book_value": ratios.get("book_value"),
        "raw_ratios": {str(k): str(v)
                       for k, v in (ratios.get("_raw_map") or {}).items()},
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


@dataclass
class SymbolReport:
    symbol: str
    ok: bool
    error: Optional[str] = None

    def as_json(self) -> Dict[str, Any]:
        return {"symbol": self.symbol, "ok": self.ok, "error": self.error}


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
            "duration_ms": int((self.finished_at - self.started_at).total_seconds() * 1000),
            "symbols_total": self.symbols_total,
            "symbols_ok": self.symbols_ok,
            "symbols_failed": self.symbols_failed,
            "rows_written": self.rows_written,
            "per_symbol": [s.as_json() for s in self.per_symbol],
            "upsert_errors": list(self.upsert_errors),
            "sync_job_id": self.sync_job_id,
        }


@dataclass
class WeeklyRatiosWorker:
    supabase_client: Any = None
    fetch_ratios: Callable[[str], Result[Dict[str, Any]]] = _default_fetch_ratios
    upsert: Callable[..., Any] = sb.bulk_upsert
    job_type: str = DEFAULT_JOB_TYPE
    # Stamped into sync_jobs.payload_json["context"] — trigger/pool/symbols.
    run_context: Optional[Dict[str, Any]] = None

    def _preflight_login(self) -> Optional[str]:
        if self.fetch_ratios is not _default_fetch_ratios:
            return None
        try:
            from plutus.sync.quarterly import _get_screener_client
            _get_screener_client().login()
            return None
        except Exception as exc:  # noqa: BLE001
            return f"{type(exc).__name__}: {exc}"

    def run_all(self, symbols: Sequence[str], as_of: Optional[date] = None,
                *, dry_run: bool = False) -> RunReport:
        as_of = as_of or date.today()
        started = datetime.now(timezone.utc)
        per_symbol: List[SymbolReport] = []
        rows: List[Dict[str, Any]] = []
        ok = failed = 0

        auth_error = self._preflight_login()
        if auth_error is not None:
            logger.error("screener auth failed — aborting run: %s", auth_error)
            for sym in symbols:
                per_symbol.append(SymbolReport(
                    symbol=sym, ok=False, error=f"screener auth: {auth_error}"))
            failed = len(per_symbol)
            symbols = []

        live = self.fetch_ratios is _default_fetch_ratios
        cooldown = 0.0
        if live:
            cooldown = _cooldown_seconds() if len(symbols) > COOLDOWN_THRESHOLD else 0.5
            if len(symbols) > COOLDOWN_THRESHOLD:
                logger.info("weekly ratios cooldown ACTIVE: %d symbols x %.0fs",
                            len(symbols), cooldown)

        for i, sym in enumerate(symbols):
            res = self.fetch_ratios(sym)
            if res.ok:
                row = row_from_ratios(sym, res.value or {})
                if row is not None:
                    rows.append(row)
                    per_symbol.append(SymbolReport(symbol=sym, ok=True))
                    ok += 1
                else:
                    per_symbol.append(SymbolReport(
                        symbol=sym, ok=False, error="no ratios on page"))
                    failed += 1
            else:
                per_symbol.append(SymbolReport(symbol=sym, ok=False,
                                               error=res.error))
                failed += 1
            if (i + 1) % 10 == 0:
                logger.info("weekly ratios progress: %d/%d", i + 1, len(symbols))
            if cooldown and i < len(symbols) - 1:
                time.sleep(cooldown)

        upsert_errors: List[str] = []
        rows_written = 0
        if rows and not dry_run:
            report = self.upsert(RATIOS_TABLE, rows,
                                 conflict_cols=list(RATIOS_CONFLICT),
                                 client=self.supabase_client)
            rows_written = report.succeeded
            upsert_errors = list(report.errors)

        finished = datetime.now(timezone.utc)
        rep = RunReport(
            as_of_date=as_of, job_type=self.job_type, dry_run=dry_run,
            started_at=started, finished_at=finished,
            symbols_total=len(per_symbol), symbols_ok=ok, symbols_failed=failed,
            rows_written=rows_written, per_symbol=per_symbol,
            upsert_errors=upsert_errors,
        )
        if not dry_run:
            rep.sync_job_id = self._record_sync_job(rep)
        _log("weekly_ratios.done", **{k: v for k, v in rep.as_json().items()
                                      if k != "per_symbol"})
        return rep

    def _record_sync_job(self, r: RunReport) -> Optional[str]:
        from plutus.registry.fields import fields_for
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
            "snapshots_written": r.rows_written,
            "payload_json": {
                "dry_run": r.dry_run,
                "duration_ms": int(
                    (r.finished_at - r.started_at).total_seconds() * 1000),
                "context": dict(self.run_context or {}),
                "upsert_errors": r.upsert_errors,
                "failed_symbols": {s.symbol: s.error
                                   for s in r.per_symbol if not s.ok},
            },
        }
        known = {f.name for f in fields_for(SYNC_JOBS_TABLE)}
        if known:
            row = {k: v for k, v in row.items() if k in known}
        try:
            self.upsert(SYNC_JOBS_TABLE, [row],
                        conflict_cols=list(SYNC_JOBS_CONFLICT),
                        client=self.supabase_client)
        except Exception as exc:  # noqa: BLE001
            _log("weekly_ratios.jobs_write_failed",
                 error=f"{type(exc).__name__}: {exc}")
            return None
        return job_id
