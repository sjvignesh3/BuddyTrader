# -*- coding: utf-8 -*-
"""
API routes - REST endpoints for the scanner dashboard.
"""
import logging
import json
import asyncio
import queue as _queue
import threading as _threading
from datetime import datetime
from fastapi import APIRouter, Query, Body
from fastapi.responses import StreamingResponse
from typing import Optional, List
from pydantic import BaseModel

from ..services.scanner import run_scan, get_last_scan, get_pool_scan, get_all_cached_scans
from ..services.data_fetcher import clear_cache
from ..services.screener_data_fetcher import (
    fetch_fundamental_data_batch, clear_fundamental_cache, get_auth_status,
    get_persistent_cache_info, pcache_is_valid as _pcache_is_valid,
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
    rules: Optional[List[dict]] = None       # User-configured rules with overrides
    force_refresh: bool = False              # When True, bypass persistent cache for these symbols


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

@router.get("/screener/fundamentals-from-cache")
async def get_fundamentals_from_cache(
    symbols: str = Query(description="Comma-separated list of NSE symbols"),
):
    """
    Look up fundamental data for the given symbols ONLY from the persistent
    screener cache (UserData/screener_cache.json). Makes NO internet calls.

    Returns per-symbol:
      - found:      True if the symbol exists in the cache
      - data:       Fundamental data (ratios, shareholding, quarterly, valuation)
      - points:     How many of the 11 fundamental checks pass (int or None)
      - points_max: Always 11
      - checks:     Array of {label, passed, detail} for each of the 11 criteria

    The 11 fundamental checks (derived from UserData/Fundamental Pointers.md):
      1.  PE < 70
      2.  PE < 5yr Median PE
      3.  PB < 5yr Historical Avg PB
      4.  Net Debt to Equity < 0.25
      5.  ROCE > 15%
      6.  ROE > 15%  (or bank equivalent)
      7.  Sales at ATH (TTM Sales >= 90% of historical peak quarterly sales)
      8.  Net Profit at ATH (TTM Net Profit >= 90% of historical peak)
      9.  Profit Before Tax at ATH (latest Q PBT >= 90% of peak quarterly PBT)
      10. Pledged % < 5%
      11. OPM stable/positive (latest net profit margin >= historical average)
    """
    from ..services.screener_data_fetcher import pcache_get, pcache_is_valid

    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not symbol_list:
        return {"results": {}}

    results = {}
    for sym in symbol_list:
        if not pcache_is_valid(sym):
            results[sym] = {
                "found": False,
                "data": None,
                "points": None,
                "points_max": 11,
                "checks": [],
            }
            continue

        fdata = pcache_get(sym)
        if not fdata:
            results[sym] = {
                "found": False,
                "data": None,
                "points": None,
                "points_max": 11,
                "checks": [],
            }
            continue

        ratios = fdata.get("ratios", {})
        shareholding = fdata.get("shareholding", {})
        quarterly = fdata.get("quarterly_results", [])
        valuation = fdata.get("valuation", {})

        current_pe   = ratios.get("current_pe")
        current_pb   = ratios.get("current_pb")
        pe_5yr_avg   = ratios.get("pe_5yr_avg_page") or valuation.get("pe_avg_5yr")
        pb_5yr_avg   = ratios.get("pb_5yr_avg_page") or valuation.get("pb_avg_5yr")
        net_debt_eq  = ratios.get("net_debt_to_equity")
        roce         = ratios.get("roce")
        roe          = ratios.get("roe")
        pledging     = shareholding.get("promoter_pledging_pct")

        # Compute quarterly Sales ATH, Net Profit ATH, and PBT ATH
        q_sales   = [q.get("sales")      for q in quarterly if q.get("sales")      is not None]
        q_profits = [q.get("net_profit") for q in quarterly if q.get("net_profit") is not None]
        q_pbts    = [q.get("pbt")        for q in quarterly if q.get("pbt")        is not None]
        latest_sales  = q_sales[-1]   if q_sales   else None
        latest_profit = q_profits[-1] if q_profits else None
        latest_pbt    = q_pbts[-1]    if q_pbts    else None
        ath_sales     = max(q_sales)   if q_sales   else None
        ath_profit    = max(q_profits) if q_profits else None
        ath_pbt       = max(q_pbts)    if q_pbts    else None

        # Compute OPM proxy: ratio of net_profit / sales for each quarter
        opm_values = []
        for q in quarterly:
            s, p = q.get("sales"), q.get("net_profit")
            if s and s > 0 and p is not None:
                opm_values.append(p / s * 100)
        latest_opm = opm_values[-1] if opm_values else None
        avg_opm    = (sum(opm_values) / len(opm_values)) if len(opm_values) > 1 else None

        checks = []

        # ── Check 1: PE < 70 ─────────────────────────────────────────────
        if current_pe is None:
            checks.append({"id": "pe_lt_70", "label": "PE < 70",
                           "passed": None, "detail": "PE not available"})
        else:
            p = current_pe < 70
            checks.append({"id": "pe_lt_70", "label": "PE < 70",
                           "passed": p,
                           "detail": f"PE = {current_pe:.1f} ({'✓' if p else '✗'} < 70)"})

        # ── Check 2: PE < 5yr Median PE ──────────────────────────────────
        if current_pe is None or pe_5yr_avg is None:
            checks.append({"id": "pe_lt_5yr", "label": "PE < 5yr Avg PE",
                           "passed": None,
                           "detail": "PE or 5yr avg PE not available"})
        else:
            p = current_pe < pe_5yr_avg
            checks.append({"id": "pe_lt_5yr", "label": "PE < 5yr Avg PE",
                           "passed": p,
                           "detail": f"PE {current_pe:.1f} vs 5yr avg {pe_5yr_avg:.1f}"})

        # ── Check 3: PB < 5yr Historical Avg PB ──────────────────────────
        if current_pb is None or pb_5yr_avg is None:
            checks.append({"id": "pb_lt_5yr", "label": "PB < 5yr Avg PB",
                           "passed": None,
                           "detail": "PB or 5yr avg PB not available"})
        else:
            p = current_pb < pb_5yr_avg
            checks.append({"id": "pb_lt_5yr", "label": "PB < 5yr Avg PB",
                           "passed": p,
                           "detail": f"PB {current_pb:.2f} vs 5yr avg {pb_5yr_avg:.2f}"})
        # ── Check 4: Net Debt/Equity < 0.25 ──────────────────────────────
        if net_debt_eq is None:
            checks.append({"id": "net_debt", "label": "Net Debt/Eq < 0.25",
                           "passed": None, "detail": "Net Debt to Equity not available"})
        else:
            p = net_debt_eq < 0.25
            checks.append({"id": "net_debt", "label": "Net Debt/Eq < 0.25",
                           "passed": p,
                           "detail": f"Net Debt/Eq = {net_debt_eq:.2f} ({'✓' if p else '✗'} < 0.25)"})

        # ── Check 5: ROCE > 15% ───────────────────────────────────────────
        if roce is None:
            checks.append({"id": "roce", "label": "ROCE > 15%",
                           "passed": None, "detail": "ROCE not available"})
        else:
            p = roce > 15
            checks.append({"id": "roce", "label": "ROCE > 15%",
                           "passed": p,
                           "detail": f"ROCE = {roce:.1f}% ({'✓' if p else '✗'} > 15%)"})

        # ── Check 6: ROE > 15% ────────────────────────────────────────────
        if roe is None:
            checks.append({"id": "roe", "label": "ROE > 15%",
                           "passed": None, "detail": "ROE not available"})
        else:
            p = roe > 15
            checks.append({"id": "roe", "label": "ROE > 15%",
                           "passed": p,
                           "detail": f"ROE = {roe:.1f}% ({'✓' if p else '✗'} > 15%)"})

        # ── Check 7: Sales at ATH (latest Q >= 90% of peak quarterly) ────
        if latest_sales is None or ath_sales is None:
            checks.append({"id": "sales_ath", "label": "Sales near ATH (≥90%)",
                           "passed": None, "detail": "Sales data not available"})
        else:
            threshold = ath_sales * 0.90
            p = latest_sales >= threshold
            checks.append({"id": "sales_ath", "label": "Sales near ATH (≥90%)",
                           "passed": p,
                           "detail": f"Latest Q Sales {latest_sales:.0f} vs ATH {ath_sales:.0f} (threshold {threshold:.0f})"})

        # ── Check 8: Net Profit at ATH (latest Q >= 90% of peak quarterly)
        if latest_profit is None or ath_profit is None:
            checks.append({"id": "profit_ath", "label": "Net Profit near ATH (≥90%)",
                           "passed": None, "detail": "Net Profit data not available"})
        else:
            threshold = ath_profit * 0.90
            p = latest_profit >= threshold
            checks.append({"id": "profit_ath", "label": "Net Profit near ATH (≥90%)",
                           "passed": p,
                           "detail": f"Latest Q Profit {latest_profit:.0f} vs ATH {ath_profit:.0f} (threshold {threshold:.0f})"})

        # ── Check 9: Profit Before Tax at ATH (latest Q >= 90% of peak) ──
        if latest_pbt is None or ath_pbt is None:
            checks.append({"id": "pbt_ath", "label": "PBT near ATH (≥90%)",
                           "passed": None, "detail": "Profit Before Tax data not available"})
        else:
            threshold = ath_pbt * 0.90
            p = latest_pbt >= threshold
            checks.append({"id": "pbt_ath", "label": "PBT near ATH (≥90%)",
                           "passed": p,
                           "detail": f"Latest Q PBT {latest_pbt:.0f} vs ATH {ath_pbt:.0f} (threshold {threshold:.0f})"})

        # ── Check 10: Pledging < 5% ───────────────────────────────────────
        if pledging is None:
            checks.append({"id": "pledging", "label": "Pledging < 5%",
                           "passed": None, "detail": "Pledging data not available"})
        else:
            p = pledging < 5
            checks.append({"id": "pledging", "label": "Pledging < 5%",
                           "passed": p,
                           "detail": f"Pledging = {pledging:.1f}% ({'✓' if p else '✗'} < 5%)"})

        # ── Check 11: OPM stable / positive ──────────────────────────────
        if latest_opm is None:
            checks.append({"id": "opm", "label": "OPM Stable/Positive",
                           "passed": None, "detail": "OPM data not available"})
        else:
            if avg_opm is not None:
                p = latest_opm >= avg_opm * 0.90
                checks.append({"id": "opm", "label": "OPM Stable/Positive",
                               "passed": p,
                               "detail": f"Latest OPM {latest_opm:.1f}% vs avg {avg_opm:.1f}%"})
            else:
                p = latest_opm > 0
                checks.append({"id": "opm", "label": "OPM Stable/Positive",
                               "passed": p,
                               "detail": f"OPM = {latest_opm:.1f}%"})

        # Count only definite passes (passed=True), ignore None
        points = sum(1 for c in checks if c["passed"] is True)

        results[sym] = {
            "found": True,
            "data": {
                "current_pe":         current_pe,
                "pe_5yr_avg":         pe_5yr_avg,
                "current_pb":         current_pb,
                "pb_5yr_avg":         pb_5yr_avg,
                "roce":               roce,
                "roe":                roe,
                "net_debt_to_equity": net_debt_eq,
                "pledging":           pledging,
                "promoter_holding":   shareholding.get("promoter_holding_pct"),
                "latest_sales":       latest_sales,
                "latest_profit":      latest_profit,
                "latest_pbt":         latest_pbt,
                "ath_sales":          ath_sales,
                "ath_profit":         ath_profit,
                "ath_pbt":            ath_pbt,
                "latest_opm":         round(latest_opm, 2) if latest_opm is not None else None,
                "avg_opm":            round(avg_opm, 2) if avg_opm is not None else None,
                "auth_available":     fdata.get("auth_available", False),
            },
            "points": points,
            "points_max": 11,
            "checks": checks,
        }

    return {"results": results}


@router.get("/screener/cache-info")
async def get_screener_cache_info():
    """
    Return the current state of the persistent fundamental cache.
    Shows every cached symbol and when it was last fetched.
    Entries have NO TTL — they remain valid until force_refresh=True is used.
    Safe to call at any time — read-only, no side effects.
    """
    return get_persistent_cache_info()


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
    Run the advanced fundamental screener (non-streaming POST).

    Body:
        pool:    Stock pool code (F40, E40, S200, PlayArea)
        symbols: Optional list of custom symbols (for PlayArea)
        rules:   User-configured rules with enable/disable + param overrides
    """
    scan_start = datetime.now()

    # Resolve symbols
    if request.pool == "PlayArea" and request.symbols:
        custom_symbols = [s.strip().upper() for s in request.symbols if s.strip()]
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

    rules = request.rules if request.rules else get_default_rules()
    force_refresh = request.force_refresh
    logger.info(
        "Advanced Screener (POST): %d stocks, %d rules, pool=%s, force_refresh=%s",
        len(symbols), len(rules), request.pool, force_refresh,
    )

    fundamental_data = fetch_fundamental_data_batch(symbols, force_refresh=force_refresh)

    if force_refresh:
        cache_hits = 0
        live_fetches = len([s for s in symbols if s in fundamental_data])
    else:
        cache_hits = sum(1 for s in symbols if s in fundamental_data and _pcache_is_valid(s))
        live_fetches = len([s for s in symbols if s in fundamental_data]) - cache_hits

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
        "force_refresh": force_refresh,
        "cache_hits": cache_hits,
        "live_fetches": live_fetches,
        "auth_status": get_auth_status(),
        "results": results,
    }


@router.post("/screener/run-stream")
async def run_advanced_screener_stream(request: ScreenerRequest):
    """
    SSE streaming version of the screener.

    Sends Server-Sent Events for every step:
      • manifest     — full plan (cache hits vs internet fetches, ETA)
      • progress     — per-symbol status (cache_hit | fetching | fetched)
      • throttle_tick — countdown ticks between internet fetches
      • complete     — final results payload

    The client consumes this via fetch() + ReadableStream to show a live
    progress panel with countdown timer during throttled fetches.
    """
    scan_start = datetime.now()

    # ── Resolve symbols ────────────────────────────────────────────────────
    if request.pool == "PlayArea" and request.symbols:
        custom_symbols = [s.strip().upper() for s in request.symbols if s.strip()]
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
        async def _error_gen():
            payload = json.dumps({"type": "error", "message": f"No stocks found for pool: {request.pool}"})
            yield f"data: {payload}\n\n"
        return StreamingResponse(_error_gen(), media_type="text/event-stream")

    symbols = [s["symbol"] for s in pool_stocks]
    stock_info = {s["symbol"]: s for s in pool_stocks}
    rules = request.rules if request.rules else get_default_rules()
    force_refresh = request.force_refresh

    logger.info(
        "Advanced Screener (SSE): %d stocks, %d rules, pool=%s, force_refresh=%s",
        len(symbols), len(rules), request.pool, force_refresh,
    )

    # ── SSE event queue — bridge between sync fetcher thread and async gen ─
    event_queue = _queue.Queue()  # Queue[Optional[dict]]

    def _progress_callback(event: dict) -> None:
        """Called from the sync fetcher thread; pushes into the async queue."""
        event_queue.put(event)

    # Collected fundamental data (filled by worker thread)
    _result_holder: dict = {}

    def _worker():
        """Run the blocking fetch + screener in a background thread."""
        try:
            fd = fetch_fundamental_data_batch(
                symbols,
                force_refresh=force_refresh,
                throttle_delay=20,
                progress_callback=_progress_callback,
            )
            _result_holder["fundamental_data"] = fd
        except Exception as e:
            logger.error("SSE screener worker error: %s", e)
            event_queue.put({"type": "error", "message": str(e)})
        finally:
            event_queue.put(None)  # sentinel — generator stops

    worker_thread = _threading.Thread(target=_worker, daemon=True, name="screener-sse-worker")
    worker_thread.start()

    async def _event_generator():
        """Async generator that yields SSE lines from the queue."""
        fundamental_data: dict = {}

        # Drain the queue until the sentinel (None) arrives
        while True:
            # Poll the queue without blocking the event loop
            try:
                event = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: event_queue.get(timeout=60)
                )
            except Exception:
                break

            if event is None:
                # Worker is done — run the screener engine and emit results
                fundamental_data = _result_holder.get("fundamental_data", {})
                results = run_screener(symbols, rules, fundamental_data, stock_info)
                scan_end = datetime.now()
                scan_duration = (scan_end - scan_start).total_seconds()

                passed_count = len([r for r in results if r.get("all_passed")])
                total_with_data = len([r for r in results if not r.get("error")])

                cache_hits = sum(1 for s in symbols if s in fundamental_data and _pcache_is_valid(s))
                live_fetches = len([s for s in symbols if s in fundamental_data]) - cache_hits

                complete_payload = {
                    "type": "complete",
                    "scan_timestamp": scan_start.isoformat(),
                    "scan_duration_seconds": round(scan_duration, 2),
                    "pool": request.pool,
                    "total_stocks": len(symbols),
                    "data_available": total_with_data,
                    "passed_all": passed_count,
                    "force_refresh": force_refresh,
                    "cache_hits": cache_hits,
                    "live_fetches": live_fetches,
                    "auth_status": get_auth_status(),
                    "results": results,
                }
                yield f"data: {json.dumps(complete_payload)}\n\n"
                break

            # Forward all other events to the client
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        },
    )
