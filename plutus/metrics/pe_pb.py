"""
PE / PB pickers from yfinance `.info` payload.

Preference order (matches Buddy):
    PE: trailingPE > forwardPE
    PB: priceToBook

5Y averages are Stage-5 work (needs quarterly EPS history). Stubbed here so
Stage 4 pipeline can import the surface without a NameError.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Optional, Sequence

from plutus.adapters.validators import sanity_check_ratio
from plutus.registry.types import round_half_up, to_decimal

_TWO = 2   # decimal places


def _pick(info: dict, keys: Sequence[str], *, field: str) -> Optional[Decimal]:
    for k in keys:
        v = info.get(k)
        if v in (None, "", 0, 0.0):
            continue
        try:
            d = sanity_check_ratio(v, field=field)
        except ValueError:
            continue
        if d is None:
            continue
        # Ratios like PE must be positive to be meaningful.
        if d <= 0:
            continue
        return round_half_up(d, _TWO)
    return None


def pick_pe(info: dict) -> Optional[Decimal]:
    """Trailing PE preferred, forward PE fallback."""
    if not info:
        return None
    return _pick(info, ("trailingPE", "forwardPE"), field="pe")


def pick_pb(info: dict) -> Optional[Decimal]:
    """Price to book from info."""
    if not info:
        return None
    return _pick(info, ("priceToBook",), field="pb")


def pe_5yr_avg(
    quarterly_net_income: Optional[Sequence[Optional[Decimal]]] = None,
    shares_outstanding: Optional[Decimal] = None,
    daily_closes: Optional[Sequence[Decimal]] = None,
) -> Optional[Decimal]:
    """
    5-year average PE.

    Stage 5 real implementation lives in ``plutus.fundamentals.quarterly``.
    Kept here as a thin re-export so the metrics surface stays stable and
    Stage 4 orchestrators can call this name without knowing about
    fundamentals module layout.
    """
    # Lazy import — avoids a metrics <-> fundamentals import cycle.
    from plutus.fundamentals.quarterly import compute_pe_5yr_avg
    if quarterly_net_income is None or shares_outstanding is None \
       or daily_closes is None:
        return None
    return compute_pe_5yr_avg(quarterly_net_income, shares_outstanding,
                              daily_closes)


def pb_5yr_avg(
    book_value_per_share: Optional[Decimal] = None,
    daily_closes: Optional[Sequence[Decimal]] = None,
) -> Optional[Decimal]:
    """5-year average PB — Stage 5 real implementation."""
    from plutus.fundamentals.quarterly import compute_pb_5yr_avg
    if book_value_per_share is None or daily_closes is None:
        return None
    return compute_pb_5yr_avg(book_value_per_share, daily_closes)
