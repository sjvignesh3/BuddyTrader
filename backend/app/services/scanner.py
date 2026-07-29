"""
Scanner service - the main orchestrator.
Fetches data, computes metrics, applies strategies, produces ranked results.
Supports per-pool caching so switching tabs doesn't re-scan.

ATH: Now fetches max historical data for true All-Time High calculation.
"""
import logging
from typing import Dict, List, Optional
from datetime import datetime

from ..core.config import load_strategy_rules
from ..core.universe import get_pool_stocks
from .data_fetcher import (
    fetch_multiple_stocks, load_sample_data,
    get_ath_for_symbols, get_meta_for_symbol,
    clear_cache as clear_data_cache,
)
from .metrics_engine import compute_metrics
from ..strategies.registry import get_strategy

logger = logging.getLogger(__name__)

# Store scan results per pool: pool_code -> scan_result
_scan_cache: Dict[str, Dict] = {}


def run_scan(pool_code: str = "F40", strategy_ids: Optional[List[str]] = None,
             use_sample: bool = False, custom_symbols: Optional[List[str]] = None) -> Dict:
    """
    Run a full scan for a given pool.

    Args:
        pool_code: Stock pool to scan (F40, E40, S200, PlayArea)
        strategy_ids: Optional list to override which strategies to run
        use_sample: If True, use sample data
        custom_symbols: For PlayArea - custom list of symbols to scan
    """
    global _scan_cache

    scan_start = datetime.now()
    logger.info(f"Starting scan for pool: {pool_code}")

    # Step 1: Load pool stocks
    if pool_code == "PlayArea" and custom_symbols:
        # Enrich PlayArea symbols with sector/cap_type from the master universe.
        # S200 (or any pool) symbols get their real metadata; unknown symbols fall back to empty strings.
        universe_lookup = {s["symbol"]: s for s in get_pool_stocks("ALL")}
        pool_stocks = []
        for sym in custom_symbols:
            sym = sym.strip().upper()
            if not sym:
                continue
            if sym in universe_lookup:
                meta = universe_lookup[sym].copy()  # preserves sector, cap_type
                meta["pool_code"] = "PlayArea"      # override pool identity
                meta["pool_name"] = "Play Area"
            else:
                meta = {
                    "symbol": sym,
                    "sector": "",
                    "pool_code": "PlayArea",
                    "pool_name": "Play Area",
                    "cap_type": "",
                }
            pool_stocks.append(meta)
    else:
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
            if strat.get("enabled", False):
                pools = strat.get("applies_to_pools", [])
                if pool_code in pools or pool_code == "PlayArea":
                    applicable.append(strat["id"])

    logger.info(f"Applicable strategies: {applicable}")

    # Step 4: Fetch price data (1y for metrics)
    logger.info("Fetching price data...")
    if use_sample:
        price_data = load_sample_data(symbols)
        data_source = "sample"
    else:
        price_data = fetch_multiple_stocks(symbols, period="1y")
        data_source = "live"

        if len(price_data) == 0:
            logger.warning("No live data available. Falling back to sample data.")
            price_data = load_sample_data(symbols)
            data_source = "sample_fallback"

    logger.info(f"Got price data for {len(price_data)}/{len(symbols)} stocks (source: {data_source})")

    # Step 4b: Fetch ATH from 5y daily data (max range returns monthly candles — wrong)
    logger.info("Fetching All-Time High data (5y daily)...")
    if use_sample or data_source == "sample_fallback":
        # Sample data already populates ATH cache
        ath_data = {}
        from .data_fetcher import _ath_cache
        for sym in symbols:
            if sym in _ath_cache:
                ath_data[sym] = _ath_cache[sym]
    else:
        ath_data = get_ath_for_symbols(symbols)

    logger.info(f"ATH data available for {len(ath_data)}/{len(symbols)} stocks")

    # Step 5 & 6: Compute metrics and apply strategies
    all_results = []
    errors = []

    for symbol in symbols:
        if symbol not in price_data:
            errors.append({"symbol": symbol, "error": "No price data available"})
            continue

        # Pass ATH override (5y daily) + Yahoo meta fields (52W high/low) to metrics engine
        ath_override = ath_data.get(symbol)
        meta_fields  = get_meta_for_symbol(symbol)

        # Pull rally config so compute_metrics uses the right thresholds
        rally_cfg    = strategies_config.get("rally_20_percent", {})
        rally_inputs = rally_cfg.get("inputs", {})
        rally_threshold    = rally_inputs.get("movement_threshold_pct", 20.0)
        rally_window_days  = rally_inputs.get("validity_window_days", 189)

        metrics = compute_metrics(
            symbol,
            price_data[symbol],
            ath_override=ath_override,
            meta_fields=meta_fields,
            rally_threshold=rally_threshold,
            rally_window_days=rally_window_days,
        )
        if metrics is None:
            errors.append({"symbol": symbol, "error": "Failed to compute metrics"})
            continue

        # ── Compute % to Next Buy: how far current price is ABOVE the re-entry low
        #    Positive = price is above the buy level (needs to pull back to re-enter)
        #    Negative = price is already BELOW the last rally low (deep value!)
        rally_low  = metrics.get("last_rally_low", 0.0)
        rally_high = metrics.get("last_rally_high", 0.0)
        curr_close = metrics["close"]
        if rally_low and rally_low > 0:
            pct_to_next_buy = round(((curr_close - rally_low) / rally_low) * 100, 2)
        else:
            pct_to_next_buy = None

        stock_result = {
            "symbol": symbol,
            "sector": stock_info[symbol].get("sector", ""),
            "pool": pool_code,
            "cap_type": stock_info[symbol].get("cap_type", ""),
            "close": curr_close,
            "dma_200": metrics["dma_200"],
            "below_200dma_pct": metrics["below_200dma_pct"],
            "high_52w": metrics["high_52w"],
            "low_52w": metrics["low_52w"],
            "distance_from_52w_high_pct": metrics["distance_from_52w_high_pct"],
            "distance_from_52w_low_pct": metrics["distance_from_52w_low_pct"],
            "ath": metrics["ath"],
            "down_from_ath_pct": metrics["down_from_ath_pct"],
            # ── 20% Rally fields (top-level for S200 / PlayArea column rendering) ──
            "has_valid_20pct_rally":         metrics.get("has_valid_20pct_rally", False),
            "last_rally_pct":                metrics.get("last_rally_pct", 0.0),
            "last_rally_low":                rally_low,
            "last_rally_high":               rally_high,
            "last_rally_start_date":         metrics.get("last_rally_start_date"),
            "last_rally_end_date":           metrics.get("last_rally_end_date"),
            "days_since_last_rally":         metrics.get("days_since_last_rally"),
            "total_valid_rallies_in_window": metrics.get("total_valid_rallies_in_window", 0),
            "pct_to_next_buy":               pct_to_next_buy,
            # ──────────────────────────────────────────────────────────────────────
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

    # Step 7: Sort results
    # S200 / PlayArea → sort by days_since_last_rally ascending (most recent rally first),
    #                   then stocks with no rally pushed to the bottom.
    # All other pools → sort by best_score descending (existing behaviour).
    if pool_code in ("S200", "PlayArea"):
        all_results.sort(
            key=lambda x: (
                x["days_since_last_rally"] is None,   # None → sink to bottom
                x["days_since_last_rally"] or 9999,   # ascending: freshest rally first
            )
        )
    else:
        all_results.sort(key=lambda x: x["best_score"], reverse=True)

    scan_end = datetime.now()
    scan_duration = (scan_end - scan_start).total_seconds()

    buy_zone_count = len([r for r in all_results if r["best_status"] == "BUY_ZONE"])
    opportunity_count = len([r for r in all_results if r["best_status"] == "OPPORTUNITY"])
    no_signal_count = len([r for r in all_results if r["best_status"] == "NO_SIGNAL"])

    scan_result = {
        "scan_timestamp": scan_start.isoformat(),
        "scan_duration_seconds": round(scan_duration, 2),
        "pool": pool_code,
        "data_source": data_source,
        "strategies_applied": applicable,
        "total_stocks_scanned": len(symbols),
        "data_available_for": len(price_data),
        "buy_zone_count": buy_zone_count,
        "opportunity_count": opportunity_count,
        "no_signal_count": no_signal_count,
        "error_count": len(errors),
        "results": all_results,
        "errors": errors,
    }

    # Cache per pool
    _scan_cache[pool_code] = scan_result

    logger.info(
        f"Scan complete: {buy_zone_count} BUY_ZONE, {opportunity_count} OPPORTUNITY, "
        f"{no_signal_count} No Signal in {scan_duration:.1f}s [source: {data_source}]"
    )

    return scan_result


def get_pool_scan(pool_code: str) -> Optional[Dict]:
    """Get cached scan results for a specific pool."""
    return _scan_cache.get(pool_code)


def get_all_cached_scans() -> Dict:
    """Get scan timestamps for all cached pools."""
    return {
        pool: {
            "scan_timestamp": data.get("scan_timestamp"),
            "total_stocks_scanned": data.get("total_stocks_scanned", 0),
            "buy_zone_count": data.get("buy_zone_count", 0),
            "opportunity_count": data.get("opportunity_count", 0),
        }
        for pool, data in _scan_cache.items()
    }


def get_last_scan() -> Optional[Dict]:
    """Get the most recent scan results (any pool)."""
    if not _scan_cache:
        return None
    latest = max(_scan_cache.values(), key=lambda x: x.get("scan_timestamp", ""))
    return latest
