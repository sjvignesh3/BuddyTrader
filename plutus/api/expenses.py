"""
Expense Tracker routes — the personal Expense Intelligence module.

Design contract (mirrors plutus.api.journal):
  * Manual-first personal tracker: no bank/UPI integrations by design.
    Single-user, service-role client only; anon has zero access (RLS).
  * All writes go through a per-table field whitelist — unknown keys are
    silently dropped so a stale frontend can never poison rows.
  * Money values pass through to Postgres NUMERIC untouched; responses go
    through serializers.to_wire so Decimals never become floats.
  * Analytics (monthly summaries, insights, trends) are NOT computed or
    stored here — the frontend derives everything from the raw rows,
    exactly like the journal derives P&L client-side.
  * Item memory: every saved expense upserts expense_items so the next
    entry of the same name autofills category / intent / payment method /
    typical amount. This is the engine behind "Tea ₹15 in two keystrokes".
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

INTENTS = {"need", "want"}
FREQUENCIES = {"weekly", "monthly", "quarterly", "yearly"}

EXPENSE_FIELDS = {
    "expense_date", "name", "amount", "category_id", "intent",
    "payment_method", "merchant", "notes", "tags", "recurring_id",
}
CATEGORY_FIELDS = {
    "name", "parent_id", "icon", "default_intent", "exclude_from_spending",
    "sort_order", "archived",
}
ITEM_FIELDS = {
    "name", "category_id", "intent", "payment_method", "last_amount", "pinned",
}
RECURRING_FIELDS = {
    "name", "category_id", "amount", "frequency", "due_day", "intent",
    "payment_method", "start_date", "end_date", "active", "notes",
}
BUDGET_FIELDS = {"category_id", "monthly_amount"}


def _rows(res: Any) -> List[Dict[str, Any]]:
    return list(getattr(res, "data", None) or [])


def _clean(payload: Dict[str, Any], allowed: set) -> Dict[str, Any]:
    """Whitelist fields; normalise '' -> None."""
    out: Dict[str, Any] = {}
    for k, v in (payload or {}).items():
        if k not in allowed:
            continue
        if isinstance(v, str):
            v = v.strip()
            if v == "":
                v = None
        out[k] = v
    return out


def _validate_intent(row: Dict[str, Any]) -> None:
    for key in ("intent", "default_intent"):
        if row.get(key) is not None and row[key] not in INTENTS:
            row[key] = None


def register_expense_routes(app: Any, cli: Any) -> None:
    """Mount /api/expenses/* on the given FastAPI app.

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
                logger.exception("expense route failed: %s", fn.__name__)
                raise HTTPException(status_code=502, detail=str(exc))
        return inner

    # ---- Item memory helpers ------------------------------------------------

    def _find_item(name: str) -> Optional[Dict[str, Any]]:
        """Case-insensitive item lookup (ilike with wildcards escaped)."""
        pattern = name.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
        rows = _rows(client().table("expense_items").select("*")
                     .ilike("name", pattern).limit(1).execute())
        return rows[0] if rows else None

    def _remember_item(row: Dict[str, Any]) -> None:
        """Upsert the item memory from a saved expense. Best-effort — a
        failure here must never fail the expense write itself."""
        name = (row.get("name") or "").strip()
        if not name:
            return
        try:
            from datetime import datetime, timezone
            now = datetime.now(timezone.utc).isoformat()
            learned = {
                "category_id": row.get("category_id"),
                "intent": row.get("intent"),
                "payment_method": row.get("payment_method"),
                "last_amount": row.get("amount"),
                "last_used_at": now,
            }
            existing = _find_item(name)
            if existing:
                patch = {k: v for k, v in learned.items() if v is not None}
                patch["use_count"] = int(existing.get("use_count") or 0) + 1
                client().table("expense_items").update(patch) \
                    .eq("id", existing["id"]).execute()
            else:
                client().table("expense_items").insert(
                    {"name": name, **learned, "use_count": 1}).execute()
        except Exception:  # noqa: BLE001
            logger.exception("item memory upsert failed for %r", name)

    # ---- Expenses -----------------------------------------------------------

    @app.get("/api/expenses")
    @guard
    def list_expenses(
        date_from: Optional[str] = Query(None, alias="from",
                                         description="ISO date lower bound"),
        date_to: Optional[str] = Query(None, alias="to",
                                       description="ISO date upper bound"),
        limit: int = Query(20000, ge=1, le=50000),
    ) -> dict:
        q = client().table("expenses").select("*")
        if date_from:
            q = q.gte("expense_date", date_from)
        if date_to:
            q = q.lte("expense_date", date_to)
        rows = _rows(q.order("expense_date", desc=True).order("id", desc=True)
                     .limit(limit).execute())
        return {"expenses": serialize_rows(rows), "count": len(rows)}

    @app.post("/api/expenses")
    @guard
    def create_expense(payload: dict = Body(...)) -> dict:
        row = _clean(payload, EXPENSE_FIELDS)
        _validate_intent(row)
        if not row.get("name"):
            raise HTTPException(status_code=400, detail="name is required")
        if row.get("amount") in (None, ""):
            raise HTTPException(status_code=400, detail="amount is required")
        if not row.get("expense_date"):
            from datetime import date
            row["expense_date"] = date.today().isoformat()
        rows = _rows(client().table("expenses").insert(row).execute())
        saved = rows[0] if rows else row
        _remember_item(saved)
        return {"expense": to_wire(saved)}

    @app.put("/api/expenses/{expense_id}")
    @guard
    def update_expense(expense_id: int, payload: dict = Body(...)) -> dict:
        row = _clean(payload, EXPENSE_FIELDS)
        _validate_intent(row)
        if not row:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        rows = _rows(client().table("expenses")
                     .update(row).eq("id", expense_id).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"expense {expense_id} not found")
        return {"expense": to_wire(rows[0])}

    @app.delete("/api/expenses/{expense_id}")
    @guard
    def delete_expense(expense_id: int) -> dict:
        client().table("expenses").delete().eq("id", expense_id).execute()
        return {"deleted": expense_id}

    # ---- Bulk import (CSV parsed client-side) --------------------------------

    @app.post("/api/expenses/import")
    @guard
    def bulk_import(payload: dict = Body(...)) -> dict:
        """Insert many expenses at once. Body: {"expenses": [...]}.
        Rows may carry "category" (a name) instead of category_id — names
        are resolved against expense_categories case-insensitively, and
        unknown names become new top-level categories, so a Google-Sheet
        import never silently drops the classification."""
        raw = payload.get("expenses") or []
        cats = _rows(client().table("expense_categories")
                     .select("id,name").limit(2000).execute())
        by_name = {str(c["name"]).strip().lower(): c["id"] for c in cats}

        rows: List[Dict[str, Any]] = []
        for r in raw:
            cat_name = str((r or {}).get("category") or "").strip()
            row = _clean(r, EXPENSE_FIELDS)
            _validate_intent(row)
            if not row.get("name") or row.get("amount") in (None, "") \
                    or not row.get("expense_date"):
                continue
            if not row.get("category_id") and cat_name:
                key = cat_name.lower()
                if key not in by_name:
                    made = _rows(client().table("expense_categories")
                                 .insert({"name": cat_name}).execute())
                    if made:
                        by_name[key] = made[0]["id"]
                row["category_id"] = by_name.get(key)
            rows.append(row)

        n = 0
        if rows:
            n = len(_rows(client().table("expenses").insert(rows).execute()))
        return {"imported": n, "skipped": len(raw) - len(rows)}

    # ---- Item memory (autocomplete) ------------------------------------------

    @app.get("/api/expenses/items")
    @guard
    def list_items(limit: int = Query(500, ge=1, le=2000)) -> dict:
        rows = _rows(client().table("expense_items").select("*")
                     .order("use_count", desc=True).order("name")
                     .limit(limit).execute())
        return {"items": serialize_rows(rows), "count": len(rows)}

    @app.put("/api/expenses/items/{item_id}")
    @guard
    def update_item(item_id: int, payload: dict = Body(...)) -> dict:
        row = _clean(payload, ITEM_FIELDS)
        _validate_intent(row)
        if not row:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        rows = _rows(client().table("expense_items")
                     .update(row).eq("id", item_id).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"item {item_id} not found")
        return {"item": to_wire(rows[0])}

    @app.delete("/api/expenses/items/{item_id}")
    @guard
    def delete_item(item_id: int) -> dict:
        client().table("expense_items").delete().eq("id", item_id).execute()
        return {"deleted": item_id}

    # ---- Categories -----------------------------------------------------------

    @app.get("/api/expenses/categories")
    @guard
    def list_categories() -> dict:
        rows = _rows(client().table("expense_categories").select("*")
                     .order("sort_order").order("name").limit(2000).execute())
        return {"categories": serialize_rows(rows), "count": len(rows)}

    @app.post("/api/expenses/categories")
    @guard
    def create_category(payload: dict = Body(...)) -> dict:
        row = _clean(payload, CATEGORY_FIELDS)
        _validate_intent(row)
        if not row.get("name"):
            raise HTTPException(status_code=400, detail="name is required")
        rows = _rows(client().table("expense_categories").insert(row).execute())
        return {"category": to_wire(rows[0] if rows else row)}

    @app.put("/api/expenses/categories/{cat_id}")
    @guard
    def update_category(cat_id: int, payload: dict = Body(...)) -> dict:
        row = _clean(payload, CATEGORY_FIELDS)
        _validate_intent(row)
        if not row:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        rows = _rows(client().table("expense_categories")
                     .update(row).eq("id", cat_id).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"category {cat_id} not found")
        return {"category": to_wire(rows[0])}

    @app.delete("/api/expenses/categories/{cat_id}")
    @guard
    def delete_category(cat_id: int) -> dict:
        client().table("expense_categories").delete().eq("id", cat_id).execute()
        return {"deleted": cat_id}

    # ---- Recurring templates ----------------------------------------------------

    @app.get("/api/expenses/recurring")
    @guard
    def list_recurring() -> dict:
        rows = _rows(client().table("expense_recurring").select("*")
                     .order("active", desc=True).order("amount", desc=True)
                     .limit(1000).execute())
        return {"recurring": serialize_rows(rows), "count": len(rows)}

    @app.post("/api/expenses/recurring")
    @guard
    def create_recurring(payload: dict = Body(...)) -> dict:
        row = _clean(payload, RECURRING_FIELDS)
        _validate_intent(row)
        if not row.get("name"):
            raise HTTPException(status_code=400, detail="name is required")
        if row.get("amount") in (None, ""):
            raise HTTPException(status_code=400, detail="amount is required")
        if row.get("frequency") and row["frequency"] not in FREQUENCIES:
            raise HTTPException(status_code=400,
                                detail=f"frequency must be one of {sorted(FREQUENCIES)}")
        rows = _rows(client().table("expense_recurring").insert(row).execute())
        return {"recurring": to_wire(rows[0] if rows else row)}

    @app.put("/api/expenses/recurring/{rec_id}")
    @guard
    def update_recurring(rec_id: int, payload: dict = Body(...)) -> dict:
        row = _clean(payload, RECURRING_FIELDS)
        _validate_intent(row)
        if not row:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        if row.get("frequency") and row["frequency"] not in FREQUENCIES:
            raise HTTPException(status_code=400,
                                detail=f"frequency must be one of {sorted(FREQUENCIES)}")
        rows = _rows(client().table("expense_recurring")
                     .update(row).eq("id", rec_id).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"recurring {rec_id} not found")
        return {"recurring": to_wire(rows[0])}

    @app.delete("/api/expenses/recurring/{rec_id}")
    @guard
    def delete_recurring(rec_id: int) -> dict:
        client().table("expense_recurring").delete().eq("id", rec_id).execute()
        return {"deleted": rec_id}

    @app.post("/api/expenses/recurring/{rec_id}/log")
    @guard
    def log_recurring(rec_id: int, payload: dict = Body(default={})) -> dict:
        """One-click: create an expense from a recurring template
        (amount/date overridable — bills vary month to month)."""
        recs = _rows(client().table("expense_recurring").select("*")
                     .eq("id", rec_id).limit(1).execute())
        if not recs:
            raise HTTPException(status_code=404, detail=f"recurring {rec_id} not found")
        rec = recs[0]
        row = {
            "name": rec.get("name"),
            "amount": rec.get("amount"),
            "category_id": rec.get("category_id"),
            "intent": rec.get("intent"),
            "payment_method": rec.get("payment_method"),
            "recurring_id": rec_id,
        }
        row.update(_clean(payload, EXPENSE_FIELDS))
        _validate_intent(row)
        row["recurring_id"] = rec_id
        if not row.get("expense_date"):
            from datetime import date
            row["expense_date"] = date.today().isoformat()
        rows = _rows(client().table("expenses").insert(row).execute())
        return {"expense": to_wire(rows[0] if rows else row)}

    # ---- Budgets -----------------------------------------------------------------

    @app.get("/api/expenses/budgets")
    @guard
    def list_budgets() -> dict:
        rows = _rows(client().table("expense_budgets").select("*")
                     .limit(1000).execute())
        return {"budgets": serialize_rows(rows), "count": len(rows)}

    @app.post("/api/expenses/budgets")
    @guard
    def set_budget(payload: dict = Body(...)) -> dict:
        """Create or replace the budget for a category (or the overall
        budget when category_id is null)."""
        row = _clean(payload, BUDGET_FIELDS)
        if row.get("monthly_amount") in (None, ""):
            raise HTTPException(status_code=400, detail="monthly_amount is required")
        cat_id = row.get("category_id")
        q = client().table("expense_budgets").select("id")
        q = q.is_("category_id", "null") if cat_id is None else q.eq("category_id", cat_id)
        existing = _rows(q.limit(1).execute())
        if existing:
            rows = _rows(client().table("expense_budgets")
                         .update({"monthly_amount": row["monthly_amount"]})
                         .eq("id", existing[0]["id"]).execute())
        else:
            rows = _rows(client().table("expense_budgets").insert(row).execute())
        return {"budget": to_wire(rows[0] if rows else row)}

    @app.delete("/api/expenses/budgets/{budget_id}")
    @guard
    def delete_budget(budget_id: int) -> dict:
        client().table("expense_budgets").delete().eq("id", budget_id).execute()
        return {"deleted": budget_id}
