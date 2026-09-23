"""
Universe routes — the stock universe as the single source of truth.

Every pool view, scan and journal lookup reads `stocks`; this module is the
ONLY place that changes pool membership after the one-time CSV seed.

Design contract (mirrors plutus.api.journal):
  * Owner-only writes behind the shared-credential gate (X-Plutus-Auth);
    anon has no access to `universe_syncs`, and `stocks` writes never come
    from the frontend directly.
  * Per-table field whitelists — unknown keys are dropped.
  * NOTHING here deletes a `stocks` row. Removing a stock from its last pool
    flips `active` only, and a stock the Trading Journal still references
    (OPEN trade or ACTIVE opportunity) stays active so its LTP keeps
    syncing. Journal tables are read, never written.
  * Every bulk change (import today, Screener screen later) is recorded in
    `universe_syncs` with the full diff, so the Universe page can show
    "last updated: import on <date>, +12 / −8" and the S200 screen can use
    the same preview → consent → apply flow without a schema change.
  * Symbols are stored in yfinance form (`TCS.NS`); the journal's plain
    `TCS` is matched by stripping the suffix.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

POOL_CODES = ("F40", "E40", "S200", "PlayArea")
# Pools whose membership the owner edits by hand / import. S200 is included
# for the first cut (manual import); the screen job takes over later and the
# UI flags S200 as a quantitative list.
EDITABLE_POOLS = frozenset(POOL_CODES)

SECTOR_GROUPS = ("Banks", "NBFC", "Normal")
CAP_TYPES = ("Large", "Mid", "Small", "Micro")

STOCK_EDIT_FIELDS = {"name", "sector", "industry", "cap_type_manual", "sector_group"}
STOCK_SELECT = ("id,symbol,name,sector,industry,exchange,active,pools,"
                "cap_type_manual,sector_group,metadata,updated_at")
SYNC_SELECT = ("id,pool_code,kind,status,mode,criteria,diff,error,"
               "triggered_by,created_at,applied_at,updated_at")

_SUFFIX_RE = re.compile(r"\.(NS|BO)$", re.IGNORECASE)
_SYMBOL_BODY_RE = re.compile(r"^[A-Z0-9&\-]{1,20}$")

# Default S200 screen criteria (also seeded by migration 019). Strings only.
DEFAULT_SCREEN_CRITERIA: Dict[str, Any] = {
    "normal": {
        "net_debt_to_equity_max": "0.25",
        "roce_min": "12",
        "net_profit_min_cr": "200",
    },
    "banks_nbfc": {
        "roe_min": "10",
        "net_profit_min_cr": "1000",
    },
}
_CRITERIA_KEYS = {
    "normal": {"net_debt_to_equity_max", "roce_min", "net_profit_min_cr"},
    "banks_nbfc": {"roe_min", "net_profit_min_cr"},
}


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested without a client)
# ---------------------------------------------------------------------------

def _rows(res: Any) -> List[Dict[str, Any]]:
    return list(getattr(res, "data", None) or [])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def plain_symbol(symbol: str) -> str:
    """'TCS.NS' -> 'TCS' (journal convention)."""
    return _SUFFIX_RE.sub("", (symbol or "").strip().upper())


def canonical_symbol(raw: Any) -> Optional[str]:
    """'tcs' / 'TCS' / 'TCS.NS' -> 'TCS.NS'; 'XYZ.BO' passes through.
    Returns None for anything that is not a plausible NSE/BSE ticker."""
    if not isinstance(raw, str):
        return None
    s = raw.strip().upper()
    if not s:
        return None
    m = _SUFFIX_RE.search(s)
    suffix = m.group(0).upper() if m else ".NS"
    body = _SUFFIX_RE.sub("", s)
    if not _SYMBOL_BODY_RE.match(body):
        return None
    return f"{body}{suffix}"


def normalize_cap_type(raw: Any) -> Optional[str]:
    """'Large Cap' / 'large' / 'MID' / 'Smallcap' -> 'Large' | 'Mid' | 'Small' | 'Micro'.
    Unknown / blank -> None (the snapshot's derived bucket is used instead)."""
    if not isinstance(raw, str):
        return None
    s = re.sub(r"[\s\-_]*cap$", "", raw.strip(), flags=re.IGNORECASE).strip().lower()
    if not s or s in {"#n/a", "n/a", "na", "-", "—"}:
        return None
    for cap in CAP_TYPES:
        if s == cap.lower():
            return cap
    return None


def normalize_sector_group(raw: Any) -> Optional[str]:
    """'banks' / 'BANK' -> 'Banks'; 'nbfc' / 'non-banking' -> 'NBFC';
    'normal' / 'non banking' (as the criteria label) -> 'Normal'; else None."""
    if not isinstance(raw, str):
        return None
    s = raw.strip().lower()
    if not s:
        return None
    if s in {"bank", "banks"}:
        return "Banks"
    if s in {"nbfc", "nbfcs", "non-banking", "nonbanking", "banks & nbfc", "banks & nbfcs"}:
        return "NBFC"
    if s in {"normal", "non banking", "non-bank", "others", "other"}:
        return "Normal"
    return None


def _clean_stock_fields(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Whitelist + normalise the editable stock columns."""
    out: Dict[str, Any] = {}
    for k, v in (payload or {}).items():
        if k not in STOCK_EDIT_FIELDS:
            continue
        if isinstance(v, str):
            v = v.strip() or None
        out[k] = v
    if "cap_type_manual" in out and out["cap_type_manual"] is not None:
        cap = normalize_cap_type(out["cap_type_manual"])
        if cap is None:
            raise ValueError(
                f"cap_type_manual must be one of {', '.join(CAP_TYPES)}")
        out["cap_type_manual"] = cap
    if "sector_group" in out and out["sector_group"] is not None:
        grp = normalize_sector_group(out["sector_group"])
        if grp is None:
            raise ValueError(
                f"sector_group must be one of {', '.join(SECTOR_GROUPS)}")
        out["sector_group"] = grp
    return out


def parse_import_rows(rows: Iterable[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
    """Validate import rows -> (clean rows keyed by canonical symbol, rejects).
    Duplicate symbols collapse to one row (last non-empty value wins)."""
    clean: Dict[str, Dict[str, Any]] = {}
    rejects: List[Dict[str, str]] = []
    for raw in rows or []:
        if not isinstance(raw, dict):
            rejects.append({"symbol": str(raw), "reason": "not an object"})
            continue
        sym = canonical_symbol(raw.get("symbol"))
        if sym is None:
            rejects.append({"symbol": str(raw.get("symbol", "")),
                            "reason": "not a valid NSE/BSE symbol"})
            continue
        row = clean.setdefault(sym, {"symbol": sym})
        name = raw.get("name")
        if isinstance(name, str) and name.strip():
            row["name"] = name.strip()
        sector = raw.get("sector")
        if isinstance(sector, str) and sector.strip():
            row["sector"] = sector.strip()
        industry = raw.get("industry")
        if isinstance(industry, str) and industry.strip():
            row["industry"] = industry.strip()
        cap = normalize_cap_type(raw.get("cap_type_manual") or raw.get("cap_type") or raw.get("cap"))
        if cap:
            row["cap_type_manual"] = cap
        grp = normalize_sector_group(raw.get("sector_group") or raw.get("group"))
        if grp:
            row["sector_group"] = grp
        elif "sector_group" not in row:
            # A CSV that only carries 'Banks'/'NBFC'/'Normal' in the sector
            # column (the master template's S200 block) classifies too.
            grp2 = normalize_sector_group(sector) if isinstance(sector, str) else None
            if grp2:
                row["sector_group"] = grp2
                if grp2 == "Normal" and row.get("sector", "").lower() == "normal":
                    row.pop("sector", None)   # 'Normal' is a label, not a sector
    return list(clean.values()), rejects


_PREFIX_RE = re.compile(r"^(NSE|BSE)\s*:\s*", re.IGNORECASE)
PASTE_MAX_SYMBOLS = 300


def parse_symbol_list(text: Any) -> Tuple[List[str], List[str]]:
    """Free-text symbol list -> (canonical symbols, rejected tokens).

    Accepts TradingView exports ('NSE:APTUS,' one per line), comma / space /
    newline / semicolon separated tokens, plain 'TCS' or 'TCS.NS'.
    'BSE:500325' becomes '500325.BO'. Order preserved, duplicates dropped."""
    if not isinstance(text, str):
        return [], []
    out: List[str] = []
    rejects: List[str] = []
    seen: Set[str] = set()
    for tok in re.split(r"[,\s;]+", text):
        tok = tok.strip().strip('"').strip("'")
        if not tok:
            continue
        m = _PREFIX_RE.match(tok)
        body = _PREFIX_RE.sub("", tok)
        if m and m.group(1).upper() == "BSE" and not _SUFFIX_RE.search(body):
            body = f"{body}.BO"
        sym = canonical_symbol(body)
        if sym is None:
            rejects.append(tok)
        elif sym not in seen:
            seen.add(sym)
            out.append(sym)
    return out, rejects


# yfinance `industry` strings -> criteria group. Banks & NBFC are screened on
# ROE + Net profit; insurers, AMCs, brokers and exchanges are NOT NBFCs in
# the owner's scheme (they carry the Normal rules), matching the S200 labels.
_NBFC_INDUSTRIES = {"credit services", "mortgage finance", "financial conglomerates",
                    "specialty finance", "consumer finance"}


def classify_sector_group(sector: Any, industry: Any) -> Optional[str]:
    """('Financial Services', 'Banks - Regional') -> 'Banks';
    ('Financial Services', 'Credit Services') -> 'NBFC'; anything else with a
    known sector/industry -> 'Normal'; nothing known -> None."""
    ind = (industry or "").strip().lower() if isinstance(industry, str) else ""
    sec = (sector or "").strip().lower() if isinstance(sector, str) else ""
    if not ind and not sec:
        return None
    if "bank" in ind:
        return "Banks"
    if ind in _NBFC_INDUSTRIES or ("nbfc" in ind):
        return "NBFC"
    return "Normal"


def fields_from_info(info: Dict[str, Any]) -> Dict[str, Any]:
    """yfinance `.info` -> the universe columns we can fill. Never raises;
    missing keys simply stay absent so existing values are not overwritten."""
    from plutus.metrics.cap_bucket import classify_market_cap
    from plutus.registry.types import to_decimal

    out: Dict[str, Any] = {}
    if not isinstance(info, dict):
        return out
    name = info.get("longName") or info.get("shortName")
    if isinstance(name, str) and name.strip():
        out["name"] = name.strip()
    sector = info.get("sector")
    if isinstance(sector, str) and sector.strip():
        out["sector"] = sector.strip()
    industry = info.get("industry")
    if isinstance(industry, str) and industry.strip():
        out["industry"] = industry.strip()
    mcap = info.get("marketCap")
    if mcap is not None:
        try:
            bucket = classify_market_cap(to_decimal(mcap))
        except Exception:  # noqa: BLE001 — junk marketCap must not sink the row
            bucket = None
        if bucket:
            out["cap_type_manual"] = bucket
    grp = classify_sector_group(sector, industry)
    if grp:
        out["sector_group"] = grp
    return out


# Columns the paste flow fills when a stock lacks them.
_ENRICH_FIELDS = ("name", "sector", "industry", "cap_type_manual", "sector_group")


def needs_enrichment(existing: Optional[Dict[str, Any]]) -> bool:
    return existing is None or any(not existing.get(k) for k in _ENRICH_FIELDS)


def compute_pool_diff(
    pool: str,
    current: Dict[str, Dict[str, Any]],
    incoming: List[Dict[str, Any]],
    *,
    mode: str,
) -> Dict[str, Any]:
    """
    Pure diff between the pool's current members and an incoming list.

    current  : every known stock (active or not) keyed by canonical symbol.
    incoming : cleaned import rows.
    mode     : 'merge'   -> add / update only, nobody leaves the pool
               'replace' -> pool membership becomes exactly `incoming`

    Returns {added, updated, removed, unchanged, new_stocks} where each list
    holds symbols (`new_stocks` = symbols that do not exist in `stocks` yet).
    """
    members_now: Set[str] = {
        s for s, r in current.items() if pool in (r.get("pools") or [])
    }
    incoming_syms = {r["symbol"] for r in incoming}
    added: List[str] = []
    updated: List[str] = []
    unchanged: List[str] = []
    new_stocks: List[str] = []
    for r in incoming:
        sym = r["symbol"]
        existing = current.get(sym)
        if existing is None:
            new_stocks.append(sym)
            added.append(sym)
            continue
        if sym not in members_now:
            added.append(sym)
            continue
        changed = any(
            k in r and r[k] != existing.get(k)
            for k in ("name", "sector", "industry", "cap_type_manual", "sector_group")
        )
        (updated if changed else unchanged).append(sym)
    removed = sorted(members_now - incoming_syms) if mode == "replace" else []
    return {
        "added": sorted(added),
        "updated": sorted(updated),
        "removed": removed,
        "unchanged": len(unchanged),
        "new_stocks": sorted(new_stocks),
    }


def clean_criteria(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Validate the S200 screen thresholds. Values are kept as strings
    (no float), but must parse as non-negative decimals."""
    from decimal import Decimal, InvalidOperation

    out: Dict[str, Any] = {}
    for group, keys in _CRITERIA_KEYS.items():
        src = (payload or {}).get(group) or {}
        if not isinstance(src, dict):
            raise ValueError(f"{group} must be an object")
        grp_out: Dict[str, str] = {}
        for key in keys:
            raw = src.get(key, DEFAULT_SCREEN_CRITERIA[group][key])
            s = str(raw).strip()
            try:
                d = Decimal(s)
            except (InvalidOperation, ValueError):
                raise ValueError(f"{group}.{key} must be a number, got {raw!r}")
            if d < 0:
                raise ValueError(f"{group}.{key} must be >= 0")
            # Plain digits on the wire: '250' not '2.5E+2', '12.5' not '12.50'.
            grp_out[key] = str(int(d)) if d == d.to_integral() else str(d.normalize())
        out[group] = grp_out
    return out


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def register_universe_routes(app: Any, cli: Any, *, fetch_info: Any = None) -> None:
    """Mount /api/universe/* on the given FastAPI app.

    Args:
        app: FastAPI instance.
        cli: zero-arg callable returning the (injectable) supabase client.
        fetch_info: ``symbol -> Result[dict]`` used by the paste flow to fill
            name / sector / cap / group. Defaults to the yfinance adapter;
            tests inject a fake so the suite never touches the network.
    """
    from fastapi import Body, HTTPException, Query

    if fetch_info is None:
        from plutus.adapters.yf_client import fetch_info as _yf_fetch_info
        fetch_info = _yf_fetch_info

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
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            except Exception as exc:  # noqa: BLE001
                logger.exception("universe route failed: %s", fn.__name__)
                raise HTTPException(status_code=502, detail=str(exc))
        return inner

    # -- data access --------------------------------------------------------
    def _pool_or_404(code: str) -> Dict[str, Any]:
        rows = _rows(client().table("pools").select("*").eq("code", code)
                     .limit(1).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"pool {code} not found")
        return rows[0]

    def _all_stocks() -> Dict[str, Dict[str, Any]]:
        rows = _rows(client().table("stocks").select(STOCK_SELECT)
                     .order("symbol").limit(5000).execute())
        return {r["symbol"]: r for r in rows}

    def _stock(symbol: str) -> Optional[Dict[str, Any]]:
        rows = _rows(client().table("stocks").select(STOCK_SELECT)
                     .eq("symbol", symbol).limit(1).execute())
        return rows[0] if rows else None

    def _journal_refs() -> Dict[str, Dict[str, int]]:
        """plain symbol -> {open_trades, active_opps}. Read-only."""
        refs: Dict[str, Dict[str, int]] = {}
        try:
            trades = _rows(client().table("journal_trades").select("symbol,status")
                           .eq("status", "OPEN").limit(5000).execute())
            for t in trades:
                slot = refs.setdefault(plain_symbol(t["symbol"]), {"open_trades": 0, "active_opps": 0})
                slot["open_trades"] += 1
            opps = _rows(client().table("journal_opportunities").select("symbol,status")
                         .eq("status", "ACTIVE").limit(5000).execute())
            for o in opps:
                slot = refs.setdefault(plain_symbol(o["symbol"]), {"open_trades": 0, "active_opps": 0})
                slot["active_opps"] += 1
        except Exception as exc:  # noqa: BLE001 — journal tables may be absent on a bare DB
            logger.warning("journal reference lookup failed: %s", exc)
        return refs

    def _journal_holds(symbol: str, refs: Optional[Dict[str, Dict[str, int]]] = None) -> bool:
        refs = refs if refs is not None else _journal_refs()
        slot = refs.get(plain_symbol(symbol))
        return bool(slot and (slot["open_trades"] or slot["active_opps"]))

    def _membership_meta(existing: Dict[str, Any], pool: str, source: str) -> Dict[str, Any]:
        meta = dict(existing.get("metadata") or {})
        membership = dict(meta.get("membership") or {})
        membership[pool] = {"source": source, "at": _now()}
        meta["membership"] = membership
        return meta

    def _update_stock(symbol: str, patch: Dict[str, Any]) -> Dict[str, Any]:
        rows = _rows(client().table("stocks").update(patch).eq("symbol", symbol).execute())
        return rows[0] if rows else {**patch, "symbol": symbol}

    def _add_member(sym: str, pool: str, fields: Dict[str, Any], *,
                    existing: Optional[Dict[str, Any]], source: str) -> Dict[str, Any]:
        """Create the stock row if needed, then tag it with `pool`."""
        if existing is None:
            row = {
                "symbol": sym,
                "exchange": "BSE" if sym.endswith(".BO") else "NSE",
                "active": True,
                "pools": [pool],
                "metadata": {"membership": {pool: {"source": source, "at": _now()}}},
                **{k: v for k, v in fields.items() if k in STOCK_EDIT_FIELDS},
            }
            rows = _rows(client().table("stocks").insert(row).execute())
            return rows[0] if rows else row
        pools = list(existing.get("pools") or [])
        if pool not in pools:
            pools.append(pool)
        patch: Dict[str, Any] = {
            "pools": pools,
            "active": True,
            "metadata": _membership_meta(existing, pool, source),
        }
        for k, v in fields.items():
            if k in STOCK_EDIT_FIELDS and v is not None:
                patch[k] = v
        return _update_stock(sym, patch)

    def _remove_member(existing: Dict[str, Any], pool: str,
                       refs: Dict[str, Dict[str, int]]) -> Dict[str, Any]:
        """Untag; retire (active=false) only when no pool AND no journal
        reference remains. Never deletes."""
        pools = [p for p in (existing.get("pools") or []) if p != pool]
        meta = dict(existing.get("metadata") or {})
        membership = dict(meta.get("membership") or {})
        membership.pop(pool, None)
        meta["membership"] = membership
        patch: Dict[str, Any] = {"pools": pools, "metadata": meta}
        if not pools and not _journal_holds(existing["symbol"], refs):
            patch["active"] = False
        return _update_stock(existing["symbol"], patch)

    def _record_sync(row: Dict[str, Any]) -> Dict[str, Any]:
        rows = _rows(client().table("universe_syncs").insert(row).execute())
        return rows[0] if rows else row

    def _latest_applied_syncs() -> Dict[str, Dict[str, Any]]:
        rows = _rows(client().table("universe_syncs").select(SYNC_SELECT)
                     .eq("status", "applied").order("applied_at", desc=True)
                     .limit(50).execute())
        out: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            out.setdefault(r["pool_code"], r)
        return out

    # -- read ---------------------------------------------------------------
    @app.get("/api/universe")
    @guard
    def get_universe(include_inactive: bool = Query(False)) -> dict:
        stocks = list(_all_stocks().values())
        if not include_inactive:
            stocks = [s for s in stocks if s.get("active")]
        pools = _rows(client().table("pools").select("*").order("display_order").execute())
        counts = {p["code"]: 0 for p in pools}
        for s in stocks:
            for p in s.get("pools") or []:
                counts[p] = counts.get(p, 0) + 1
        return {
            "pools": serialize_rows(pools),
            "stocks": serialize_rows(stocks),
            "counts": counts,
            "journal_refs": _journal_refs(),
            "last_syncs": {k: to_wire(v) for k, v in _latest_applied_syncs().items()},
            "editable_pools": sorted(EDITABLE_POOLS),
        }

    # -- single stock -------------------------------------------------------
    @app.put("/api/universe/stocks/{symbol}")
    @guard
    def update_stock(symbol: str, payload: dict = Body(...)) -> dict:
        sym = canonical_symbol(symbol)
        if sym is None:
            raise HTTPException(status_code=400, detail="invalid symbol")
        existing = _stock(sym)
        if existing is None:
            raise HTTPException(status_code=404, detail=f"{sym} is not in the universe")
        patch = _clean_stock_fields(payload)
        if not patch:
            raise HTTPException(status_code=400, detail="no editable fields in payload")
        return {"stock": to_wire(_update_stock(sym, patch))}

    # -- pool membership ----------------------------------------------------
    @app.post("/api/universe/pools/{code}/members")
    @guard
    def add_member(code: str, payload: dict = Body(...)) -> dict:
        _pool_or_404(code)
        if code not in EDITABLE_POOLS:
            raise HTTPException(status_code=403, detail=f"{code} is not editable")
        sym = canonical_symbol(payload.get("symbol"))
        if sym is None:
            raise HTTPException(status_code=400, detail="symbol is required (e.g. TCS or TCS.NS)")
        fields = _clean_stock_fields(payload)
        existing = _stock(sym)
        already = existing is not None and code in (existing.get("pools") or [])
        row = _add_member(sym, code, fields, existing=existing, source="manual")
        return {"stock": to_wire(row), "already_member": already}

    @app.delete("/api/universe/pools/{code}/members/{symbol}")
    @guard
    def remove_member(code: str, symbol: str) -> dict:
        _pool_or_404(code)
        if code not in EDITABLE_POOLS:
            raise HTTPException(status_code=403, detail=f"{code} is not editable")
        sym = canonical_symbol(symbol)
        existing = _stock(sym) if sym else None
        if existing is None or code not in (existing.get("pools") or []):
            raise HTTPException(status_code=404, detail=f"{symbol} is not in {code}")
        row = _remove_member(existing, code, _journal_refs())
        return {"stock": to_wire(row), "retired": not row.get("active", True)}

    # -- bulk import (preview with dry_run, then apply) ----------------------
    @app.post("/api/universe/pools/{code}/import")
    @guard
    def import_members(code: str, payload: dict = Body(...)) -> dict:
        _pool_or_404(code)
        if code not in EDITABLE_POOLS:
            raise HTTPException(status_code=403, detail=f"{code} is not editable")
        mode = str(payload.get("mode") or "merge").lower()
        if mode not in ("merge", "replace"):
            raise HTTPException(status_code=400, detail="mode must be merge or replace")
        dry_run = bool(payload.get("dry_run", False))
        incoming, rejects = parse_import_rows(payload.get("rows") or [])
        if not incoming:
            raise HTTPException(status_code=400, detail="no valid rows to import")

        current = _all_stocks()
        diff = compute_pool_diff(code, current, incoming, mode=mode)
        diff["rejected"] = rejects
        refs = _journal_refs()
        # Symbols that would leave the pool but stay active for the journal.
        diff["kept_for_journal"] = [s for s in diff["removed"]
                                    if len([p for p in (current[s].get("pools") or []) if p != code]) == 0
                                    and _journal_holds(s, refs)]
        if dry_run:
            return {"pool": code, "mode": mode, "dry_run": True, "diff": diff,
                    "row_count": len(incoming)}

        by_symbol = {r["symbol"]: r for r in incoming}
        for sym in diff["added"] + diff["updated"]:
            fields = {k: v for k, v in by_symbol[sym].items() if k != "symbol"}
            _add_member(sym, code, fields, existing=current.get(sym), source="import")
        for sym in diff["removed"]:
            _remove_member(current[sym], code, refs)

        sync = _record_sync({
            "pool_code": code, "kind": "import", "status": "applied", "mode": mode,
            "criteria": {"columns": sorted({k for r in incoming for k in r if k != "symbol"}),
                         "row_count": len(incoming)},
            "diff": diff, "applied_at": _now(), "triggered_by": "owner",
        })
        return {"pool": code, "mode": mode, "dry_run": False, "diff": diff,
                "row_count": len(incoming), "sync": to_wire(sync)}

    # -- paste a symbol list (TradingView export etc.) ------------------------
    # Parses the text, fills name / sector / industry / cap / group for every
    # symbol that lacks them (yfinance .info), previews the diff (dry_run),
    # then adds the symbols to the pool. Enrichment failures never block a
    # symbol: it is added with whatever is known and flagged in the response.
    @app.post("/api/universe/pools/{code}/paste")
    @guard
    def paste_members(code: str, payload: dict = Body(...)) -> dict:
        _pool_or_404(code)
        if code not in EDITABLE_POOLS:
            raise HTTPException(status_code=403, detail=f"{code} is not editable")
        symbols, rejected = parse_symbol_list(payload.get("text"))
        if not symbols:
            raise HTTPException(status_code=400, detail="no symbols found in the pasted text")
        if len(symbols) > PASTE_MAX_SYMBOLS:
            raise HTTPException(status_code=400,
                                detail=f"too many symbols ({len(symbols)}); paste at most {PASTE_MAX_SYMBOLS}")
        dry_run = bool(payload.get("dry_run", False))
        refresh = bool(payload.get("refresh", False))   # re-fetch even when known
        mode = str(payload.get("mode") or "merge").lower()
        if mode not in ("merge", "replace"):
            raise HTTPException(status_code=400, detail="mode must be merge or replace")

        current = _all_stocks()
        refs = _journal_refs()
        rows: List[Dict[str, Any]] = []
        details: List[Dict[str, Any]] = []
        for sym in symbols:
            existing = current.get(sym)
            fields: Dict[str, Any] = {}
            source = "existing"
            error: Optional[str] = None
            if refresh or needs_enrichment(existing):
                res = fetch_info(sym)
                if getattr(res, "ok", False):
                    fetched = fields_from_info(res.value or {})
                    # Fill gaps only (refresh overwrites) — never blank a value
                    # the owner typed by hand.
                    for k, v in fetched.items():
                        if refresh or existing is None or not existing.get(k):
                            fields[k] = v
                    source = "yfinance"
                else:
                    source = "failed"
                    error = getattr(res, "error", None) or "lookup failed"
            merged = {**(existing or {}), **fields}
            rows.append({"symbol": sym, **fields})
            details.append({
                "symbol": sym,
                "known": existing is not None,
                "in_pool": bool(existing and code in (existing.get("pools") or [])),
                "source": source,
                "error": error,
                "name": merged.get("name"),
                "sector": merged.get("sector"),
                "industry": merged.get("industry"),
                "cap_type_manual": merged.get("cap_type_manual"),
                "sector_group": merged.get("sector_group"),
            })

        diff = compute_pool_diff(code, current, rows, mode=mode)
        diff["rejected"] = [{"symbol": t, "reason": "not a valid NSE/BSE symbol"} for t in rejected]
        # Replace mode: members not pasted leave the pool. A stock with no pool
        # left is retired unless the journal still holds it (then it stays
        # active so its LTP keeps syncing) — surfaced here for the preview.
        diff["kept_for_journal"] = [
            s for s in diff["removed"]
            if not [p for p in (current[s].get("pools") or []) if p != code]
            and _journal_holds(s, refs)]
        result = {"pool": code, "mode": mode, "dry_run": dry_run, "diff": diff,
                  "row_count": len(rows), "symbols": details,
                  "fetched": sum(1 for d in details if d["source"] == "yfinance"),
                  "failed": sum(1 for d in details if d["source"] == "failed")}
        if dry_run:
            return result

        by_symbol = {r["symbol"]: r for r in rows}
        for sym in diff["added"] + diff["updated"]:
            fields = {k: v for k, v in by_symbol[sym].items() if k != "symbol"}
            _add_member(sym, code, fields, existing=current.get(sym), source="paste")
        for sym in diff["removed"]:
            _remove_member(current[sym], code, refs)
        sync = _record_sync({
            "pool_code": code, "kind": "import", "status": "applied", "mode": mode,
            "criteria": {"source": "paste", "row_count": len(rows),
                         "fetched": result["fetched"], "failed": result["failed"]},
            "diff": diff, "applied_at": _now(), "triggered_by": "owner",
        })
        result["sync"] = to_wire(sync)
        return result

    # -- S200 screen criteria -----------------------------------------------
    @app.get("/api/universe/pools/{code}/criteria")
    @guard
    def get_criteria(code: str) -> dict:
        pool = _pool_or_404(code)
        meta = pool.get("metadata") or {}
        crit = meta.get("screen_criteria") or {}
        merged = {g: {**DEFAULT_SCREEN_CRITERIA[g], **(crit.get(g) or {})}
                  for g in DEFAULT_SCREEN_CRITERIA}
        return {"pool": code, "criteria": merged,
                "updated_at": crit.get("updated_at"),
                "defaults": DEFAULT_SCREEN_CRITERIA}

    @app.put("/api/universe/pools/{code}/criteria")
    @guard
    def put_criteria(code: str, payload: dict = Body(...)) -> dict:
        pool = _pool_or_404(code)
        crit = clean_criteria(payload)
        crit["updated_at"] = _now()
        meta = dict(pool.get("metadata") or {})
        meta["screen_criteria"] = crit
        client().table("pools").update({"metadata": meta}).eq("code", code).execute()
        return {"pool": code, "criteria": {g: crit[g] for g in DEFAULT_SCREEN_CRITERIA},
                "updated_at": crit["updated_at"]}

    # -- change-set history --------------------------------------------------
    @app.get("/api/universe/syncs")
    @guard
    def list_syncs(pool: Optional[str] = Query(None),
                   limit: int = Query(20, ge=1, le=100)) -> dict:
        q = client().table("universe_syncs").select(SYNC_SELECT)
        if pool:
            q = q.eq("pool_code", pool)
        rows = _rows(q.order("created_at", desc=True).limit(limit).execute())
        return {"syncs": serialize_rows(rows), "count": len(rows)}

    # -- Screener screen (S200) — contract placeholder ------------------------
    # The preview → consent → apply flow is: POST .../screen starts a
    # universe_syncs row in status 'running'; the worker fills `candidates`
    # + `diff` and moves it to 'preview'; the owner then POSTs
    # .../syncs/{id}/apply (or /discard). Only the worker is missing.
    @app.post("/api/universe/pools/{code}/screen")
    @guard
    def start_screen(code: str) -> dict:
        _pool_or_404(code)
        raise HTTPException(
            status_code=501,
            detail="Screener.in screening is not wired yet — import the S200 "
                   "list on the Universe page for now. The criteria shown "
                   "there are what the screen will use.")

    @app.post("/api/universe/syncs/{sync_id}/discard")
    @guard
    def discard_sync(sync_id: int) -> dict:
        rows = _rows(client().table("universe_syncs").select(SYNC_SELECT)
                     .eq("id", sync_id).limit(1).execute())
        if not rows:
            raise HTTPException(status_code=404, detail=f"sync {sync_id} not found")
        if rows[0].get("status") != "preview":
            raise HTTPException(status_code=409, detail="only a preview can be discarded")
        out = _rows(client().table("universe_syncs")
                    .update({"status": "discarded"}).eq("id", sync_id).execute())
        return {"sync": to_wire(out[0] if out else {**rows[0], "status": "discarded"})}
