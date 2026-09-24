"""
Custom watchlists — /api/watchlists (migration 020).

Named, ordered symbol lists used by the browser extension's TradingView
panel (S1..S4 by default) and available to the web app. They are NOT pools:
membership here never feeds a scan and never touches `stocks`. Adding a
symbol to the PlayArea pool goes through /api/universe.

Contract (mirrors plutus.api.journal):
  * Behind the shared-credential gate — `/api/watchlists` is listed in
    plutus.api.auth.PROTECTED_PREFIXES, so viewers can read and only the
    owner can write. Anon has no RLS access to the table at all.
  * Symbols are normalised to yfinance form ("TCS.NS") with
    plutus.api.universe.canonical_symbol; unparseable entries are dropped,
    duplicates collapse (first occurrence wins, order preserved).
  * Field whitelist on every write; unknown keys are ignored.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from plutus.api.universe import canonical_symbol

logger = logging.getLogger(__name__)

WATCHLIST_FIELDS = {"name", "symbols", "display_order"}
MAX_NAME_LEN = 60
MAX_SYMBOLS = 500


def _rows(res: Any) -> List[Dict[str, Any]]:
    return list(getattr(res, "data", None) or [])


def normalise_symbols(raw: Any) -> List[str]:
    """Any iterable of ticker spellings -> unique canonical list, order kept."""
    if isinstance(raw, str):
        raw = [p for p in raw.replace(";", ",").replace("\n", ",").split(",")]
    if not isinstance(raw, (list, tuple)):
        return []
    out: List[str] = []
    seen = set()
    for item in raw:
        sym = canonical_symbol(item if isinstance(item, str) else None)
        if sym is None or sym in seen:
            continue
        seen.add(sym)
        out.append(sym)
        if len(out) >= MAX_SYMBOLS:
            break
    return out


def clean_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Whitelist + normalise a create/update body. Raises ValueError on a
    bad name so the route can answer 400."""
    out: Dict[str, Any] = {}
    for k, v in (payload or {}).items():
        if k not in WATCHLIST_FIELDS:
            continue
        if k == "name":
            if not isinstance(v, str) or not v.strip():
                raise ValueError("name is required")
            name = v.strip()
            if len(name) > MAX_NAME_LEN:
                raise ValueError(f"name longer than {MAX_NAME_LEN} characters")
            out["name"] = name
        elif k == "symbols":
            out["symbols"] = normalise_symbols(v)
        elif k == "display_order":
            try:
                out["display_order"] = int(v)
            except (TypeError, ValueError):
                raise ValueError("display_order must be an integer")
    return out


def register_watchlist_routes(app: Any, cli: Any) -> None:
    """Mount /api/watchlists on the FastAPI app."""
    from fastapi import Body, HTTPException

    from plutus.adapters import supabase_client as sb
    from plutus.api.serializers import serialize_rows, to_wire

    def client() -> Any:
        return cli() or sb.get_client()

    def guard(fn):
        import functools

        @functools.wraps(fn)
        def inner(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except HTTPException:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.exception("watchlists route failed: %s", fn.__name__)
                raise HTTPException(status_code=502, detail=str(exc))
        return inner

    def _all() -> List[Dict[str, Any]]:
        return _rows(client().table("watchlists").select("*")
                     .order("display_order").order("id").limit(200).execute())

    def _one(wl_id: int) -> Optional[Dict[str, Any]]:
        rows = _rows(client().table("watchlists").select("*")
                     .eq("id", wl_id).limit(1).execute())
        return rows[0] if rows else None

    def _name_taken(name: str, exclude_id: Optional[int] = None) -> bool:
        for r in _all():
            if str(r.get("name", "")).lower() == name.lower() and r.get("id") != exclude_id:
                return True
        return False

    @app.get("/api/watchlists")
    @guard
    def list_watchlists() -> dict:
        rows = _all()
        return {"watchlists": serialize_rows(rows), "count": len(rows)}

    @app.post("/api/watchlists")
    @guard
    def create_watchlist(payload: dict = Body(...)) -> dict:
        try:
            row = clean_payload(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if "name" not in row:
            raise HTTPException(status_code=400, detail="name is required")
        if _name_taken(row["name"]):
            raise HTTPException(status_code=409, detail=f"a watchlist named {row['name']!r} exists")
        row.setdefault("symbols", [])
        if "display_order" not in row:
            existing = _all()
            row["display_order"] = (max([int(r.get("display_order") or 0) for r in existing] or [0]) + 10)
        rows = _rows(client().table("watchlists").insert(row).execute())
        return {"watchlist": to_wire(rows[0] if rows else row)}

    @app.put("/api/watchlists/{wl_id}")
    @guard
    def update_watchlist(wl_id: int, payload: dict = Body(...)) -> dict:
        try:
            patch = clean_payload(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not patch:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        if _one(wl_id) is None:
            raise HTTPException(status_code=404, detail=f"watchlist {wl_id} not found")
        if "name" in patch and _name_taken(patch["name"], exclude_id=wl_id):
            raise HTTPException(status_code=409, detail=f"a watchlist named {patch['name']!r} exists")
        rows = _rows(client().table("watchlists").update(patch).eq("id", wl_id).execute())
        return {"watchlist": to_wire(rows[0] if rows else {**_one(wl_id), **patch})}

    @app.post("/api/watchlists/{wl_id}/symbols")
    @guard
    def add_symbols(wl_id: int, payload: dict = Body(...)) -> dict:
        """Append symbols (idempotent). Body: {"symbols": [...]} or {"symbol": "TCS"}."""
        row = _one(wl_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"watchlist {wl_id} not found")
        incoming = payload.get("symbols")
        if incoming is None and payload.get("symbol") is not None:
            incoming = [payload.get("symbol")]
        add = normalise_symbols(incoming)
        if not add:
            raise HTTPException(status_code=400, detail="no valid symbols in payload")
        merged = normalise_symbols(list(row.get("symbols") or []) + add)
        rows = _rows(client().table("watchlists").update({"symbols": merged})
                     .eq("id", wl_id).execute())
        return {"watchlist": to_wire(rows[0] if rows else {**row, "symbols": merged}),
                "added": [s for s in add if s not in (row.get("symbols") or [])]}

    @app.delete("/api/watchlists/{wl_id}/symbols/{symbol}")
    @guard
    def remove_symbol(wl_id: int, symbol: str) -> dict:
        row = _one(wl_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"watchlist {wl_id} not found")
        sym = canonical_symbol(symbol)
        remaining = [s for s in (row.get("symbols") or []) if s != sym]
        rows = _rows(client().table("watchlists").update({"symbols": remaining})
                     .eq("id", wl_id).execute())
        return {"watchlist": to_wire(rows[0] if rows else {**row, "symbols": remaining}),
                "removed": sym if sym not in remaining and sym in (row.get("symbols") or []) else None}

    @app.delete("/api/watchlists/{wl_id}")
    @guard
    def delete_watchlist(wl_id: int) -> dict:
        if _one(wl_id) is None:
            raise HTTPException(status_code=404, detail=f"watchlist {wl_id} not found")
        client().table("watchlists").delete().eq("id", wl_id).execute()
        return {"deleted": wl_id}
