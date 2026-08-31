"""
Market-cap bucket classification.

Thresholds from Plutus_Plan.MD §4.1 (in ₹ crores):
    Large  >= 50,000
    Mid    15,000 – 50,000
    Small  5,000 – 15,000
    Micro  <  5,000
"""
from __future__ import annotations

from decimal import Decimal
from typing import Literal, Optional

from plutus.registry.types import to_decimal

CapBucket = Literal["Large", "Mid", "Small", "Micro"]

# Thresholds in RUPEES (not crores) — yfinance returns marketCap in raw INR.
# 1 crore = 10,000,000
_CR = Decimal(10_000_000)
_LARGE_MIN = Decimal(50_000) * _CR
_MID_MIN = Decimal(15_000) * _CR
_SMALL_MIN = Decimal(5_000) * _CR


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
