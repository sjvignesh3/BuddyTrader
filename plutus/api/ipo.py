"""
IPO journal routes — applications, allotment, listing and sell legs.

Design contract (mirrors plutus.api.journal):
  * Personal tool behind the shared-credential gate (all paths sit under
    /api/journal/*). Anon has no access to the tables (migration 024).
  * The API is the ONLY guard the owner's data has before Postgres, and the
    test fake does not enforce CHECK constraints — so every rule in 024 is
    re-checked here first and surfaces as a readable 400, never a 502:
      - only an ALLOTTED application carries shares (auto-cleared otherwise),
        never more than lots_applied * lot_size, never fewer than already sold;
      - an application with sells cannot leave ALLOTTED;
      - a sell never exceeds the shares still held and never predates the
        listing (or, before listing data exists, the application);
      - dates never run backwards (allotment / listing on or after applying).
  * Stage, gains, %, days held and money-locked are DERIVED in the frontend
    (lib/ipo.ts) — nothing computed is stored.
  * Listing-day prices come from yfinance on demand (``/ipos/listing``) and
    are only saved when the owner saves the form, so a wrong guess never
    lands silently. A first candle that predates the application means the
    symbol belongs to an older listed company — refused with a hint.
  * Money is Decimal end to end; no float touches a stored value.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Callable, Dict, Iterable, List, Optional

from plutus.adapters.result import Result

logger = logging.getLogger(__name__)

STATUSES = ("APPLIED", "ALLOTTED", "NOT_ALLOTTED")

IPO_FIELDS = (
    "account", "ipo_name", "symbol", "apply_date", "issue_price", "lot_size",
    "lots_applied", "status", "allotment_date", "shares_allotted",
    "listing_date", "listing_open", "listing_close", "notes",
)
SELL_FIELDS = ("sell_date", "sell_price", "qty", "notes")

_MONEY = {"issue_price", "listing_open", "listing_close", "sell_price"}
_INTS = {"lot_size", "lots_applied", "shares_allotted", "qty"}
_DATES = {"apply_date", "allotment_date", "listing_date", "sell_date"}
_TEXT_LIMITS = {"account": 30, "ipo_name": 80}

_SYMBOL_RE = re.compile(r"^[A-Z0-9&\-]{1,20}$")
_SUFFIX_RE = re.compile(r"\.(NS|BO)$", re.IGNORECASE)
_PRICE_MAX = Decimal("10000000")
_CENT = Decimal("0.01")
_IST = timezone(timedelta(hours=5, minutes=30))

MAX_QUOTE_SYMBOLS = 25

Bar = Dict[str, Any]          # {"date": "YYYY-MM-DD", "open": Decimal, "close": Decimal}
FetchDaily = Callable[[str, str], Result[List[Bar]]]


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested without a client)
# ---------------------------------------------------------------------------

def _rows(res: Any) -> List[Dict[str, Any]]:
    return list(getattr(res, "data", None) or [])


def normalize_symbol(raw: Any) -> Optional[str]:
    """'tata tech.ns ' -> None, ' tatatech.NS' -> 'TATATECH'. None if invalid."""
    if not isinstance(raw, str):
        return None
    s = _SUFFIX_RE.sub("", raw.strip().upper())
    return s if _SYMBOL_RE.match(s) else None


def _money(value: Any, field: str) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a number")
    try:
        d = Decimal(str(value).strip().replace(",", ""))
    except (InvalidOperation, ValueError):
        raise ValueError(f"{field} must be a number") from None
    if not d.is_finite() or d <= 0 or d > _PRICE_MAX:
        raise ValueError(f"{field} must be a positive price")
    return d.quantize(_CENT, rounding=ROUND_HALF_UP)


def _int(value: Any, field: str) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a whole number")
    try:
        d = Decimal(str(value).strip().replace(",", ""))
    except (InvalidOperation, ValueError):
        raise ValueError(f"{field} must be a whole number") from None
    if not d.is_finite() or d != d.to_integral_value() or d <= 0:
        raise ValueError(f"{field} must be a whole number above 0")
    return int(d)


def _date(value: Any, field: str) -> Optional[str]:
    if value is None:
        return None
    try:
        return date.fromisoformat(str(value).strip()[:10]).isoformat()
    except ValueError:
        raise ValueError(f"{field} must be a date (YYYY-MM-DD)") from None


def clean_fields(payload: Dict[str, Any], allowed: Iterable[str]) -> Dict[str, Any]:
    """Whitelist + type-normalise the keys PRESENT in ``payload``.

    '' becomes None (clears the field). Unknown keys are dropped. Bad values
    raise ValueError with a message fit for the owner.
    """
    out: Dict[str, Any] = {}
    for key in allowed:
        if key not in (payload or {}):
            continue
        v = payload[key]
        if isinstance(v, str):
            v = v.strip()
            if v == "":
                v = None
        if key in _MONEY:
            v = _money(v, key)
        elif key in _INTS:
            v = _int(v, key)
        elif key in _DATES:
            v = _date(v, key)
        elif key == "symbol":
            if v is not None:
                sym = normalize_symbol(v)
                if sym is None:
                    raise ValueError(f"symbol {v!r} is not a valid NSE symbol")
                v = sym
        elif key == "status":
            if v is not None:
                v = str(v).upper()
                if v not in STATUSES:
                    raise ValueError(f"status must be one of {', '.join(STATUSES)}")
        elif key in _TEXT_LIMITS and v is not None:
            v = str(v)
            if len(v) > _TEXT_LIMITS[key]:
                raise ValueError(f"{key} is longer than {_TEXT_LIMITS[key]} characters")
        out[key] = v
    return out


def _d(v: Any) -> Optional[Decimal]:
    return None if v is None else Decimal(str(v))


def validate_ipo(row: Dict[str, Any], sells: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Check a FULL (merged) application row against its sells.

    Returns the row with derived clean-ups applied (a non-ALLOTTED row loses
    its shares). Raises ValueError on any rule break.
    """
    row = dict(row)
    for req in ("account", "ipo_name", "apply_date", "issue_price",
                "lot_size", "lots_applied"):
        if row.get(req) in (None, ""):
            raise ValueError(f"{req} is required")
    status = row.get("status") or "APPLIED"
    row["status"] = status
    sold = sum(int(s.get("qty") or 0) for s in sells)

    if status == "ALLOTTED":
        shares = row.get("shares_allotted")
        if not shares:
            raise ValueError("shares_allotted is required once the IPO is allotted")
        max_shares = int(row["lots_applied"]) * int(row["lot_size"])
        if int(shares) > max_shares:
            raise ValueError(f"shares_allotted ({shares}) is more than you applied "
                             f"for ({max_shares})")
        if int(shares) < sold:
            raise ValueError(f"shares_allotted ({shares}) is less than the {sold} "
                             "shares already sold")
    else:
        if sold:
            raise ValueError("this IPO has sells recorded — delete them before "
                             "changing it away from Allotted")
        row["shares_allotted"] = None

    apply_d = row["apply_date"]
    for f in ("allotment_date", "listing_date"):
        if row.get(f) and str(row[f]) < str(apply_d):
            raise ValueError(f"{f} ({row[f]}) is before the application date ({apply_d})")
    floor = row.get("listing_date") or apply_d
    early = [s["sell_date"] for s in sells if str(s.get("sell_date")) < str(floor)]
    if early:
        raise ValueError(f"a sell on {min(early)} is before "
                         f"{'listing' if row.get('listing_date') else 'the application'} "
                         f"({floor})")
    return row


def validate_sell(ipo: Dict[str, Any], others: List[Dict[str, Any]],
                  sell: Dict[str, Any]) -> None:
    """A sell against ``ipo`` given its OTHER sells. Raises ValueError."""
    for req in ("sell_date", "sell_price", "qty"):
        if sell.get(req) in (None, ""):
            raise ValueError(f"{req} is required")
    if ipo.get("status") != "ALLOTTED":
        raise ValueError("only an allotted IPO can be sold")
    held = int(ipo.get("shares_allotted") or 0) - sum(int(s.get("qty") or 0) for s in others)
    if int(sell["qty"]) > held:
        raise ValueError(f"qty ({sell['qty']}) is more than the {held} shares still held")
    floor = ipo.get("listing_date") or ipo.get("apply_date")
    if floor and str(sell["sell_date"]) < str(floor):
        what = "listing" if ipo.get("listing_date") else "the application"
        raise ValueError(f"sell_date ({sell['sell_date']}) is before {what} ({floor})")


def _today_ist() -> str:
    return datetime.now(_IST).date().isoformat()


def listing_from_bars(bars: List[Bar], *, apply_date: Optional[str] = None,
                      today: Optional[str] = None) -> Dict[str, Any]:
    """Listing day = the first daily candle. Raises ValueError when the
    history cannot be this IPO's (empty, or trading before the application)."""
    bars = sorted((b for b in bars if b.get("date")), key=lambda b: b["date"])
    if not bars:
        raise ValueError("no trading history yet — not listed, or wrong symbol")
    first, last = bars[0], bars[-1]
    if apply_date and first["date"] < apply_date:
        raise ValueError(f"this symbol has traded since {first['date']}, before your "
                         f"application on {apply_date} — check the symbol")
    today = today or _today_ist()
    # On listing day itself the "close" is still the live price.
    day_done = first["date"] < today
    return {
        "listing_date": first["date"],
        "listing_open": str(first["open"]),
        "listing_close": str(first["close"]) if day_done else None,
        "ltp": str(last["close"]),
        "ltp_date": last["date"],
    }


def bars_from_frame(df: Any) -> List[Bar]:
    """yfinance history DataFrame -> bars with 2-dp Decimal prices.
    Rows with a missing / non-positive open or close are skipped."""
    out: List[Bar] = []
    if df is None or getattr(df, "empty", True):
        return out
    for idx, rec in df.iterrows():
        try:
            o = Decimal(str(float(rec["Open"])))
            c = Decimal(str(float(rec["Close"])))
        except (InvalidOperation, ValueError, TypeError, KeyError):
            continue
        if not (o.is_finite() and c.is_finite()) or o <= 0 or c <= 0:
            continue
        day = idx.date() if hasattr(idx, "date") else date.fromisoformat(str(idx)[:10])
        out.append({"date": day.isoformat(),
                    "open": o.quantize(_CENT, rounding=ROUND_HALF_UP),
                    "close": c.quantize(_CENT, rounding=ROUND_HALF_UP)})
    return out


def _yf_daily(symbol: str, period: str) -> Result[List[Bar]]:
    """Default fetcher: NSE daily candles via the retrying yfinance client."""
    from plutus.adapters.yf_client import fetch_history
    res = fetch_history(f"{symbol}.NS", period=period)
    if not res.ok:
        return Result.failure(res.error or "fetch failed", symbol=symbol)
    return Result.success(bars_from_frame(res.value), symbol=symbol)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def register_ipo_routes(app: Any, cli: Any, *,
                        fetch_daily: Optional[FetchDaily] = None) -> None:
    """Mount /api/journal/ipos/* on the given FastAPI app.

    Args:
        app: FastAPI instance.
        cli: zero-arg callable returning the (injectable) supabase client.
        fetch_daily: ``(plain_symbol, period) -> Result[list[Bar]]``; tests
            inject a fake so the suite stays offline.
    """
    from fastapi import Body, HTTPException, Query

    from plutus.adapters import supabase_client as sb
    from plutus.api.serializers import serialize_rows, to_wire

    fetch = fetch_daily or _yf_daily

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
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            except Exception as exc:  # noqa: BLE001
                logger.exception("ipo route failed: %s", fn.__name__)
                raise HTTPException(status_code=502, detail=str(exc))
        return inner

    def wire(v: Any) -> Any:
        """Decimals to strings for the DB write (PostgREST takes JSON)."""
        return {k: (str(x) if isinstance(x, Decimal) else x) for k, x in v.items()}

    def get_ipo(ipo_id: int) -> Dict[str, Any]:
        rows = _rows(client().table("ipo_applications").select("*")
                     .eq("id", ipo_id).limit(1).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"IPO {ipo_id} not found")
        return rows[0]

    def sells_of(ipo_id: int) -> List[Dict[str, Any]]:
        return _rows(client().table("ipo_sells").select("*")
                     .eq("ipo_id", ipo_id).limit(1000).execute())

    def get_sell(sell_id: int) -> Dict[str, Any]:
        rows = _rows(client().table("ipo_sells").select("*")
                     .eq("id", sell_id).limit(1).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"sell {sell_id} not found")
        return rows[0]

    def with_sells(ipo: Dict[str, Any], sells: List[Dict[str, Any]]) -> Dict[str, Any]:
        out = to_wire(ipo)
        out["sells"] = serialize_rows(sorted(
            sells, key=lambda s: (str(s.get("sell_date")), s.get("id") or 0)))
        return out

    # -- Applications --------------------------------------------------------
    @app.get("/api/journal/ipos")
    @guard
    def list_ipos() -> dict:
        ipos = _rows(client().table("ipo_applications").select("*")
                     .order("apply_date", desc=True).order("id", desc=True)
                     .limit(5000).execute())
        sells = _rows(client().table("ipo_sells").select("*").limit(20000).execute())
        by_ipo: Dict[Any, List[Dict[str, Any]]] = {}
        for s in sells:
            by_ipo.setdefault(s.get("ipo_id"), []).append(s)
        out = [with_sells(i, by_ipo.get(i.get("id"), [])) for i in ipos]
        return {"ipos": out, "count": len(out)}

    @app.post("/api/journal/ipos")
    @guard
    def create_ipo(payload: dict = Body(...)) -> dict:
        row = clean_fields(payload, IPO_FIELDS)
        if not row.get("account"):
            row["account"] = "Self"
        row = validate_ipo(row, [])
        rows = _rows(client().table("ipo_applications").insert(wire(row)).execute())
        return {"ipo": with_sells(rows[0] if rows else row, [])}

    @app.put("/api/journal/ipos/{ipo_id}")
    @guard
    def update_ipo(ipo_id: int, payload: dict = Body(...)) -> dict:
        patch = clean_fields(payload, IPO_FIELDS)
        if not patch:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        current = get_ipo(ipo_id)
        sells = sells_of(ipo_id)
        merged = validate_ipo({**current, **patch}, sells)
        # Write the patch plus anything validation cleared (shares on a
        # status change away from ALLOTTED).
        if merged.get("shares_allotted") != current.get("shares_allotted"):
            patch["shares_allotted"] = merged["shares_allotted"]
        if "status" not in patch and merged["status"] != current.get("status"):
            patch["status"] = merged["status"]
        rows = _rows(client().table("ipo_applications")
                     .update(wire(patch)).eq("id", ipo_id).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"IPO {ipo_id} not found")
        return {"ipo": with_sells(rows[0], sells)}

    @app.delete("/api/journal/ipos/{ipo_id}")
    @guard
    def delete_ipo(ipo_id: int) -> dict:
        get_ipo(ipo_id)
        # FK cascades in Postgres; explicit here so the order never matters.
        client().table("ipo_sells").delete().eq("ipo_id", ipo_id).execute()
        client().table("ipo_applications").delete().eq("id", ipo_id).execute()
        return {"deleted": ipo_id}

    # -- Sells -----------------------------------------------------------------
    @app.post("/api/journal/ipos/{ipo_id}/sells")
    @guard
    def add_sell(ipo_id: int, payload: dict = Body(...)) -> dict:
        ipo = get_ipo(ipo_id)
        sell = clean_fields(payload, SELL_FIELDS)
        validate_sell(ipo, sells_of(ipo_id), sell)
        sell["ipo_id"] = ipo_id
        client().table("ipo_sells").insert(wire(sell)).execute()
        return {"ipo": with_sells(ipo, sells_of(ipo_id))}

    @app.put("/api/journal/ipos/sells/{sell_id}")
    @guard
    def update_sell(sell_id: int, payload: dict = Body(...)) -> dict:
        current = get_sell(sell_id)
        patch = clean_fields(payload, SELL_FIELDS)
        if not patch:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        ipo = get_ipo(int(current["ipo_id"]))
        others = [s for s in sells_of(ipo["id"]) if s.get("id") != sell_id]
        validate_sell(ipo, others, {**current, **patch})
        client().table("ipo_sells").update(wire(patch)).eq("id", sell_id).execute()
        return {"ipo": with_sells(ipo, sells_of(ipo["id"]))}

    @app.delete("/api/journal/ipos/sells/{sell_id}")
    @guard
    def delete_sell(sell_id: int) -> dict:
        current = get_sell(sell_id)
        client().table("ipo_sells").delete().eq("id", sell_id).execute()
        ipo = get_ipo(int(current["ipo_id"]))
        return {"ipo": with_sells(ipo, sells_of(ipo["id"]))}

    # -- Market data (yfinance; nothing saved) -----------------------------------
    @app.get("/api/journal/ipos/listing")
    @guard
    def listing(
        symbol: str = Query(..., description="Plain NSE symbol, e.g. TATATECH"),
        apply_date: Optional[str] = Query(None, description="YYYY-MM-DD sanity floor"),
    ) -> dict:
        sym = normalize_symbol(symbol)
        if sym is None:
            raise HTTPException(status_code=400, detail=f"{symbol!r} is not a valid NSE symbol")
        floor = _date(apply_date, "apply_date") if apply_date else None
        res = fetch(sym, "max")
        if not res.ok:
            raise HTTPException(status_code=404,
                                detail=f"no market data for {sym} — not listed yet, "
                                       "or wrong symbol")
        try:
            out = listing_from_bars(res.value or [], apply_date=floor)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"{sym}: {exc}")
        return {"symbol": sym, **out}

    @app.get("/api/journal/ipos/quotes")
    @guard
    def quotes(symbols: str = Query(..., description="Comma-separated NSE symbols")) -> dict:
        wanted = [s for s in dict.fromkeys(
            normalize_symbol(x) for x in symbols.split(",")) if s]
        if len(wanted) > MAX_QUOTE_SYMBOLS:
            raise HTTPException(status_code=400,
                                detail=f"at most {MAX_QUOTE_SYMBOLS} symbols per call")
        out: Dict[str, Dict[str, str]] = {}
        errors: Dict[str, str] = {}
        for sym in wanted:
            res = fetch(sym, "5d")
            bars = sorted(res.value or [], key=lambda b: b["date"]) if res.ok else []
            if not bars:
                errors[sym] = res.error or "no recent price"
                continue
            out[sym] = {"ltp": str(bars[-1]["close"]), "date": bars[-1]["date"]}
        return {"quotes": out, "errors": errors}
