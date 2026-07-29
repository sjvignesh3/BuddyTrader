"""
API routes - REST endpoints for the scanner dashboard.
"""
import logging
from datetime import datetime
from fastapi import APIRouter, Query, Body
from typing import Optional, List
from pydantic import BaseModel

from ..services.scanner import run_scan, get_last_scan, get_pool_scan, get_all_cached_scans
from ..services.data_fetcher import clear_cache
from ..services.screener_data_fetcher import (
    fetch_fundamental_data_batch, clear_fundamental_cache, get_auth_status,
)
from ..services.screener_engine import (
    get_default_rules, run_screener,
)
from ..core.universe import get_all_pools_summary, get_pool_stocks
from ..core.config import load_strategy_rules

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Pydantic models for screener API ────────────────────────────────────────
class ScreenerRequest(BaseModel):
    pool: str = "F40"
    symbols: Optional[List[str]] = None
    rules: Optional[List[dict]] = None  # User-configured rules with overrides


@router.get("/health")
async def health_check():
    return {"status": "ok", "service": "buddy-scanner"}


@router.post("/scan")
async def trigger_scan(
    pool: str = Query(default="F40", description="Stock pool to scan"),
    strategies: Optional[str] = Query(default=None, description="Comma-separated strategy IDs"),
    sample: bool = Query(default=False, description="Use sample data for testing"),
    symbols: Optional[str] = Query(default=None, description="Comma-separated symbols for PlayArea"),
):
    """Trigger a new scan for the specified pool."""
    strategy_list = strategies.split(",") if strategies else None
    custom_symbols = [s.strip() for s in symbols.split(",") if s.strip()] if symbols else None
    result = run_scan(pool_code=pool, strategy_ids=strategy_list, use_sample=sample,
                      custom_symbols=custom_symbols)
    return result


@router.get("/scan/last")
async def get_last_scan_results():
    result = get_last_scan()
    if result is None:
        return {"message": "No scan has been run yet."}
    return result


@router.get("/scan/{pool_code}")
async def get_cached_pool_scan(pool_code: str):
    """Get cached scan results for a specific pool (avoids re-scanning on tab switch)."""
    result = get_pool_scan(pool_code)
    if result is None:
        return {"message": f"No cached scan for {pool_code}. Run a scan first."}
    return result


@router.get("/scans/status")
async def get_scan_statuses():
    """Get scan timestamps for all cached pools."""
    return get_all_cached_scans()


@router.get("/pools")
async def get_pools():
    return get_all_pools_summary()


@router.get("/pools/{pool_code}/stocks")
async def get_pool_stock_list(pool_code: str):
    stocks = get_pool_stocks(pool_code)
    return {"pool": pool_code, "count": len(stocks), "stocks": stocks}


@router.get("/strategies")
async def get_strategies():
    rules = load_strategy_rules()
    return {
        "strategies": rules.get("strategies", []),
        "stock_pools": rules.get("stock_pools", {}),
    }


@router.post("/cache/clear")
async def clear_price_cache():
    clear_cache()
    clear_fundamental_cache()
    return {"message": "Cache cleared successfully (price + ATH + fundamentals)"}


# ═══════════════════════════════════════════════════════════════════════════
#  ADVANCED SCREENER ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/screener/auth-status")
async def get_screener_auth_status():
    """
    Return current screener.in authentication status.
    Informs the UI whether full data (quarterly results, ROCE, ROE, pledging)
    is available, or only public PE/PB history.
    """
    return get_auth_status()


@router.get("/screener/rules")
async def get_screener_rules():
    """Return the default screener rule definitions for the UI to render."""
    return {"rules": get_default_rules(), "auth_status": get_auth_status()}


@router.post("/screener/run")
async def run_advanced_screener(request: ScreenerRequest):
    """
    Run the advanced fundamental screener.

    Body:
        pool:    Stock pool code (F40, E40, S200, PlayArea)
        symbols: Optional list of custom symbols (for PlayArea)
        rules:   User-configured rules with enable/disable + param overrides
    """
    scan_start = datetime.now()

    # Resolve symbols
    if request.pool == "PlayArea" and request.symbols:
        custom_symbols = [s.strip().upper() for s in request.symbols if s.strip()]
        # Enrich with master CSV metadata
        universe_lookup = {s["symbol"]: s for s in get_pool_stocks("ALL")}
        pool_stocks = []
        for sym in custom_symbols:
            if sym in universe_lookup:
                meta = universe_lookup[sym].copy()
                meta["pool_code"] = "PlayArea"
            else:
                meta = {"symbol": sym, "sector": "", "pool_code": "PlayArea",
                        "pool_name": "Play Area", "cap_type": ""}
            pool_stocks.append(meta)
    else:
        pool_stocks = get_pool_stocks(request.pool)

    if not pool_stocks:
        return {"error": f"No stocks found for pool: {request.pool}",
                "scan_timestamp": scan_start.isoformat()}

    symbols = [s["symbol"] for s in pool_stocks]
    stock_info = {s["symbol"]: s for s in pool_stocks}

    # Use user-provided rules or defaults
    rules = request.rules if request.rules else get_default_rules()

    logger.info("Advanced Screener: %d stocks, %d rules, pool=%s", len(symbols), len(rules), request.pool)

    # Fetch fundamental data
    fundamental_data = fetch_fundamental_data_batch(symbols)

    # Run screener
    results = run_screener(symbols, rules, fundamental_data, stock_info)

    scan_end = datetime.now()
    scan_duration = (scan_end - scan_start).total_seconds()

    passed_count = len([r for r in results if r.get("all_passed")])
    total_with_data = len([r for r in results if not r.get("error")])

    return {
        "scan_timestamp": scan_start.isoformat(),
        "scan_duration_seconds": round(scan_duration, 2),
        "pool": request.pool,
        "total_stocks": len(symbols),
        "data_available": total_with_data,
        "passed_all": passed_count,
        "auth_status": get_auth_status(),
        "results": results,
    }
