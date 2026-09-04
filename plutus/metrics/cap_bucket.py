"""
Market-cap bucket classification.

User-defined thresholds (Vicky's criteria, close to the AMFI semi-annual
cutoffs — Jul 2026 list: Large ~1,06,300 Cr, Mid ~33,500 Cr), in ₹ crores:
    Large  >= 1,00,000
    Mid    30,000 - 1,00,000
    Small  10,000 - 30,000
    Micro  <  10,000

Override the defaults without a code change via env vars (values in ₹ crores):
    PLUTUS_CAP_LARGE_MIN_CR / PLUTUS_CAP_MID_MIN_CR / PLUTUS_CAP_SMALL_MIN_CR
"""
from __future__ import annotations

import os
from decimal import Decimal
from typing import Literal, Optional

from plutus.registry.types import to_decimal

CapBucket = Literal["Large", "Mid", "Small", "Micro"]

# Thresholds in RUPEES (not crores) — yfinance returns marketCap in raw INR.
# 1 crore = 10,000,000
_CR = Decimal(10_000_000)


def _threshold_cr(env_key: str, default_cr: int) -> Decimal:
    """Threshold in rupees from an env var expressed in ₹ crores."""
    raw = os.environ.get(env_key, "").strip()
    if raw:
        try:
            return Decimal(raw) * _CR
        except ArithmeticError:
            pass  # malformed override — fall through to the default
    return Decimal(default_cr) * _CR


_LARGE_MIN = _threshold_cr("PLUTUS_CAP_LARGE_MIN_CR", 100_000)
_MID_MIN = _threshold_cr("PLUTUS_CAP_MID_MIN_CR", 30_000)
_SMALL_MIN = _threshold_cr("PLUTUS_CAP_SMALL_MIN_CR", 10_000)


def classify_market_cap(market_cap_inr: Optional[Decimal]) -> Optional[CapBucket]:
    """
    Classify market cap into Large / Mid / Small / Micro bucket.

    Args:
        market_cap_inr: market cap in RAW RUPEES (yfinance native unit).

    Returns:
        Bucket string, or None if input is missing / non-positive.
    """
    if market_cap_inr is None:
        return None
    mc = to_decimal(market_cap_inr)
    if mc <= 0:
        return None

    if mc >= _LARGE_MIN:
        return "Large"
    if mc >= _MID_MIN:
        return "Mid"
    if mc >= _SMALL_MIN:
        return "Small"
    return "Micro"
