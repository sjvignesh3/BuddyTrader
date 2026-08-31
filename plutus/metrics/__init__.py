"""Plutus metrics package — pure Decimal computations, no I/O."""

from plutus.metrics.ath import compute_ath, gap_from_ath_pct
from plutus.metrics.cap_bucket import classify_market_cap
from plutus.metrics.dma import compute_below_dma_pct, compute_dma
from plutus.metrics.pe_pb import pb_5yr_avg, pe_5yr_avg, pick_pb, pick_pe
from plutus.metrics.pipeline import SnapshotInputs, compute_snapshot
from plutus.metrics.rally import OHLCVBar, RallyResult, compute_rally_metrics
from plutus.metrics.week52 import (
    compute_52w_high,
    compute_52w_low,
    distance_from_52w_high_pct,
    distance_from_52w_low_pct,
)

__all__ = [
    "compute_ath",
    "gap_from_ath_pct",
    "classify_market_cap",
    "compute_dma",
    "compute_below_dma_pct",
    "pick_pe",
    "pick_pb",
    "pe_5yr_avg",
    "pb_5yr_avg",
    "OHLCVBar",
    "RallyResult",
    "compute_rally_metrics",
    "compute_52w_high",
    "compute_52w_low",
    "distance_from_52w_high_pct",
    "distance_from_52w_low_pct",
    "SnapshotInputs",
    "compute_snapshot",
]
