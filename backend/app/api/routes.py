"""
API routes - REST endpoints for the scanner dashboard.
"""
from fastapi import APIRouter, Query
from typing import Optional, List

from ..services.scanner import run_scan, get_last_scan
from ..services.data_fetcher import clear_cache
from ..core.universe import get_all_pools_summary, get_pool_stocks
from ..core.config import load_strategy_rules

router = APIRouter()


@router.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "service": "buddy-scanner"}


@router.post("/scan")
async def trigger_scan(
    pool: str = Query(default="F40", description="Stock pool to scan"),
    strategies: Optional[str] = Query(default=None, description="Comma-separated strategy IDs to run"),
    sample: bool = Query(default=False, description="Use sample data for testing"),
):
    """
    Trigger a new scan for the specified pool.
    This fetches live data and evaluates all applicable strategies.
    If live data is unavailable, falls back to sample data automatically.
    """
    strategy_list = strategies.split(",") if strategies else None
    result = run_scan(pool_code=pool, strategy_ids=strategy_list, use_sample=sample)
    return result


@router.get("/scan/last")
async def get_last_scan_results():
    """Get the results of the most recent scan."""
    result = get_last_scan()
    if result is None:
        return {"message": "No scan has been run yet. Trigger a scan first."}
    return result


@router.get("/pools")
async def get_pools():
    """Get summary of all stock pools."""
    return get_all_pools_summary()


@router.get("/pools/{pool_code}/stocks")
async def get_pool_stock_list(pool_code: str):
    """Get all stocks in a specific pool."""
    stocks = get_pool_stocks(pool_code)
    return {
        "pool": pool_code,
        "count": len(stocks),
        "stocks": stocks
    }


@router.get("/strategies")
async def get_strategies():
    """Get all strategy configurations."""
    rules = load_strategy_rules()
    return {
        "strategies": rules.get("strategies", []),
        "stock_pools": rules.get("stock_pools", {}),
    }


@router.post("/cache/clear")
async def clear_price_cache():
    """Clear the price data cache to force fresh downloads."""
    clear_cache()
    return {"message": "Cache cleared successfully"}
