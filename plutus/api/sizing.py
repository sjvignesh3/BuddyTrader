"""
Position Sizer routes — saved pre-trade plans.

Design contract (mirrors plutus.api.journal / plutus.api.expenses):
  * Personal single-user tool: service-role client only; anon has zero
    access to sizing_plans (RLS).
  * A plan stores INPUTS only (capital snapshot, risk %, entry, stop, qty,
    targets, ladder). Every derived number — ₹ risk, R multiples,
    allocation %, room left, portfolio heat — is recomputed by the
    frontend from these inputs plus the live journal. Nothing derived is
    persisted, so a capital change never leaves stale numbers behind.
  * All writes go through a field whitelist — unknown keys are dropped.
  * Money values pass through to Postgres NUMERIC untouched; responses go
    through serializers.to_wire so Decimals never become floats.
  * "Convert to Opportunity" is NOT a route here: the frontend reuses the
    Journal's opportunity form + POST /api/journal/opportunities, then
    stamps `opportunity_id` on the plan via PUT so the link is visible.
"""
from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

CAP_BUCKETS = {"Large", "Mid", "Small", "Micro"}

PLAN_FIELDS = {
    "symbol", "cap_bucket", "capital", "risk_pct", "entry", "stop", "qty",
    "targets", "ladder", "notes", "opportunity_id",
}
# Fields a PUT may change after the fact (the sized inputs stay immutable —
# a changed plan is a new plan, so history stays honest).
PLAN_PATCH_FIELDS = {"notes", "opportunity_id", "targets", "ladder"}


def _rows(res: Any) -> List[Dict[str, Any]]:
    return list(getattr(res, "data", None) or [])


def _clean(payload: Dict[str, Any], allowed: set) -> Dict[str, Any]:
    """Whitelist fields; normalise '' -> None; uppercase symbol."""
    out: Dict[str, Any] = {}
    for k, v in (payload or {}).items():
        if k not in allowed:
            continue
        if isinstance(v, str):
            v = v.strip()
            if v == "":
                v = None
        out[k] = v
    if out.get("symbol"):
        out["symbol"] = str(out["symbol"]).upper()
    return out


def _dec(value: Any) -> Optional[Decimal]:
    """Parse a JSON number/string into Decimal (None when unparseable)."""
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _price_list(raw: Any, key: str) -> List[Dict[str, Any]]:
    """Normalise a JSONB list of {key: price, ...} entries: keep only
    dicts whose price parses as a positive number; prices kept as the
    original strings so no float ever reaches NUMERIC-in-JSONB."""
    out: List[Dict[str, Any]] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        d = _dec(item.get(key))
        if d is None or d <= 0:
            continue
        row = {key: str(d)}
        if "qty" in item:
            try:
                q = int(item["qty"])
            except (TypeError, ValueError):
                continue
            if q <= 0:
                continue
            row["qty"] = q
        out.append(row)
    return out


def validate_plan(row: Dict[str, Any]) -> Optional[str]:
    """Return an error message for an invalid plan, else None.

    Kept as a pure function so tests can exercise it without FastAPI."""
    if not row.get("symbol"):
        return "symbol is required"
    cap = row.get("cap_bucket")
    if cap is not None and cap not in CAP_BUCKETS:
        return f"cap_bucket must be one of {sorted(CAP_BUCKETS)}"
    capital = _dec(row.get("capital"))
    if capital is None or capital <= 0:
        return "capital must be > 0"
    risk = _dec(row.get("risk_pct"))
    if risk is None or risk <= 0:
        return "risk_pct must be > 0"
    entry = _dec(row.get("entry"))
    if entry is None or entry <= 0:
        return "entry must be > 0"
    stop = _dec(row.get("stop"))
    if stop is None or stop <= 0:
        return "stop must be > 0"
    if stop >= entry:
        return "stop must be below entry"
    try:
        qty = int(row.get("qty"))
    except (TypeError, ValueError):
        return "qty must be a positive whole number"
    if qty <= 0:
        return "qty must be a positive whole number"
    return None


def register_sizing_routes(app: Any, cli: Any) -> None:
    """Mount /api/sizing/* on the given FastAPI app.

    Args:
        app: FastAPI instance.
        cli: zero-arg callable returning the (injectable) supabase client;
             falls back to the module-level singleton when it returns None.
    """
    from fastapi import Body, HTTPException, Query

    from plutus.adapters import supabase_client as sb
    from plutus.api.serializers import serialize_rows, to_wire

    def client() -> Any:
        return cli() or sb.get_client()

    def guard(fn):  # small error envelope wrapper
        import functools

        @functools.wraps(fn)
        def inner(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except HTTPException:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.exception("sizing route failed: %s", fn.__name__)
                raise HTTPException(status_code=502, detail=str(exc))
        return inner

    @app.get("/api/sizing/plans")
    @guard
    def list_plans(
        symbol: Optional[str] = Query(None, description="Plain NSE symbol, e.g. TCS"),
        limit: int = Query(200, ge=1, le=1000),
    ) -> dict:
        q = client().table("sizing_plans").select("*")
        if symbol:
            q = q.eq("symbol", symbol.strip().upper())
        rows = _rows(q.order("created_at", desc=True).order("id", desc=True)
                     .limit(limit).execute())
        return {"plans": serialize_rows(rows), "count": len(rows)}

    @app.post("/api/sizing/plans")
    @guard
    def create_plan(payload: dict = Body(...)) -> dict:
        row = _clean(payload, PLAN_FIELDS)
        row["targets"] = _price_list(row.get("targets"), "price")
        row["ladder"] = _price_list(row.get("ladder"), "trigger")
        problem = validate_plan(row)
        if problem:
            raise HTTPException(status_code=400, detail=problem)
        rows = _rows(client().table("sizing_plans").insert(row).execute())
        return {"plan": to_wire(rows[0] if rows else row)}

    @app.put("/api/sizing/plans/{plan_id}")
    @guard
    def update_plan(plan_id: int, payload: dict = Body(...)) -> dict:
        row = _clean(payload, PLAN_PATCH_FIELDS)
        if "targets" in row:
            row["targets"] = _price_list(row.get("targets"), "price")
        if "ladder" in row:
            row["ladder"] = _price_list(row.get("ladder"), "trigger")
        if not row:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        rows = _rows(client().table("sizing_plans")
                     .update(row).eq("id", plan_id).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"plan {plan_id} not found")
        return {"plan": to_wire(rows[0])}

    @app.delete("/api/sizing/plans/{plan_id}")
    @guard
    def delete_plan(plan_id: int) -> dict:
        client().table("sizing_plans").delete().eq("id", plan_id).execute()
        return {"deleted": plan_id}
