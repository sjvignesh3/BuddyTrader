"""
Scanner service - the main orchestrator.
Fetches data, computes metrics, applies strategies, produces ranked results.
"""
import logging
from typing import Dict, List, Optional
from datetime import datetime

from ..core.config import load_strategy_rules
from ..core.universe import get_pool_stocks, get_all_pools_summary
from .data_fetcher import fetch_multiple_stocks, load_sample_data, clear_cache
from .metrics_engine import compute_metrics
from ..strategies.registry import get_strategy

logger = logging.getLogger(__name__)

# Store last scan results in memory
_last_scan: Optional[Dict] = None


def run_scan(pool_code: str = "F40", strategy_ids: Optional[List[str]] = None,
             use_sample: bool = False) -> Dict:
    """
    Run a full scan for a given pool.

    Args:
        pool_code: Stock pool to scan (F40, E40, S200)
        strategy_ids: Optional list to override which strategies to run
        use_sample: If True, use sample data (for testing when live data unavailable)
    """
    global _last_scan

    scan_start = datetime.now()
    logger.info(f"Starting scan for pool: {pool_code}")

    # Step 1: Load pool stocks
    pool_stocks = get_pool_stocks(pool_code)
    if not pool_stocks:
        return {
            "error": f"No stocks found for pool: {pool_code}",
            "scan_timestamp": scan_start.isoformat(),
        }

    symbols = [s["symbol"] for s in pool_stocks]
    stock_info = {s["symbol"]: s for s in pool_stocks}
    logger.info(f"Found {len(symbols)} stocks in {pool_code}")

    # Step 2: Load strategy config
    rules = load_strategy_rules()
    strategies_config = {s["id"]: s for s in rules.get("strategies", [])}

    # Step 3: Determine applicable strategies
    if strategy_ids:
        applicable = strategy_ids
    else:
        applicable = []
        for strat in rules.get("strategies", []):
            if pool_code in strat.get("applies_to_pools", []) and strat.get("enabled", False):
                applicable.append(strat["id"])

    logger.info(f"Applicable strategies: {applicable}")

    # Step 4: Fetch price data
    logger.info("Fetching price data...")
    if use_sample:
        price_data = load_sample_data(symbols)
        data_source = "sample"
    else:
        price_data = fetch_multiple_stocks(symbols, period="1y")
        data_source = "live"

        # Auto-fallback to sample data if live data is completely unavailable
        if len(price_data) == 0:
            logger.warning("No live data available. Falling back to sample data for demonstration.")
            price_data = load_sample_data(symbols)
            data_source = "sample_fallback"

    logger.info(f"Got price data for {len(price_data)}/{len(symbols)} stocks (source: {data_source})")

    # Step 5 & 6: Compute metrics and apply strategies
    all_results = []
    errors = []

    for symbol in symbols:
        if symbol not in price_data:
            errors.append({"symbol": symbol, "error": "No price data available"})
            continue

        # Compute metrics
        metrics = compute_metrics(symbol, price_data[symbol])
        if metrics is None:
            errors.append({"symbol": symbol, "error": "Failed to compute metrics"})
            continue

        # Apply each applicable strategy
        stock_result = {
            "symbol": symbol,
            "sector": stock_info[symbol].get("sector", ""),
            "pool": pool_code,
            "cap_type": stock_info[symbol].get("cap_type", ""),
            "close": metrics["close"],
            "dma_200": metrics["dma_200"],
            "below_200dma_pct": metrics["below_200dma_pct"],
            "high_52w": metrics["high_52w"],
            "low_52w": metrics["low_52w"],
            "distance_from_52w_high_pct": metrics["distance_from_52w_high_pct"],
            "distance_from_52w_low_pct": metrics["distance_from_52w_low_pct"],
            "strategy_results": [],
            "best_status": "NO_SIGNAL",
            "best_score": 0,
            "all_reasons": [],
        }

        for strat_id in applicable:
            try:
                strategy = get_strategy(strat_id)
                config = strategies_config.get(strat_id, {})
                result = strategy.evaluate(metrics, config)
                stock_result["strategy_results"].append(result)

                if result["score"] > stock_result["best_score"]:
                    stock_result["best_score"] = result["score"]
                    stock_result["best_status"] = result["status"]

                if result["status"] != "NO_SIGNAL":
                    stock_result["all_reasons"].extend(result["reasons"])

            except Exception as e:
                logger.error(f"Strategy {strat_id} error for {symbol}: {e}")

        all_results.append(stock_result)

    # Step 7: Rank results
    opportunities = [r for r in all_results if r["best_score"] > 0]
    opportunities.sort(key=lambda x: x["best_score"], reverse=True)

    no_signal = [r for r in all_results if r["best_score"] == 0]

    scan_end = datetime.now()
    scan_duration = (scan_end - scan_start).total_seconds()

    scan_result = {
        "scan_timestamp": scan_start.isoformat(),
        "scan_duration_seconds": round(scan_duration, 2),
        "pool": pool_code,
        "data_source": data_source,
        "strategies_applied": applicable,
        "total_stocks_scanned": len(symbols),
        "data_available_for": len(price_data),
        "opportunities_count": len(opportunities),
        "buy_zone_count": len([r for r in opportunities if r["best_status"] == "BUY_ZONE"]),
        "opportunity_count": len([r for r in opportunities if r["best_status"] == "OPPORTUNITY"]),
        "no_signal_count": len(no_signal),
        "error_count": len(errors),
        "opportunities": opportunities,
        "no_signal": no_signal,
        "errors": errors,
    }

    _last_scan = scan_result
    logger.info(
        f"Scan complete: {len(opportunities)} opportunities "
        f"({scan_result['buy_zone_count']} BUY_ZONE, {scan_result['opportunity_count']} OPPORTUNITY) "
        f"in {scan_duration:.1f}s [source: {data_source}]"
    )

    return scan_result


def get_last_scan() -> Optional[Dict]:
    """Get the most recent scan results."""
    return _last_scan
