"""
Read-only Supabase repository for the API.

Every function:
  * takes an optional ``client`` for test injection,
  * returns plain ``list[dict]`` / ``dict`` (no ORM),
  * never writes, never mutates,
  * never raises for empty result sets (returns [] / None).

Kept intentionally thin — no computation. All money math already lives in
plutus.metrics / plutus.scan, and their results are persisted to Supabase.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional, Sequence

from plutus.adapters import supabase_client as sb


# --- helpers -----------------------------------------------------------------

def _client(client: Optional[Any] = None) -> Any:
    return client if client is not None else sb.get_client()


def _rows(execute_result: Any) -> List[Dict[str, Any]]:
    return list(getattr(execute_result, "data", None) or [])


def _one(execute_result: Any) -> Optional[Dict[str, Any]]:
    rows = _rows(execute_result)
    return rows[0] if rows else None


# --- Pools -------------------------------------------------------------------

def list_pools(client: Optional[Any] = None) -> List[Dict[str, Any]]:
    cli = _client(client)
    res = (
        cli.table("pools")
           .select("code,name,description,display_order,strategies,metadata")
           .order("display_order")
           .execute()
    )
    return _rows(res)


# --- Stocks ------------------------------------------------------------------

def list_stocks(
    pool_code: Optional[str] = None,
    *,
    active_only: bool = True,
    limit: int = 500,
    client: Optional[Any] = None,
) -> List[Dict[str, Any]]:
    cli = _client(client)
    q = cli.table("stocks").select(
        "id,symbol,name,sector,industry,exchange,active,pools,cap_type_manual,"
        "sector_group,metadata"
    )
    if active_only:
        q = q.eq("active", True)
    # Filter BEFORE limiting: a Python-side pool filter after .limit() would
    # truncate the universe first and return far fewer pool rows than asked.
    # .contains uses the GIN index on `pools`.
    if pool_code:
        try:
            q = q.contains("pools", [pool_code])
        except (AttributeError, TypeError):
            # Fake clients in tests may not implement .contains — fall back
            # to the Python-side filter (test data is small).
            res = q.limit(limit).execute()
            rows = _rows(res)
            return [r for r in rows if pool_code in (r.get("pools") or [])]
    res = q.limit(limit).execute()
    return _rows(res)


def get_stock(symbol: str, client: Optional[Any] = None) -> Optional[Dict[str, Any]]:
    cli = _client(client)
    res = (
        cli.table("stocks")
           .select("*")
           .eq("symbol", symbol)
           .limit(1)
           .execute()
    )
    return _one(res)


# --- Snapshots ---------------------------------------------------------------

def latest_snapshot_date(client: Optional[Any] = None) -> Optional[str]:
    cli = _client(client)
    res = (
        cli.table("daily_snapshots")
           .select("snapshot_date")
           .order("snapshot_date", desc=True)
           .limit(1)
           .execute()
    )
    row = _one(res)
    return row.get("snapshot_date") if row else None


def snapshots_for_pool(
    pool_code: str,
    snapshot_date: Optional[str] = None,
    *,
    client: Optional[Any] = None,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    cli = _client(client)
    stocks = list_stocks(pool_code=pool_code, client=cli, limit=1000)
    symbols = [s["symbol"] for s in stocks]
    if not symbols:
        return []
    d = snapshot_date or latest_snapshot_date(client=cli)
    if not d:
        return []
    res = (
        cli.table("daily_snapshots")
           .select("*")
           .in_("symbol", symbols)
           .eq("snapshot_date", d)
           .limit(limit)
           .execute()
    )
    return _rows(res)


def snapshots_for_symbols(
    symbols: Sequence[str],
    snapshot_date: Optional[str] = None,
    *,
    client: Optional[Any] = None,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    """Latest (or given-date) snapshots for an explicit symbol list —
    powers the PlayArea watchlist, which is not a DB pool."""
    cli = _client(client)
    symbols = [s for s in symbols if s]
    if not symbols:
        return []
    d = snapshot_date or latest_snapshot_date(client=cli)
    if not d:
        return []
    res = (
        cli.table("daily_snapshots")
           .select("*")
           .in_("symbol", symbols)
           .eq("snapshot_date", d)
           .limit(limit)
           .execute()
    )
    return _rows(res)


def snapshot_history(
    symbol: str,
    *,
    days: int = 60,
    client: Optional[Any] = None,
) -> List[Dict[str, Any]]:
    cli = _client(client)
    res = (
        cli.table("daily_snapshots")
           .select("snapshot_date,open,high,low,close,adj_close,volume")
           .eq("symbol", symbol)
           .order("snapshot_date", desc=True)
           .limit(max(1, min(days, 1000)))
           .execute()
    )
    return _rows(res)


# --- Scans -------------------------------------------------------------------

def latest_scan(
    pool_code: str, client: Optional[Any] = None
) -> Optional[Dict[str, Any]]:
    cli = _client(client)
    res = (
        cli.table("scans")
           .select("*")
           .eq("pool_code", pool_code)
           .order("snapshot_date", desc=True)
           .order("started_at", desc=True)
           .limit(1)
           .execute()
    )
    return _one(res)


def scan_results(
    scan_id: str,
    *,
    strategy_id: Optional[str] = None,
    status_in: Optional[Sequence[str]] = None,
    client: Optional[Any] = None,
) -> List[Dict[str, Any]]:
    cli = _client(client)

    # Paginated: an S200 scan writes ~426 symbols x 4 strategies = ~1,700
    # rows, and a single .execute() stops at PostgREST's 1,000-row cap —
    # the pool table then showed "not scored yet" dashes for whichever
    # symbols fell past the cap (2026-09-25). Ordered by id so the page
    # boundaries are deterministic.
    def build():
        q = cli.table("scan_results").select("*").eq("scan_id", scan_id)
        if strategy_id:
            q = q.eq("strategy_id", strategy_id)
        if status_in:
            q = q.in_("status", list(status_in))
        return q.order("id")

    return sb.fetch_all(build)


def latest_scan_results_for_symbols(
    symbols: Sequence[str],
    *,
    client: Optional[Any] = None,
) -> List[Dict[str, Any]]:
    """Most recent scan result per (symbol, strategy) across ANY pool scan.

    PlayArea symbols carry no pool scan of their own; their signals come
    from whichever pool scan (F40/E40/S200) last evaluated them. Rows are
    fetched newest-first and de-duplicated per (symbol, strategy_id)."""
    cli = _client(client)
    symbols = [s for s in symbols if s]
    if not symbols:
        return []
    res = (
        cli.table("scan_results")
           .select("*")
           .in_("symbol", symbols)
           .order("id", desc=True)
           .limit(2000)
           .execute()
    )
    rows = _rows(res)
    seen: Dict[Any, Dict[str, Any]] = {}
    for r in rows:  # newest first — first hit wins
        key = (r.get("symbol"), r.get("strategy_id"))
        if key not in seen:
            seen[key] = r
    return list(seen.values())


# --- Sync jobs ---------------------------------------------------------------

def latest_sync_jobs(
    job_type: Optional[str] = None,
    *,
    limit: int = 10,
    client: Optional[Any] = None,
) -> List[Dict[str, Any]]:
    cli = _client(client)
    q = cli.table("sync_jobs").select("*")
    if job_type:
        q = q.eq("job_type", job_type)
    res = q.order("started_at", desc=True).limit(limit).execute()
    return _rows(res)


# --- Fundamentals ------------------------------------------------------------

def latest_fundamentals(
    symbol: str, client: Optional[Any] = None
) -> Optional[Dict[str, Any]]:
    cli = _client(client)
    res = (
        cli.table("fundamentals")
           .select("*")
           .eq("symbol", symbol)
           .order("quarter_end_date", desc=True)
           .limit(1)
           .execute()
    )
    return _one(res)
