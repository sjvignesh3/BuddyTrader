"""
Zero-trust input validators.

Every value coming from yfinance (or a CSV) is checked here BEFORE it touches
the DB. Sanity bands are wide enough to accept every real Indian equity but
narrow enough to catch obvious garbage (negative prices, NaN ratios, bad tickers).
"""
from __future__ import annotations

import math
import re
from decimal import Decimal
from typing import Any, Optional

from plutus.registry.types import to_decimal

# -----------------------------------------------------------------------------
# Symbol
# -----------------------------------------------------------------------------
# NSE: uppercase alphanumerics, ampersand, hyphen; suffixed .NS
# BSE: same body, suffixed .BO
_SYMBOL_RE = re.compile(r"^[A-Z0-9&\-]{1,20}\.(NS|BO)$")


def sanity_check_symbol(symbol: Any) -> str:
    """Return the symbol unchanged if valid, else raise ValueError."""
    if not isinstance(symbol, str):
        raise ValueError(f"symbol must be str, got {type(symbol).__name__}")
    s = symbol.strip().upper()
    if not _SYMBOL_RE.match(s):
        raise ValueError(f"invalid symbol format: {symbol!r}")
    return s


# -----------------------------------------------------------------------------
# Price — must be strictly positive, finite, within a sane Indian equity band.
# Upper cap of ₹10,000,000 catches obvious data corruption (MRF trades ~1.5L).
# -----------------------------------------------------------------------------
_PRICE_MAX = Decimal("10000000")


def sanity_check_price(value: Any, *, field: str = "price") -> Optional[Decimal]:
    """
    Return a Decimal or raise ValueError.
    None / NaN / non-positive / > cap -> raises.
    """
    if value is None:
        raise ValueError(f"{field}: got None")
    if isinstance(value, float) and math.isnan(value):
        raise ValueError(f"{field}: got NaN")
    d = to_decimal(value)  # type/range gate: rejects Inf, NaN, bool
    if d <= 0:
        raise ValueError(f"{field}: must be > 0, got {d}")
    if d > _PRICE_MAX:
        raise ValueError(f"{field}: {d} exceeds sanity cap {_PRICE_MAX}")
    return d


# -----------------------------------------------------------------------------
# Ratio / percent — allow negatives (fall%, return%), reject absurd magnitudes.
# -----------------------------------------------------------------------------
_RATIO_MIN = Decimal("-1000")
_RATIO_MAX = Decimal("1000")


def sanity_check_ratio(value: Any, *, field: str = "ratio") -> Optional[Decimal]:
    """Return Decimal in [-1000, 1000] or raise. None passes through as None."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    d = to_decimal(value)
    if d < _RATIO_MIN or d > _RATIO_MAX:
        raise ValueError(f"{field}: {d} outside sanity band [{_RATIO_MIN}, {_RATIO_MAX}]")
    return d


# -----------------------------------------------------------------------------
# Volume / shares outstanding — non-negative integer, fits in BIGINT.
# -----------------------------------------------------------------------------
_INT64_MAX = 9_223_372_036_854_775_807


def sanity_check_count(value: Any, *, field: str = "count") -> Optional[int]:
    """Return non-negative int or None. Raises on garbage."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field}: bool is not a count")
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        value = int(value)
    if not isinstance(value, int):
        try:
            value = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field}: not coercible to int ({exc})")
    if value < 0:
        raise ValueError(f"{field}: negative count {value}")
    if value > _INT64_MAX:
        raise ValueError(f"{field}: exceeds BIGINT range")
    return value
