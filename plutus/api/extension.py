"""
Browser-extension read routes — /api/extension/* and /api/strategy_configs.

The Plutus Companion extension (``extension/``) overlays Plutus data on
TradingView and Screener.in. It needs everything for the whole universe in
ONE call at start-up (cached client-side per snapshot_date) and everything
about ONE stock when a page is opened. Serving those two shapes here keeps
the extension free of joins and lets the API host's cold start be paid
once.

Design contract:
  * READ-ONLY. Market data only — no personal tables are touched here, so
    these routes stay open like /api/pools and /api/snapshots. Positions,
    notes and watchlists are fetched by the extension from their own gated
    routes with the owner token.
  * Money-safe: every response passes through serializers.to_wire, so
    NUMERIC values travel as strings.
  * Thresholds are read from the SAME constants the scan strategies use
    (plutus.scan.strategies.*) plus the frontend's cap-aware ATH rule, so
    the extension, the web app and the scan engine agree by construction.
    Rows in `strategy_configs` (if any) are returned alongside for
    overrides; the extension applies them the way the engine does.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

from plutus.api import repository as repo
from plutus.api.serializers import to_wire

logger = logging.getLogger(__name__)

BOOTSTRAP_VERSION = 1

# Same as frontend_v2/src/lib/rows.ts ATH_FALL_RULE — Large > 20 · Mid > 30 ·
# Small & Micro > 40 (% fall from ATH before a stock counts as beaten down).
ATH_FALL_RULE = {"Large": Decimal("20"), "Mid": Decimal("30"),
                 "Small": Decimal("40"), "Micro": Decimal("40")}

# Rules from UserData/Fundamental POinters.md that no strategy encodes yet
# but the Screener overlay checks on the page itself.
POINTER_RULES = {
    "public_holding_max_pct": Decimal("30"),
    "ttm_net_profit_min_cr": Decimal("250"),
    "ttm_vs_peak_min_ratio": Decimal("0.90"),   # TTM sales / NP >= 90 % of 10-yr max
    "tfa_vs_peak_min_ratio": Decimal("0.90"),   # tangible fixed assets vs 10-yr max
}

_SUFFIX_RE = re.compile(r"\.(NS|BO)$", re.IGNORECASE)

# Snapshot columns the panel needs per stock (kept small: ~450 stocks/call).
SNAPSHOT_KEYS = (
    "close", "cap_bucket", "market_cap", "pe_current", "pb_current",
    "dma_200", "below_200dma_pct",
    "high_52w", "low_52w", "distance_from_52w_high_pct", "distance_from_52w_low_pct",
    "ath", "fall_from_ath_pct",
    "has_valid_20pct_rally", "last_rally_pct", "last_rally_low", "last_rally_high",
    "days_since_last_rally", "price_change_nd_pct",
)

# Strongest technical signal wins (mirrors rows.ts TECH_RANK).
TECH_RANK = {"BUY_ZONE": 4, "OPPORTUNITY": 3, "VALID": 2, "NO_SIGNAL": 1, "INVALID": 1}
TECHNICAL_STRATEGIES = ("envelope_200dma", "week52_high_low", "rally_20_percent")
FUNDAMENTAL_STRATEGY = "fundamental_screener"


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested without a client)
# ---------------------------------------------------------------------------

def plain_symbol(symbol: str) -> str:
    """'TCS.NS' -> 'TCS'; 'BSE:500325.BO' style never occurs, so this is enough."""
    return _SUFFIX_RE.sub("", (symbol or "").strip().upper())


def tv_symbol(symbol: str) -> str:
    """yfinance form -> TradingView form. Hyphen / ampersand tickers become
    underscores the way TradingView spells them ('M&M' -> 'NSE:M_M')."""
    s = (symbol or "").strip().upper()
    exch = "BSE" if s.endswith(".BO") else "NSE"
    body = plain_symbol(s).replace("-", "_").replace("&", "_")
    return f"{exch}:{body}"


def default_thresholds() -> Dict[str, Any]:
    """The constants the scan engine runs with, as one dict for the wire."""
    from plutus.scan.strategies import envelope, fundamental, week52
    fd = fundamental.DEFAULTS
    return {
        "fundamental": {
            "pe_max": fd["pe_max"],
            "net_debt_to_equity_max": fd["net_debt_to_equity_max"],
            "roce_min": fd["roce_min"],
            "roe_min": fd["roe_min"],
            "pledging_max": fd["pledging_max"],
            "ath_tolerance": fd["ath_tolerance"],
            "yoy_growth_min": fd["yoy_growth_min"],
            "points_max": fundamental.POINTS_MAX,
            "pass_points": fundamental.PASS_THRESHOLD_POINTS,
            # Lender lists (stocks.sector_group Banks | NBFC): PE / ROE /
            # ROA / TTM profit / NPA bars replace Net D/E, ROCE and Sales.
            "groups": {
                grp: dict(vals) for grp, vals in fundamental.GROUP_DEFAULTS.items()
            },
        },
        "envelope": {
            "buy_zone_below_dma_pct": envelope.DEFAULT_BUY_ZONE_PCT,
            "opportunity_below_dma_pct": envelope.DEFAULT_OPPORTUNITY_PCT,
        },
        "week52": {
            "buy_zone_tolerance_pct": week52.DEFAULT_BUY_ZONE_TOL_PCT,
            "opportunity_above_low_pct": week52.DEFAULT_OPPORTUNITY_ABOVE_LOW_PCT,
        },
        "ath_fall_pct_by_cap": dict(ATH_FALL_RULE),
        "pointers": dict(POINTER_RULES),
    }


def best_technical_status(results: List[Dict[str, Any]]) -> Optional[str]:
    best: Optional[str] = None
    best_rank = 0
    for r in results:
        if r.get("strategy_id") not in TECHNICAL_STRATEGIES:
            continue
        st = r.get("status")
        rank = TECH_RANK.get(str(st), 0)
        if rank > best_rank:
            best, best_rank = st, rank
    return best


def funda_points(results: List[Dict[str, Any]]) -> Optional[int]:
    for r in results:
        if r.get("strategy_id") == FUNDAMENTAL_STRATEGY:
            ms = r.get("metrics_snapshot") or {}
            pts = ms.get("points")
            if pts is None:
                pts = r.get("score")
            try:
                return int(Decimal(str(pts)))
            except Exception:  # noqa: BLE001
                return None
    return None


def stock_entry(stock: Dict[str, Any], snap: Optional[Dict[str, Any]],
                results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """One compact per-stock record for the bootstrap payload."""
    symbol = stock["symbol"]
    snap = snap or {}
    # Same precedence as rows.ts: derived bucket first, manual override as fallback.
    cap = snap.get("cap_bucket") or stock.get("cap_type_manual")
    entry: Dict[str, Any] = {
        "symbol": symbol,
        "plain": plain_symbol(symbol),
        "tv": tv_symbol(symbol),
        "name": stock.get("name"),
        "sector": stock.get("sector"),
        "industry": stock.get("industry"),
        "sector_group": stock.get("sector_group"),
        "pools": list(stock.get("pools") or []),
        "cap": cap,
        "best_status": best_technical_status(results),
        "funda_points": funda_points(results),
    }
    for k in SNAPSHOT_KEYS:
        if k in snap:
            entry[k] = snap.get(k)
    return entry


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def register_extension_routes(app: Any, cli: Any) -> None:
    from fastapi import HTTPException, Query

    from plutus.adapters import supabase_client as sb

    def client() -> Any:
        return cli() or sb.get_client()

    def _strategy_config_rows() -> List[Dict[str, Any]]:
        try:
            res = (client().table("strategy_configs").select("*")
                   .order("priority").limit(100).execute())
            return list(getattr(res, "data", None) or [])
        except Exception as exc:  # noqa: BLE001 — table may be empty / absent locally
            logger.warning("strategy_configs unreadable: %s", exc)
            return []

    def _results_by_symbol(symbols: List[str]) -> Dict[str, List[Dict[str, Any]]]:
        out: Dict[str, List[Dict[str, Any]]] = {}
        if not symbols:
            return out
        # Chunk so the PostgREST `in` filter stays under URL limits.
        for i in range(0, len(symbols), 150):
            chunk = symbols[i:i + 150]
            for r in repo.latest_scan_results_for_symbols(chunk, client=client()):
                out.setdefault(str(r.get("symbol")), []).append(r)
        return out

    def _snapshots_by_symbol(symbols: List[str], date: Optional[str]) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        if not symbols or not date:
            return out
        for i in range(0, len(symbols), 150):
            chunk = symbols[i:i + 150]
            for s in repo.snapshots_for_symbols(chunk, snapshot_date=date, client=client()):
                out[str(s.get("symbol"))] = s
        return out

    @app.get("/api/strategy_configs")
    def get_strategy_configs() -> dict:
        """Thresholds the scan engine runs with (code defaults) plus any
        DB overrides. Read-only; the extension and web app render from this."""
        return to_wire({
            "defaults": default_thresholds(),
            "configs": _strategy_config_rows(),
        })

    @app.get("/api/extension/bootstrap")
    def extension_bootstrap(
        include_inactive: bool = Query(False),
    ) -> dict:
        """Everything the TradingView panel needs, in one call."""
        try:
            pools = repo.list_pools(client=client())
            stocks = repo.list_stocks(active_only=not include_inactive,
                                      limit=2000, client=client())
            symbols = [s["symbol"] for s in stocks if s.get("symbol")]
            date = repo.latest_snapshot_date(client=client())
            snaps = _snapshots_by_symbol(symbols, date)
            results = _results_by_symbol(symbols)
            entries = [stock_entry(s, snaps.get(s["symbol"]), results.get(s["symbol"], []))
                       for s in stocks]
            counts: Dict[str, int] = {}
            for s in stocks:
                for p in s.get("pools") or []:
                    counts[p] = counts.get(p, 0) + 1
        except Exception as exc:  # noqa: BLE001
            logger.exception("extension bootstrap failed")
            raise HTTPException(status_code=502, detail=str(exc))
        return to_wire({
            "version": BOOTSTRAP_VERSION,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "snapshot_date": date,
            "pools": [{"code": p.get("code"), "name": p.get("name"),
                       "display_order": p.get("display_order"),
                       "count": counts.get(p.get("code"), 0)} for p in pools],
            "stocks": entries,
            "thresholds": default_thresholds(),
            "strategy_configs": _strategy_config_rows(),
        })

    @app.get("/api/extension/stock/{symbol}")
    def extension_stock(symbol: str) -> dict:
        """Everything about one stock for the Screener / chart overlays."""
        from plutus.api.universe import canonical_symbol
        sym = canonical_symbol(symbol)
        if sym is None:
            raise HTTPException(status_code=400, detail=f"invalid symbol: {symbol}")
        try:
            stock = repo.get_stock(sym, client=client())
            date = repo.latest_snapshot_date(client=client())
            snaps = repo.snapshots_for_symbols([sym], snapshot_date=date, client=client()) if date else []
            snap = snaps[0] if snaps else None
            fund = repo.latest_fundamentals(sym, client=client())
            results = repo.latest_scan_results_for_symbols([sym], client=client())
        except Exception as exc:  # noqa: BLE001
            logger.exception("extension stock failed: %s", sym)
            raise HTTPException(status_code=502, detail=str(exc))
        if stock is None and snap is None and fund is None:
            raise HTTPException(status_code=404, detail=f"{sym} is not in Plutus")
        stock = stock or {"symbol": sym, "pools": []}
        return to_wire({
            "symbol": sym,
            "plain": plain_symbol(sym),
            "tv": tv_symbol(sym),
            "in_universe": bool(stock.get("id")),
            "snapshot_date": date,
            "stock": stock,
            "summary": stock_entry(stock, snap, results),
            "snapshot": snap,
            "fundamentals": fund,
            "scan_results": results,
            "thresholds": default_thresholds(),
        })
