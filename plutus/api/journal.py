"""
Trading Journal routes — the ONE writable area of the Plutus API.

Design contract:
  * Personal single-user journal. Anon key has zero access to journal
    tables, and every route here sits behind the shared-credential gate in
    plutus.api.auth (X-Plutus-Auth), so a public API URL is not an open door.
  * All writes go through a per-table field whitelist — unknown keys are
    silently dropped so a stale frontend can never poison rows.
  * Derived values (LTP, allocation %, gains) are NOT stored; the frontend
    computes them from daily_snapshots + capital.
  * Money values arrive as JSON numbers/strings and are passed through to
    Postgres NUMERIC untouched; responses go through serializers.to_wire.
  * Two markets (migration 027). Journal symbols are PLAIN ('TCS', 'NVDA'),
    so every row carries `market` ('IN' | 'US'). India is the default
    everywhere: a request that names no market reads and writes Indian rows
    exactly as before, and an Indian write never sends the column — so this
    code runs unchanged against a database that has not been migrated yet.
    Rows of the two markets are never mixed in one response.
  * Quantity is a whole number for India and may be fractional (up to four
    decimals) for the US. It always leaves as a JSON NUMBER, never a string
    — the frontend adds quantities, and "10" + "5" is not 15.
"""
from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional

from plutus.markets import IN, US, normalize_market

logger = logging.getLogger(__name__)

CAP_BUCKETS = {"Large", "Mid", "Small", "Micro"}
ACTION_FILTERS = {"Buy Now", "GTT", "Analyse Now", "Later"}
ORDER_TYPES = {"GTT", "Instant"}

OPP_FIELDS = {
    "opp_date", "symbol", "cap_bucket", "buy_price", "limit_price", "qty",
    "strategy", "target_price", "stop_price", "action_filter", "notes", "status",
}
TRADE_FIELDS = {
    "opportunity_id", "order_type", "cap_bucket", "symbol", "buy_date",
    "buy_price", "qty", "strategy", "target_price", "stop_price", "status",
    "close_label", "sell_date", "sell_price", "comments", "risk_notes",
}
NOTE_FIELDS = {"symbol", "note_date", "content"}


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


# ---------------------------------------------------------------------------
# Markets + quantities (pure helpers — unit-tested without a client)
# ---------------------------------------------------------------------------
_QTY_STEP = Decimal("0.0001")
DEFAULT_CAPITAL = 300000


def row_market(row: Dict[str, Any]) -> str:
    """Market of a stored row; IN when the column is absent (un-migrated DB)."""
    return US if (row or {}).get("market") == US else IN


def of_market(rows: List[Dict[str, Any]], market: str) -> List[Dict[str, Any]]:
    """Rows of one market. Filtered here rather than in SQL so the Indian
    journal keeps working on a database without the `market` column."""
    return [r for r in rows if row_market(r) == market]


def stamp_market(row: Dict[str, Any], market: str) -> Dict[str, Any]:
    """Tag a row about to be INSERTED. Indian rows are left untouched (the
    column defaults to 'IN'), so an Indian insert never names the column."""
    if market == US:
        row["market"] = US
    else:
        row.pop("market", None)
    return row


def parse_qty(value: Any, market: str = IN) -> Decimal:
    """A positive quantity: whole for India, up to 4 decimals for the US.
    Raises ValueError with a message fit for the owner."""
    if value is None or isinstance(value, bool):
        raise ValueError("qty must be a number")
    try:
        d = Decimal(str(value).strip().replace(",", ""))
    except (InvalidOperation, ValueError):
        raise ValueError("qty must be a number") from None
    if not d.is_finite() or d <= 0:
        raise ValueError("qty must be above 0")
    if market == US:
        if d != d.quantize(_QTY_STEP):
            raise ValueError("qty can have at most 4 decimal places")
    elif d != d.to_integral_value():
        raise ValueError("qty must be a whole number for Indian stocks")
    return d


def qty_wire(value: Any) -> Any:
    """Quantity as a JSON number: int when whole, float otherwise."""
    if value is None or isinstance(value, bool):
        return None
    try:
        d = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return value
    if not d.is_finite():
        return None
    return int(d) if d == d.to_integral_value() else float(d)


def clean_qty(row: Dict[str, Any], market: str) -> Dict[str, Any]:
    """Validate + normalise `qty` when the row carries one."""
    if row.get("qty") is not None:
        row["qty"] = qty_wire(parse_qty(row["qty"], market))
    return row


def register_journal_routes(app: Any, cli: Any) -> None:
    """Mount /api/journal/* on the given FastAPI app.

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
            except ValueError as exc:   # bad market / qty — the owner's input
                raise HTTPException(status_code=400, detail=str(exc))
            except Exception as exc:  # noqa: BLE001
                logger.exception("journal route failed: %s", fn.__name__)
                raise HTTPException(status_code=502, detail=str(exc))
        return inner

    def wire_row(row: Any) -> Any:
        """to_wire, with qty kept a NUMBER (to_wire stringifies floats)."""
        out = to_wire(row)
        if isinstance(out, dict) and "qty" in out:
            out["qty"] = qty_wire(row.get("qty"))
        return out

    def wire_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [wire_row(r) for r in rows]

    def stored_market(table: str, row_id: int, what: str) -> str:
        """Market of an existing row (404 when it does not exist)."""
        rows = _rows(client().table(table).select("*").eq("id", row_id).limit(1).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"{what} {row_id} not found")
        return row_market(rows[0])

    # -- Settings (capital) --------------------------------------------------
    @app.get("/api/journal/settings")
    @guard
    def get_settings() -> dict:
        rows = _rows(client().table("journal_settings").select("*")
                     .eq("id", 1).execute())
        if not rows:  # first run on a DB that missed the seed insert
            client().table("journal_settings").insert(
                {"id": 1, "capital": DEFAULT_CAPITAL}).execute()
            rows = [{"id": 1, "capital": DEFAULT_CAPITAL}]
        # `capital` is the Indian capital (₹); `capital_usd` the US one ($),
        # null until the owner sets it.
        return {"settings": to_wire(rows[0])}

    @app.put("/api/journal/settings")
    @guard
    def put_settings(payload: dict = Body(...)) -> dict:
        capital = payload.get("capital")
        try:
            cap_num = float(capital)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="capital must be a number")
        if cap_num <= 0:
            raise HTTPException(status_code=400, detail="capital must be > 0")
        # {"capital": 5000, "market": "US"} sets the dollar capital; without
        # a market it is the Indian capital, as before.
        column = "capital_usd" if normalize_market(payload.get("market")) == US else "capital"
        res = (client().table("journal_settings")
               .update({column: capital}).eq("id", 1).execute())
        rows = _rows(res)
        return {"settings": to_wire(rows[0] if rows else {"id": 1, column: capital})}

    # -- Opportunities -------------------------------------------------------
    @app.get("/api/journal/opportunities")
    @guard
    def list_opportunities(
        status: Optional[str] = Query(None, description="ACTIVE / CONVERTED / DROPPED"),
        market: Optional[str] = Query(None, description="IN (default) or US"),
    ) -> dict:
        mkt = normalize_market(market)
        q = client().table("journal_opportunities").select("*")
        if status:
            q = q.in_("status", [s.strip() for s in status.split(",") if s.strip()])
        rows = of_market(_rows(q.order("id", desc=True).limit(2000).execute()), mkt)
        return {"opportunities": wire_rows(rows), "count": len(rows), "market": mkt}

    @app.post("/api/journal/opportunities")
    @guard
    def create_opportunity(payload: dict = Body(...)) -> dict:
        mkt = normalize_market(payload.get("market"))
        row = clean_qty(_clean(payload, OPP_FIELDS), mkt)
        if not row.get("symbol"):
            raise HTTPException(status_code=400, detail="symbol is required")
        stamp_market(row, mkt)
        rows = _rows(client().table("journal_opportunities").insert(row).execute())
        return {"opportunity": wire_row(rows[0] if rows else row)}

    @app.put("/api/journal/opportunities/{opp_id}")
    @guard
    def update_opportunity(opp_id: int, payload: dict = Body(...)) -> dict:
        row = _clean(payload, OPP_FIELDS)
        if not row:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        if row.get("qty") is not None:   # a row never changes market on edit
            clean_qty(row, stored_market("journal_opportunities", opp_id, "opportunity"))
        rows = _rows(client().table("journal_opportunities")
                     .update(row).eq("id", opp_id).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"opportunity {opp_id} not found")
        return {"opportunity": wire_row(rows[0])}

    @app.delete("/api/journal/opportunities/{opp_id}")
    @guard
    def delete_opportunity(opp_id: int) -> dict:
        client().table("journal_opportunities").delete().eq("id", opp_id).execute()
        return {"deleted": opp_id}

    @app.post("/api/journal/opportunities/{opp_id}/convert")
    @guard
    def convert_opportunity(opp_id: int, payload: dict = Body(default={})) -> dict:
        """Turn an opportunity into an OPEN trade (fields overridable)."""
        opps = _rows(client().table("journal_opportunities").select("*")
                     .eq("id", opp_id).limit(1).execute())
        if not opps:
            raise HTTPException(status_code=404, detail=f"opportunity {opp_id} not found")
        opp = opps[0]
        mkt = row_market(opp)            # the trade stays in the plan's market
        trade = {
            "opportunity_id": opp_id,
            "symbol": opp.get("symbol"),
            "cap_bucket": opp.get("cap_bucket"),
            "strategy": opp.get("strategy"),
            "target_price": opp.get("target_price"),
            "stop_price": opp.get("stop_price"),
            "buy_price": opp.get("limit_price") or opp.get("buy_price"),
            "qty": opp.get("qty"),
            "order_type": "GTT" if opp.get("action_filter") == "GTT" else "Instant",
        }
        trade.update(_clean(payload, TRADE_FIELDS))
        trade.setdefault("buy_date", None)
        if not trade.get("buy_date"):
            from datetime import date
            trade["buy_date"] = date.today().isoformat()
        if not trade.get("buy_price") or not trade.get("qty"):
            raise HTTPException(status_code=400,
                                detail="buy_price and qty are required to convert")
        stamp_market(clean_qty(trade, mkt), mkt)
        rows = _rows(client().table("journal_trades").insert(trade).execute())
        client().table("journal_opportunities").update(
            {"status": "CONVERTED"}).eq("id", opp_id).execute()
        return {"trade": wire_row(rows[0] if rows else trade)}

    # -- Trades ---------------------------------------------------------------
    @app.get("/api/journal/trades")
    @guard
    def list_trades(
        status: Optional[str] = Query(None, description="OPEN / CLOSED"),
        symbol: Optional[str] = Query(None, description="Filter to one stock "
                                      "(plain symbol, e.g. TCS or NVDA)"),
        market: Optional[str] = Query(None, description="IN (default) or US"),
    ) -> dict:
        mkt = normalize_market(market)
        q = client().table("journal_trades").select("*")
        if status:
            q = q.in_("status", [s.strip().upper() for s in status.split(",") if s.strip()])
        if symbol:
            q = q.eq("symbol", symbol.strip().upper())
        rows = of_market(_rows(q.order("buy_date", desc=True).order("id", desc=True)
                               .limit(5000).execute()), mkt)
        return {"trades": wire_rows(rows), "count": len(rows), "market": mkt}

    @app.post("/api/journal/trades")
    @guard
    def create_trade(payload: dict = Body(...)) -> dict:
        mkt = normalize_market(payload.get("market"))
        row = _clean(payload, TRADE_FIELDS)
        for req in ("symbol", "buy_date", "buy_price", "qty"):
            if not row.get(req):
                raise HTTPException(status_code=400, detail=f"{req} is required")
        stamp_market(clean_qty(row, mkt), mkt)
        rows = _rows(client().table("journal_trades").insert(row).execute())
        return {"trade": wire_row(rows[0] if rows else row)}

    @app.put("/api/journal/trades/{trade_id}")
    @guard
    def update_trade(trade_id: int, payload: dict = Body(...)) -> dict:
        row = _clean(payload, TRADE_FIELDS)
        if not row:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        if row.get("qty") is not None:   # a row never changes market on edit
            clean_qty(row, stored_market("journal_trades", trade_id, "trade"))
        rows = _rows(client().table("journal_trades")
                     .update(row).eq("id", trade_id).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"trade {trade_id} not found")
        return {"trade": wire_row(rows[0])}

    @app.delete("/api/journal/trades/{trade_id}")
    @guard
    def delete_trade(trade_id: int) -> dict:
        client().table("journal_trades").delete().eq("id", trade_id).execute()
        return {"deleted": trade_id}

    @app.post("/api/journal/trades/{trade_id}/close")
    @guard
    def close_trade(trade_id: int, payload: dict = Body(...)) -> dict:
        """Close an OPEN trade. Selling fewer than the open qty splits the
        row: sold qty becomes a CLOSED row, the remainder stays OPEN."""
        sell_date = payload.get("sell_date")
        sell_price = payload.get("sell_price")
        if not sell_date or sell_price in (None, ""):
            raise HTTPException(status_code=400,
                                detail="sell_date and sell_price are required")
        trades = _rows(client().table("journal_trades").select("*")
                       .eq("id", trade_id).limit(1).execute())
        if not trades:
            raise HTTPException(status_code=404, detail=f"trade {trade_id} not found")
        trade = trades[0]
        if trade.get("status") != "OPEN":
            raise HTTPException(status_code=400, detail="trade is not OPEN")

        mkt = row_market(trade)
        open_qty = Decimal(str(trade.get("qty") or 0))
        raw_sell = payload.get("qty")
        sell_qty = parse_qty(raw_sell, mkt) if raw_sell not in (None, "") else open_qty
        if sell_qty <= 0 or sell_qty > open_qty:
            raise HTTPException(
                status_code=400,
                detail=(f"qty must be between 1 and {qty_wire(open_qty)}" if mkt == IN
                        else f"qty must be above 0 and at most {qty_wire(open_qty)}"))

        label = payload.get("close_label") or (
            "Fully Booked" if sell_qty == open_qty else "Partially Booked")

        if sell_qty == open_qty:
            rows = _rows(client().table("journal_trades").update({
                "status": "CLOSED", "close_label": label,
                "sell_date": sell_date, "sell_price": sell_price,
            }).eq("id", trade_id).execute())
            return {"closed": wire_row(rows[0] if rows else trade), "remainder": None}

        # Partial: shrink the open row, insert a closed twin for the sold lot.
        closed_row = {k: trade.get(k) for k in TRADE_FIELDS if k in trade}
        closed_row.update({
            "qty": qty_wire(sell_qty), "status": "CLOSED", "close_label": label,
            "sell_date": sell_date, "sell_price": sell_price,
        })
        stamp_market(closed_row, mkt)    # the sold lot stays in its market
        inserted = _rows(client().table("journal_trades").insert(closed_row).execute())
        remaining = _rows(client().table("journal_trades").update(
            {"qty": qty_wire(open_qty - sell_qty)}).eq("id", trade_id).execute())
        return {
            "closed": wire_row(inserted[0] if inserted else closed_row),
            "remainder": wire_row(remaining[0]) if remaining else None,
        }

    # -- Stock notes (dated research views per symbol) -------------------------
    @app.get("/api/journal/notes")
    @guard
    def list_notes(
        symbol: Optional[str] = Query(None, description="Plain symbol, e.g. TCS or NVDA"),
        limit: int = Query(500, ge=1, le=2000),
        market: Optional[str] = Query(None, description="IN (default) or US"),
    ) -> dict:
        mkt = normalize_market(market)
        q = client().table("journal_stock_notes").select("*")
        if symbol:
            q = q.eq("symbol", symbol.strip().upper())
        rows = of_market(_rows(q.order("note_date", desc=True).order("id", desc=True)
                               .limit(limit).execute()), mkt)
        return {"notes": serialize_rows(rows), "count": len(rows), "market": mkt}

    @app.post("/api/journal/notes")
    @guard
    def create_note(payload: dict = Body(...)) -> dict:
        row = _clean(payload, NOTE_FIELDS)
        if not row.get("symbol"):
            raise HTTPException(status_code=400, detail="symbol is required")
        if not row.get("content"):
            raise HTTPException(status_code=400, detail="content is required")
        if not row.get("note_date"):
            from datetime import date
            row["note_date"] = date.today().isoformat()
        stamp_market(row, normalize_market(payload.get("market")))
        rows = _rows(client().table("journal_stock_notes").insert(row).execute())
        return {"note": to_wire(rows[0] if rows else row)}

    @app.put("/api/journal/notes/{note_id}")
    @guard
    def update_note(note_id: int, payload: dict = Body(...)) -> dict:
        row = _clean(payload, NOTE_FIELDS)
        if not row:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        rows = _rows(client().table("journal_stock_notes")
                     .update(row).eq("id", note_id).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"note {note_id} not found")
        return {"note": to_wire(rows[0])}

    @app.delete("/api/journal/notes/{note_id}")
    @guard
    def delete_note(note_id: int) -> dict:
        client().table("journal_stock_notes").delete().eq("id", note_id).execute()
        return {"deleted": note_id}

    # -- Open positions (Market Analysis integration) -------------------------
    @app.get("/api/journal/positions")
    @guard
    def positions(
        market: Optional[str] = Query(None, description="IN (default) or US"),
    ) -> dict:
        """Aggregated OPEN exposure per symbol — used by the Market Analysis
        tool to flag stocks we already hold. One market per call: `invested`
        is rupees for IN and dollars for US."""
        mkt = normalize_market(market)
        rows = of_market(_rows(client().table("journal_trades")
                               .select("*")
                               .eq("status", "OPEN").limit(5000).execute()), mkt)
        agg: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            sym = r["symbol"]
            qty = float(r.get("qty") or 0)
            invested = float(r.get("buy_price") or 0) * qty
            slot = agg.setdefault(sym, {
                "symbol": sym, "qty": 0.0, "invested": 0.0,
                "cap_bucket": r.get("cap_bucket"), "lots": 0,
            })
            slot["qty"] = round(slot["qty"] + qty, 4)
            slot["invested"] = round(slot["invested"] + invested, 2)
            slot["lots"] += 1
        out = sorted(agg.values(), key=lambda x: x["symbol"])
        for slot in out:
            slot["qty"] = qty_wire(slot["qty"])
        return {"positions": out, "count": len(out), "market": mkt}

    # -- Bulk import (CSV parsed client-side) ---------------------------------
    @app.post("/api/journal/import")
    @guard
    def bulk_import(payload: dict = Body(...)) -> dict:
        """Insert many rows at once. Body:
        {"opportunities": [...], "trades": [...]} — each row already in
        canonical field names (frontend does the CSV header mapping)."""
        mkt = normalize_market(payload.get("market"))   # one market per import
        opps = [_clean(r, OPP_FIELDS) for r in payload.get("opportunities") or []]
        trades = [_clean(r, TRADE_FIELDS) for r in payload.get("trades") or []]
        opps = [r for r in opps if r.get("symbol")]
        trades = [r for r in trades
                  if r.get("symbol") and r.get("buy_date")
                  and r.get("buy_price") and r.get("qty")]
        for r in opps + trades:
            stamp_market(clean_qty(r, mkt), mkt)
        n_opp = n_trade = 0
        if opps:
            n_opp = len(_rows(client().table("journal_opportunities")
                              .insert(opps).execute()))
        if trades:
            n_trade = len(_rows(client().table("journal_trades")
                                .insert(trades).execute()))
        return {"imported": {"opportunities": n_opp, "trades": n_trade}}
