"""
Notes page routes — /api/journal/notebook (migration 025).

One flat list of personal items: tasks, targets / limits, watch ideas, free
notes and Plutus change ideas. ``kind`` is the only thing that separates them.

Design contract (mirrors plutus.api.ipo):
  * Personal tool behind the shared-credential gate — the paths sit under
    /api/journal/*, so viewers can read and only the owner can write. Anon
    has no access to the table.
  * The test fake does not enforce CHECK constraints, so every rule in 025
    is re-checked here and surfaces as a readable 400, never a 502.
  * Field whitelist on every write; unknown keys are ignored.
  * ``symbol`` is free text tagged by ``market``: an NSE symbol for IN (a
    trailing .NS / .BO is dropped), a US ticker for US. It is never checked
    against the universe, which is NSE-only.
  * Nothing is derived or priced — a target is text, not an alert. Ordering
    and grouping (pinned / open / done) live in the frontend (lib/notebook.ts).
"""
from __future__ import annotations

import logging
import re
from datetime import date
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

TABLE = "notebook_items"
KINDS = ("TASK", "TARGET", "WATCH", "NOTE", "PLUTUS")
MARKETS = ("IN", "US")
ITEM_FIELDS = ("kind", "title", "body", "market", "symbol", "due_date", "done", "pinned")

MAX_TITLE_LEN = 200
MAX_BODY_LEN = 20000

_SYMBOL_RE = re.compile(r"^[A-Z0-9&.\-]{1,20}$")
_NSE_SUFFIX_RE = re.compile(r"\.(NS|BO)$")


def _rows(res: Any) -> List[Dict[str, Any]]:
    return list(getattr(res, "data", None) or [])


def _bool(value: Any, field: str) -> bool:
    if isinstance(value, bool):
        return value
    raise ValueError(f"{field} must be true or false")


def clean_item(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Whitelist + normalise the keys PRESENT in ``payload``.

    '' becomes None (clears the field). Unknown keys are dropped. Bad values
    raise ValueError with a message fit for the owner.
    """
    out: Dict[str, Any] = {}
    for key in ITEM_FIELDS:
        if key not in (payload or {}):
            continue
        v = payload[key]
        if isinstance(v, str):
            v = v.strip()
            if v == "":
                v = None
        if key == "kind":
            v = str(v or "").upper()
            if v not in KINDS:
                raise ValueError(f"kind must be one of {', '.join(KINDS)}")
        elif key == "title":
            if v is None:
                raise ValueError("title is required")
            v = str(v)
            if len(v) > MAX_TITLE_LEN:
                raise ValueError(f"title is longer than {MAX_TITLE_LEN} characters")
        elif key == "body":
            if v is not None:
                v = str(v)
                if len(v) > MAX_BODY_LEN:
                    raise ValueError(f"body is longer than {MAX_BODY_LEN} characters")
        elif key == "market":
            if v is not None:
                v = str(v).upper()
                if v not in MARKETS:
                    raise ValueError(f"market must be one of {', '.join(MARKETS)} or empty")
        elif key == "symbol":
            if v is not None:
                v = str(v).upper()
                if not _SYMBOL_RE.match(v):
                    raise ValueError(f"symbol {v!r} is not a valid ticker")
        elif key == "due_date":
            if v is not None:
                try:
                    v = date.fromisoformat(str(v)[:10]).isoformat()
                except ValueError:
                    raise ValueError("due_date must be a date (YYYY-MM-DD)") from None
        elif key in ("done", "pinned"):
            v = _bool(v, key)
        out[key] = v
    return out


def finalise(row: Dict[str, Any]) -> Dict[str, Any]:
    """Rules that need the FULL (merged) row. Returns the cleaned row."""
    row = dict(row)
    if not row.get("title"):
        raise ValueError("title is required")
    row["kind"] = row.get("kind") or "NOTE"
    sym = row.get("symbol")
    if sym and row.get("market") == "IN":
        # Journal convention: plain NSE symbol, no exchange suffix.
        row["symbol"] = _NSE_SUFFIX_RE.sub("", sym)
    return row


def register_notebook_routes(app: Any, cli: Any) -> None:
    """Mount /api/journal/notebook/* on the given FastAPI app.

    Args:
        app: FastAPI instance.
        cli: zero-arg callable returning the (injectable) supabase client.
    """
    import functools

    from fastapi import Body, HTTPException

    from plutus.adapters import supabase_client as sb
    from plutus.api.serializers import serialize_rows, to_wire

    def client() -> Any:
        return cli() or sb.get_client()

    def guard(fn):
        @functools.wraps(fn)
        def inner(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except HTTPException:
                raise
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            except Exception as exc:  # noqa: BLE001
                logger.exception("notebook route failed: %s", fn.__name__)
                raise HTTPException(status_code=502, detail=str(exc))
        return inner

    def get_item(item_id: int) -> Dict[str, Any]:
        rows = _rows(client().table(TABLE).select("*").eq("id", item_id).limit(1).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"item {item_id} not found")
        return rows[0]

    @app.get("/api/journal/notebook")
    @guard
    def list_items() -> dict:
        rows = _rows(client().table(TABLE).select("*")
                     .order("id", desc=True).limit(5000).execute())
        return {"items": serialize_rows(rows), "count": len(rows)}

    @app.post("/api/journal/notebook")
    @guard
    def create_item(payload: dict = Body(...)) -> dict:
        row = finalise(clean_item(payload))
        rows = _rows(client().table(TABLE).insert(row).execute())
        return {"item": to_wire(rows[0] if rows else row)}

    @app.put("/api/journal/notebook/{item_id}")
    @guard
    def update_item(item_id: int, payload: dict = Body(...)) -> dict:
        patch = clean_item(payload)
        if not patch:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        current = get_item(item_id)
        merged = finalise({**current, **patch})
        # Write the patch plus anything finalise() normalised (symbol suffix).
        if merged.get("symbol") != current.get("symbol"):
            patch["symbol"] = merged.get("symbol")
        rows = _rows(client().table(TABLE).update(patch).eq("id", item_id).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"item {item_id} not found")
        return {"item": to_wire(rows[0])}

    @app.delete("/api/journal/notebook/{item_id}")
    @guard
    def delete_item(item_id: int) -> dict:
        get_item(item_id)
        client().table(TABLE).delete().eq("id", item_id).execute()
        return {"deleted": item_id}
