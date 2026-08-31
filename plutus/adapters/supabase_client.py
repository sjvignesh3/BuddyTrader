"""
Thin Supabase wrapper — bulk upsert with chunking and retry accounting.

DESIGN CONTRACT:
  - No ORM. Rows are plain dicts shaped from the field registry.
  - Every write is idempotent — callers supply the conflict column list.
  - Bulk writes are chunked (default 500 rows) to stay under PostgREST limits.
  - Failures are counted, not raised — the sync worker decides policy.
  - Client construction is lazy so tests can run without env vars.
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence

from plutus.adapters.result import Result
from plutus.config import get_settings

logger = logging.getLogger(__name__)

DEFAULT_CHUNK_SIZE = 500
MAX_UPSERT_ATTEMPTS = 3
BACKOFF_SECONDS = 0.75


@dataclass(frozen=True)
class UpsertReport:
    """Aggregate outcome of a bulk upsert."""
    table: str
    total_rows: int
    succeeded: int
    failed: int
    chunks: int
    latency_ms: int
    errors: List[str]

    @property
    def ok(self) -> bool:
        return self.failed == 0


# -----------------------------------------------------------------------------
# Lazy client construction
# -----------------------------------------------------------------------------

_client_singleton: Optional[Any] = None


def get_client() -> Any:
    """
    Return a memoised supabase.Client using the service-role key.

    Lazy import so the module can be unit-tested without the `supabase` package
    or env vars being present.
    """
    global _client_singleton
    if _client_singleton is not None:
        return _client_singleton

    from supabase import create_client  # noqa: WPS433 — lazy on purpose

    cfg = get_settings()
    _client_singleton = create_client(cfg.supabase_url, cfg.supabase_service_key)
    return _client_singleton


def reset_client() -> None:
    """Test hook — drops the memoised client."""
    global _client_singleton
    _client_singleton = None


# -----------------------------------------------------------------------------
# Chunking helper
# -----------------------------------------------------------------------------

def _chunked(rows: Sequence[Dict[str, Any]], size: int) -> Iterable[List[Dict[str, Any]]]:
    for start in range(0, len(rows), size):
        yield list(rows[start:start + size])


# -----------------------------------------------------------------------------
# Wire coercion — PostgREST bodies go through json.dumps, which cannot
# serialise Decimal / date / datetime. Money-safety contract: Decimals are
# sent as STRINGS (Postgres casts them to NUMERIC losslessly); dates as ISO.
# -----------------------------------------------------------------------------

def _json_safe_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _json_safe_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe_value(v) for v in value]
    return value


def _json_safe_rows(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [{k: _json_safe_value(v) for k, v in row.items()} for row in rows]


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------

def bulk_upsert(table: str,
                rows: Sequence[Dict[str, Any]],
                *,
                conflict_cols: Sequence[str],
                chunk_size: int = DEFAULT_CHUNK_SIZE,
                client: Optional[Any] = None) -> UpsertReport:
    """
    Chunked, retried upsert.

    Args:
        table:         table name (e.g. "stocks", "daily_snapshots").
        rows:          list of dicts. Keys must match column names in the registry.
        conflict_cols: columns that form the natural key for ON CONFLICT.
        chunk_size:    rows per HTTP call.
        client:        optional supabase.Client (dependency injection for tests).

    Returns:
        UpsertReport summarising the operation. Never raises for row-level
        errors — the caller inspects .ok / .errors and decides policy.
    """
    if not rows:
        return UpsertReport(table=table, total_rows=0, succeeded=0,
                            failed=0, chunks=0, latency_ms=0, errors=[])

    if not conflict_cols:
        raise ValueError("conflict_cols must be non-empty (idempotency guarantee)")

    cli = client if client is not None else get_client()
    conflict_str = ",".join(conflict_cols)
    rows = _json_safe_rows(rows)
    started = time.monotonic()
    succeeded = 0
    failed = 0
    errors: List[str] = []
    chunks = 0

    for chunk in _chunked(rows, chunk_size):
        chunks += 1
        ok = _upsert_chunk_with_retry(cli, table, chunk, conflict_str, errors)
        if ok:
            succeeded += len(chunk)
        else:
            failed += len(chunk)

    latency = int((time.monotonic() - started) * 1000)
    report = UpsertReport(
        table=table,
        total_rows=len(rows),
        succeeded=succeeded,
        failed=failed,
        chunks=chunks,
        latency_ms=latency,
        errors=errors,
    )
    _log("supabase.upsert_done", table=table, total=len(rows),
         succeeded=succeeded, failed=failed, chunks=chunks,
         latency_ms=latency)
    return report


def _upsert_chunk_with_retry(client: Any, table: str,
                             chunk: List[Dict[str, Any]],
                             conflict_str: str,
                             errors: List[str]) -> bool:
    """Attempt one chunk with bounded retries. Returns True on success."""
    for attempt in range(1, MAX_UPSERT_ATTEMPTS + 1):
        try:
            client.table(table).upsert(chunk, on_conflict=conflict_str).execute()
            return True
        except Exception as exc:  # noqa: BLE001 — capture, retry, escalate
            err = f"{type(exc).__name__}: {exc}"
            _log("supabase.upsert_err", table=table, attempt=attempt,
                 chunk_size=len(chunk), error=err)
            # Schema/constraint errors (PG class 42/23, e.g. 42P10 bad
            # ON CONFLICT, 23502 NOT NULL) are permanent — retrying only
            # burns time. Fail the chunk immediately.
            code = str(getattr(exc, "code", "") or "")
            permanent = code[:2] in ("42", "23", "22")
            if permanent or attempt >= MAX_UPSERT_ATTEMPTS:
                errors.append(err)
                return False
            time.sleep(BACKOFF_SECONDS * attempt)
    return False


def _log(event: str, **fields: Any) -> None:
    try:
        logger.info(json.dumps({"event": event, **fields}, default=str))
    except Exception:
        logger.info("event=%s %s", event, fields)
