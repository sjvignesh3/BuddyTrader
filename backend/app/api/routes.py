"""
API routes - REST endpoints for the scanner dashboard.
"""
from fastapi import APIRouter, Query
from typing import Optional, List

from ..services.scanner import run_scan, get_last_scan, get_pool_scan, get_all_cached_scans
from ..services.data_fetcher import clear_cache
from ..core.universe import get_all_pools_summary, get_pool_stocks
from ..core.config import load_strategy_rules

router = APIRouter()


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
    return {"message": "Cache cleared successfully"}
