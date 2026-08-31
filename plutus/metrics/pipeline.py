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
    sanity_check_ratio,
)
from plutus.metrics.ath import compute_ath, gap_from_ath_pct
from plutus.metrics.cap_bucket import classify_market_cap
from plutus.metrics.dma import compute_below_dma_pct, compute_dma
from plutus.metrics.pe_pb import pick_pb, pick_pe
from plutus.metrics.rally import OHLCVBar, compute_rally_metrics
from plutus.metrics.week52 import (
    compute_52w_high,
    compute_52w_low,
    distance_from_52w_high_pct,
    distance_from_52w_low_pct,
)
from plutus.registry.types import to_decimal


@dataclass
class SnapshotInputs:
    """Everything the pipeline needs. Kept as a dataclass so Stage 4 sync
    worker builds it once from Result[dict] payloads."""
    symbol: str
    snapshot_date: date
    bars: Sequence[OHLCVBar]                # sorted oldest → newest
    info: Dict[str, Any]                    # yfinance .info payload
    meta: Dict[str, Any] = field(default_factory=dict)


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
        # Derived
        "market_cap": None, "cap_bucket": None,
        "pe_current": None, "pb_current": None,
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

    latest = bars[-1]
    row["open"] = _safe(sanity_check_price, latest.open,
                        errors=errors, label="open", field="open")
    row["high"] = _safe(sanity_check_price, latest.high,
                        errors=errors, label="high", field="high")
    row["low"] = _safe(sanity_check_price, latest.low,
                       errors=errors, label="low", field="low")
    row["close"] = _safe(sanity_check_price, latest.close,
                         errors=errors, label="close", field="close")

    # Meta close (regularMarketPrice) preferred for the "current" price if given
    meta_close = inp.meta.get("regularMarketPrice") if inp.meta else None
    if meta_close:
        try:
            row["close"] = sanity_check_price(meta_close, field="close")
        except ValueError as exc:
            errors.append(f"meta.regularMarketPrice invalid: {exc}")

    row["adj_close"] = row["close"]   # yfinance normalisation handled upstream

    # Volume
    vol = inp.info.get("volume") if inp.info else None
    row["volume"] = _safe(sanity_check_count, vol,
                          errors=errors, label="volume", field="volume")

    # ----- DMA -----
    closes = [b.close for b in bars]
    dma = _safe(compute_dma, closes, errors=errors, label="dma_200", window=200)
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

    # ----- ATH -----
    # No adj_close per bar in this simple model — use close as fallback (=> no
    # dividend adjustment); Stage 4 wires real adj_close from yfinance.
    adj_series = [b.close for b in bars]
    row["ath"] = _safe(compute_ath, highs, closes, adj_series,
                       errors=errors, label="ath")
    row["fall_from_ath_pct"] = _safe(
        gap_from_ath_pct, row["close"], row["ath"],
        errors=errors, label="fall_from_ath_pct",
    )

    # ----- Market cap + bucket -----
    mc_raw = inp.info.get("marketCap") if inp.info else None
    mc: Optional[Decimal] = None
    if mc_raw is not None:
        try:
            mc = to_decimal(mc_raw)
            row["market_cap"] = mc
        except Exception as exc:
            errors.append(f"market_cap: {type(exc).__name__}: {exc}")
    row["cap_bucket"] = _safe(classify_market_cap, mc,
                              errors=errors, label="cap_bucket")

    # ----- PE / PB -----
    row["pe_current"] = _safe(pick_pe, inp.info,
                              errors=errors, label="pe_current")
    row["pb_current"] = _safe(pick_pb, inp.info,
                              errors=errors, label="pb_current")

    # ----- Rally -----
    rally = _safe(compute_rally_metrics, bars,
                  errors=errors, label="rally")
    if rally is not None:
        rally_dict = rally.as_dict()
        # total_valid_rallies_in_window is a debug-only stat — not persisted.
        rally_dict.pop("total_valid_rallies_in_window", None)
        row.update(rally_dict)

    return row
