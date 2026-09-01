"""
Snapshot orchestrator.

`compute_snapshot(...)` is the ONE function the Stage-4 daily sync worker calls.
It takes raw yfinance outputs plus normalised OHLCV, runs every metric module,
and returns a dict shaped to the `daily_snapshots` registry columns.

Contract:
    - Never raises. Bad inputs produce partial rows with None values and
      an `errors: list[str]` field describing what was skipped.
    - Every output key is a registered `daily_snapshots` field name.
    - No I/O, no network, no logging side-effects.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence

from plutus.adapters.validators import (
    sanity_check_count,
    sanity_check_price,
)
from plutus.metrics.ath import compute_ath, gap_from_ath_pct
from plutus.metrics.cap_bucket import classify_market_cap
from plutus.metrics.dma import compute_below_dma_pct, compute_dma
from plutus.metrics.rally import OHLCVBar, compute_rally_metrics
from plutus.metrics.week52 import (
    compute_52w_high,
    compute_52w_low,
    distance_from_52w_high_pct,
    distance_from_52w_low_pct,
)
from plutus.registry.types import round_half_up, to_decimal


@dataclass
class SnapshotInputs:
    """Everything the pipeline needs. Kept as a dataclass so Stage 4 sync
    worker builds it once from Result[dict] payloads."""
    symbol: str
    snapshot_date: date
    bars: Sequence[OHLCVBar]                # sorted oldest → newest
    info: Dict[str, Any]                    # yfinance .info payload
    meta: Dict[str, Any] = field(default_factory=dict)
    trend_days: int = 7                     # look-back for price_change_nd_pct
    # Latest Screener.in valuation ratios (weekly sync — see
    # sync/weekly_ratios.py). Keys: pe, pb, market_cap (ABSOLUTE ₹),
    # all Decimal. None/{} => valuation fields stay NULL with an error note.
    screener_ratios: Optional[Dict[str, Any]] = None


def _safe(callable_, *args, errors: List[str], label: str, **kwargs):
    """Run `callable_`; on any exception append to errors and return None."""
    try:
        return callable_(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"{label}: {type(exc).__name__}: {exc}")
        return None


def compute_snapshot(inp: SnapshotInputs) -> Dict[str, Any]:
    """
    Build a `daily_snapshots` row from raw inputs.

    Returns a dict with:
        - 'symbol', 'snapshot_date'
        - OHLCV of the latest bar
        - Every derived metric (DMA / 52W / ATH / rally / market cap / PE/PB)
        - 'errors': list[str] — empty on a clean run
    """
    errors: List[str] = []
    bars = list(inp.bars) if inp.bars else []

    row: Dict[str, Any] = {
        "symbol": inp.symbol,
        "snapshot_date": inp.snapshot_date,
        # OHLCV — filled below if we have bars
        "open": None, "high": None, "low": None, "close": None,
        "adj_close": None, "volume": None,
        # Valuation (Screener.in, weekly) + derived
        "market_cap": None, "cap_bucket": None,
        "pe_current": None, "pb_current": None,
        "revenue_ttm": None, "profit_margin_pct": None,
        "price_change_nd_pct": None,
        "dma_200": None, "below_200dma_pct": None,
        "high_52w": None, "low_52w": None,
        "distance_from_52w_high_pct": None, "distance_from_52w_low_pct": None,
        "ath": None, "fall_from_ath_pct": None,
        # Rally block (registry-defined subset — total_valid_rallies_in_window
        # is a debug-only stat, kept inside RallyResult but not persisted)
        "has_valid_20pct_rally": False,
        "last_rally_pct": None, "last_rally_low": None, "last_rally_high": None,
        "last_rally_start_date": None, "last_rally_end_date": None,
        "days_since_last_rally": None,
        # Book-keeping
        "errors": errors,
    }

    if not bars:
        errors.append("no OHLCV bars supplied")
        return row

    # As-of correctness: never look at bars newer than the snapshot date, so
    # a backfill run (--as-of) reproduces that session instead of today's.
    bars = [b for b in bars if b.d <= inp.snapshot_date]
    if not bars:
        errors.append(f"no OHLCV bars on or before {inp.snapshot_date}")
        return row

    latest = bars[-1]
    row["open"] = _safe(sanity_check_price, latest.open,
                        errors=errors, label="open", field="open")
    row["high"] = _safe(sanity_check_price, latest.high,
                        errors=errors, label="high", field="high")
    row["low"] = _safe(sanity_check_price, latest.low,
                       errors=errors, label="low", field="low")
    row["close"] = _safe(sanity_check_price, latest.close,
                         errors=errors, label="close", field="close")

    # The session bar is the single source of truth for `close` so the whole
    # row is internally consistent. The live quote (regularMarketPrice) is
    # only a FALLBACK when the bar itself is unusable.
    if row["close"] is None:
        meta_close = inp.meta.get("regularMarketPrice") if inp.meta else None
        if meta_close:
            try:
                row["close"] = sanity_check_price(meta_close, field="close")
            except ValueError as exc:
                errors.append(f"meta.regularMarketPrice invalid: {exc}")

    # Adjusted close of the session bar (== close when no adjustment data).
    adj_latest = latest.adj_close if latest.adj_close is not None else latest.close
    row["adj_close"] = _safe(sanity_check_price, adj_latest,
                             errors=errors, label="adj_close", field="adj_close")

    # Volume: the session bar's traded volume; .info["volume"] (an intraday
    # figure) only as fallback.
    vol = latest.volume
    if vol is None and inp.info:
        vol = inp.info.get("volume")
    row["volume"] = _safe(sanity_check_count, vol,
                          errors=errors, label="volume", field="volume")

    # ----- DMA (on ADJUSTED closes — matches TradingView across splits) -----
    closes = [b.close for b in bars]
    adj_series = [b.adj_close if b.adj_close is not None else b.close for b in bars]
    if len(bars) >= 200:
        dma = _safe(compute_dma, adj_series, errors=errors, label="dma_200", window=200)
    else:
        dma = None
        errors.append(f"dma_200: insufficient history ({len(bars)} < 200 bars)")
    row["dma_200"] = dma
    row["below_200dma_pct"] = _safe(
        compute_below_dma_pct, row["close"], dma,
        errors=errors, label="below_200dma_pct",
    )

    # ----- 52 week -----
    highs = [b.high for b in bars]
    lows = [b.low for b in bars]
    row["high_52w"] = _safe(compute_52w_high, highs, meta=inp.meta,
                            errors=errors, label="high_52w")
    row["low_52w"] = _safe(compute_52w_low, lows, meta=inp.meta,
                           errors=errors, label="low_52w")
    row["distance_from_52w_high_pct"] = _safe(
        distance_from_52w_high_pct, row["close"], row["high_52w"],
        errors=errors, label="distance_from_52w_high_pct",
    )
    row["distance_from_52w_low_pct"] = _safe(
        distance_from_52w_low_pct, row["close"], row["low_52w"],
        errors=errors, label="distance_from_52w_low_pct",
    )

    # ----- ATH (adjusted: max of High × (AdjClose/Close) per bar) -----
    row["ath"] = _safe(compute_ath, highs, closes, adj_series,
                       errors=errors, label="ath")
    row["fall_from_ath_pct"] = _safe(
        gap_from_ath_pct, row["close"], row["ath"],
        errors=errors, label="fall_from_ath_pct",
    )

    # ----- Valuation: PE / PB / Market Cap from Screener.in (weekly) -----
    # Source decision (2026-09-01): these come from the `screener_ratios`
    # table (Saturday sync), NOT yfinance — same source and TTM convention
    # as the 5Y averages the screener rules compare against.
    ratios = inp.screener_ratios or {}
    mc = _safe(to_decimal, ratios.get("market_cap"),
               errors=errors, label="market_cap")
    row["market_cap"] = mc
    row["cap_bucket"] = _safe(classify_market_cap, mc,
                              errors=errors, label="cap_bucket")
    row["pe_current"] = _safe(to_decimal, ratios.get("pe"),
                              errors=errors, label="pe_current")
    row["pb_current"] = _safe(to_decimal, ratios.get("pb"),
                              errors=errors, label="pb_current")
    if not ratios:
        errors.append(
            "valuation: no screener_ratios for symbol — run the weekly "
            "ratios sync (pe/pb/market_cap left NULL)")

    # ----- Other .info-sourced Tier-A fields -----
    if inp.info:
        row["revenue_ttm"] = _safe(
            to_decimal, inp.info.get("totalRevenue"),
            errors=errors, label="revenue_ttm")
        margins = _safe(to_decimal, inp.info.get("profitMargins"),
                        errors=errors, label="profit_margin_pct")
        if margins is not None:
            # yfinance returns a 0..1 fraction; the registry stores percent.
            row["profit_margin_pct"] = round_half_up(margins * Decimal(100), 2)

    # ----- Trend: % change vs N trading days ago (adjusted closes) -----
    n = inp.trend_days
    if n > 0 and len(adj_series) > n:
        past = adj_series[-(n + 1)]
        curr = adj_series[-1]
        if past is not None and past > 0 and curr is not None:
            row["price_change_nd_pct"] = round_half_up(
                (curr - past) / past * Decimal(100), 2)

    # ----- Rally -----
    rally = _safe(compute_rally_metrics, bars,
                  errors=errors, label="rally")
    if rally is not None:
        rally_dict = rally.as_dict()
        # total_valid_rallies_in_window is a debug-only stat — not persisted.
        rally_dict.pop("total_valid_rallies_in_window", None)
        row.update(rally_dict)

    return row
