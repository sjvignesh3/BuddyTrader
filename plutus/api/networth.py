"""
Net Worth routes — manual assets, liabilities, monthly snapshots, income,
milestones and the financial-freedom settings row.

Design contract (mirrors plutus.api.journal / plutus.api.expenses):
  * Personal single-user tool: service-role client only; anon has zero
    access to networth_* tables (RLS).
  * The equity side is NOT stored here — it is journal_trades × the latest
    daily_snapshots, computed by the frontend with the Journal's existing
    portfolio logic. Live net worth, allocation %, XIRR, runway, savings
    rate and insights are all derived client-side; the only persisted
    derivation is the monthly snapshot, which is a deliberate historical
    record of "what the position was at that moment".
  * Snapshots and income are keyed by MONTH (date normalised to the 1st):
    writing the same month again replaces the row, so "Take Snapshot" is
    idempotent within a month.
  * All writes go through a field whitelist — unknown keys are dropped.
  * Money values pass through to Postgres NUMERIC untouched; responses go
    through serializers.to_wire so Decimals never become floats.
"""
from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

ASSET_CLASSES = {
    "Cash", "FD", "Mutual Fund", "Gold", "EPF/PPF", "Real Estate", "Crypto",
    "Bonds", "Other",
}
LIABILITY_KINDS = {"Home Loan", "Personal Loan", "Car Loan", "Credit Card", "Other"}

ASSET_FIELDS = {
    "name", "asset_class", "institution", "current_value", "cost_basis",
    "as_of_date", "notes", "archived",
}
LIABILITY_FIELDS = {
    "name", "kind", "outstanding", "interest_rate", "emi", "notes", "archived",
}
SNAPSHOT_FIELDS = {
    "snapshot_date", "equity_value", "assets_value", "liabilities_value",
    "net_worth", "breakdown",
}
INCOME_FIELDS = {"month", "amount", "notes"}
MILESTONE_FIELDS = {"label", "target", "achieved_on"}
SETTINGS_FIELDS = {"ff_target_corpus", "ff_real_return_pct", "ff_monthly_savings"}


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


def _dec(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _non_negative(row: Dict[str, Any], key: str, *, required: bool) -> Optional[str]:
    """Validate a money field: required → must be present and >= 0;
    optional → when present must be >= 0."""
    if key not in row or row[key] is None:
        return f"{key} is required" if required else None
    d = _dec(row[key])
    if d is None:
        return f"{key} must be a number"
    if d < 0:
        return f"{key} must be >= 0"
    return None


def month_start(value: Any) -> Optional[str]:
    """Normalise an ISO date / 'YYYY-MM' / None to the 1st of that month.
    None → current month. Returns None when unparseable."""
    if value is None or value == "":
        today = date.today()
        return date(today.year, today.month, 1).isoformat()
    s = str(value).strip()
    try:
        if len(s) == 7:                      # "YYYY-MM"
            y, m = s.split("-")
            return date(int(y), int(m), 1).isoformat()
        d = date.fromisoformat(s[:10])
        return date(d.year, d.month, 1).isoformat()
    except ValueError:
        return None


def validate_asset(row: Dict[str, Any], *, partial: bool) -> Optional[str]:
    if not partial and not row.get("name"):
        return "name is required"
    if "asset_class" in row or not partial:
        cls = row.get("asset_class")
        if cls not in ASSET_CLASSES:
            return f"asset_class must be one of {sorted(ASSET_CLASSES)}"
    err = _non_negative(row, "current_value", required=not partial)
    if err:
        return err
    return _non_negative(row, "cost_basis", required=False)


def validate_liability(row: Dict[str, Any], *, partial: bool) -> Optional[str]:
    if not partial and not row.get("name"):
        return "name is required"
    if "kind" in row or not partial:
        if row.get("kind") not in LIABILITY_KINDS:
            return f"kind must be one of {sorted(LIABILITY_KINDS)}"
    for key, req in (("outstanding", not partial), ("interest_rate", False), ("emi", False)):
        err = _non_negative(row, key, required=req)
        if err:
            return err
    return None


def validate_snapshot(row: Dict[str, Any]) -> Optional[str]:
    for key in ("equity_value", "assets_value", "liabilities_value"):
        err = _non_negative(row, key, required=True)
        if err:
            return err
    nw = _dec(row.get("net_worth"))
    if nw is None:
        return "net_worth is required"
    # The stored net worth must equal what its parts say — a snapshot is a
    # record, and a record that contradicts itself is worse than none.
    parts = (_dec(row["equity_value"]) + _dec(row["assets_value"])
             - _dec(row["liabilities_value"]))
    if abs(parts - nw) > Decimal("0.01"):
        return "net_worth must equal equity_value + assets_value - liabilities_value"
    if row.get("breakdown") is not None and not isinstance(row["breakdown"], dict):
        return "breakdown must be an object"
    return None


def register_networth_routes(app: Any, cli: Any) -> None:
    """Mount /api/networth/* on the given FastAPI app."""
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
                logger.exception("networth route failed: %s", fn.__name__)
                raise HTTPException(status_code=502, detail=str(exc))
        return inner

    def _crud(table: str, fields: set, validate, *, singular: str, plural: str,
              order: str = "id") -> None:
        """Register list / create / update / delete for a simple table."""

        @app.get(f"/api/networth/{plural}", name=f"list_{plural}")
        @guard
        def list_rows(include_archived: bool = Query(False)) -> dict:
            q = client().table(table).select("*")
            if not include_archived:
                q = q.eq("archived", False)
            rows = _rows(q.order(order).limit(2000).execute())
            return {plural: serialize_rows(rows), "count": len(rows)}

        @app.post(f"/api/networth/{plural}", name=f"create_{singular}")
        @guard
        def create_row(payload: dict = Body(...)) -> dict:
            row = _clean(payload, fields)
            problem = validate(row, partial=False)
            if problem:
                raise HTTPException(status_code=400, detail=problem)
            rows = _rows(client().table(table).insert(row).execute())
            return {singular: to_wire(rows[0] if rows else row)}

        @app.put(f"/api/networth/{plural}/{{row_id}}", name=f"update_{singular}")
        @guard
        def update_row(row_id: int, payload: dict = Body(...)) -> dict:
            row = _clean(payload, fields)
            if not row:
                raise HTTPException(status_code=400, detail="no editable fields in payload")
            problem = validate(row, partial=True)
            if problem:
                raise HTTPException(status_code=400, detail=problem)
            rows = _rows(client().table(table).update(row).eq("id", row_id).execute())
            if not rows:
                raise HTTPException(status_code=404, detail=f"{singular} {row_id} not found")
            return {singular: to_wire(rows[0])}

        @app.delete(f"/api/networth/{plural}/{{row_id}}", name=f"delete_{singular}")
        @guard
        def delete_row(row_id: int) -> dict:
            client().table(table).delete().eq("id", row_id).execute()
            return {"deleted": row_id}

    _crud("networth_assets", ASSET_FIELDS, validate_asset,
          singular="asset", plural="assets", order="asset_class")
    _crud("networth_liabilities", LIABILITY_FIELDS, validate_liability,
          singular="liability", plural="liabilities", order="kind")

    # ---- Monthly snapshots -------------------------------------------------

    @app.get("/api/networth/snapshots")
    @guard
    def list_snapshots(limit: int = Query(120, ge=1, le=600)) -> dict:
        rows = _rows(client().table("networth_snapshots").select("*")
                     .order("snapshot_date", desc=True).limit(limit).execute())
        return {"snapshots": serialize_rows(rows), "count": len(rows)}

    @app.post("/api/networth/snapshots")
    @guard
    def take_snapshot(payload: dict = Body(...)) -> dict:
        """Record (or replace) this month's snapshot. The frontend computes
        the values with the Journal's portfolio logic and sends them here;
        the API only checks they are self-consistent."""
        row = _clean(payload, SNAPSHOT_FIELDS)
        problem = validate_snapshot(row)
        if problem:
            raise HTTPException(status_code=400, detail=problem)
        month = month_start(row.get("snapshot_date"))
        if month is None:
            raise HTTPException(status_code=400, detail="snapshot_date must be an ISO date")
        row["snapshot_date"] = month
        row.setdefault("breakdown", {})
        existing = _rows(client().table("networth_snapshots").select("id")
                         .eq("snapshot_date", month).limit(1).execute())
        if existing:
            rows = _rows(client().table("networth_snapshots").update(row)
                         .eq("id", existing[0]["id"]).execute())
            replaced = True
        else:
            rows = _rows(client().table("networth_snapshots").insert(row).execute())
            replaced = False
        return {"snapshot": to_wire(rows[0] if rows else row), "replaced": replaced}

    @app.delete("/api/networth/snapshots/{snap_id}")
    @guard
    def delete_snapshot(snap_id: int) -> dict:
        client().table("networth_snapshots").delete().eq("id", snap_id).execute()
        return {"deleted": snap_id}

    # ---- Monthly income ----------------------------------------------------

    @app.get("/api/networth/income")
    @guard
    def list_income(limit: int = Query(120, ge=1, le=600)) -> dict:
        rows = _rows(client().table("networth_income").select("*")
                     .order("month", desc=True).limit(limit).execute())
        return {"income": serialize_rows(rows), "count": len(rows)}

    @app.post("/api/networth/income")
    @guard
    def set_income(payload: dict = Body(...)) -> dict:
        """Create or replace the income for a month (body: month, amount)."""
        row = _clean(payload, INCOME_FIELDS)
        err = _non_negative(row, "amount", required=True)
        if err:
            raise HTTPException(status_code=400, detail=err)
        month = month_start(row.get("month"))
        if month is None:
            raise HTTPException(status_code=400, detail="month must be YYYY-MM or an ISO date")
        row["month"] = month
        existing = _rows(client().table("networth_income").select("id")
                         .eq("month", month).limit(1).execute())
        if existing:
            rows = _rows(client().table("networth_income").update(row)
                         .eq("id", existing[0]["id"]).execute())
        else:
            rows = _rows(client().table("networth_income").insert(row).execute())
        return {"income": to_wire(rows[0] if rows else row)}

    @app.delete("/api/networth/income/{income_id}")
    @guard
    def delete_income(income_id: int) -> dict:
        client().table("networth_income").delete().eq("id", income_id).execute()
        return {"deleted": income_id}

    # ---- Milestones --------------------------------------------------------

    @app.get("/api/networth/milestones")
    @guard
    def list_milestones() -> dict:
        rows = _rows(client().table("networth_milestones").select("*")
                     .order("target").limit(500).execute())
        return {"milestones": serialize_rows(rows), "count": len(rows)}

    @app.post("/api/networth/milestones")
    @guard
    def create_milestone(payload: dict = Body(...)) -> dict:
        row = _clean(payload, MILESTONE_FIELDS)
        target = _dec(row.get("target"))
        if target is None or target <= 0:
            raise HTTPException(status_code=400, detail="target must be > 0")
        if not row.get("label"):
            row["label"] = f"₹{target:,.0f}"
        rows = _rows(client().table("networth_milestones").insert(row).execute())
        return {"milestone": to_wire(rows[0] if rows else row)}

    @app.put("/api/networth/milestones/{mile_id}")
    @guard
    def update_milestone(mile_id: int, payload: dict = Body(...)) -> dict:
        row = _clean(payload, MILESTONE_FIELDS)
        if not row:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        if "target" in row:
            target = _dec(row.get("target"))
            if target is None or target <= 0:
                raise HTTPException(status_code=400, detail="target must be > 0")
        rows = _rows(client().table("networth_milestones").update(row)
                     .eq("id", mile_id).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"milestone {mile_id} not found")
        return {"milestone": to_wire(rows[0])}

    @app.delete("/api/networth/milestones/{mile_id}")
    @guard
    def delete_milestone(mile_id: int) -> dict:
        client().table("networth_milestones").delete().eq("id", mile_id).execute()
        return {"deleted": mile_id}

    # ---- Settings (financial-freedom inputs) --------------------------------

    @app.get("/api/networth/settings")
    @guard
    def get_nw_settings() -> dict:
        rows = _rows(client().table("networth_settings").select("*")
                     .eq("id", 1).execute())
        if not rows:  # DB that missed the seed insert
            client().table("networth_settings").insert(
                {"id": 1, "ff_real_return_pct": 6}).execute()
            rows = [{"id": 1, "ff_target_corpus": None, "ff_real_return_pct": 6,
                     "ff_monthly_savings": None}]
        return {"settings": to_wire(rows[0])}

    @app.put("/api/networth/settings")
    @guard
    def put_nw_settings(payload: dict = Body(...)) -> dict:
        row = _clean(payload, SETTINGS_FIELDS)
        if not row:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        for key in ("ff_target_corpus", "ff_real_return_pct", "ff_monthly_savings"):
            err = _non_negative(row, key, required=False)
            if err:
                raise HTTPException(status_code=400, detail=err)
        rows = _rows(client().table("networth_settings").update(row)
                     .eq("id", 1).execute())
        return {"settings": to_wire(rows[0] if rows else {"id": 1, **row})}
