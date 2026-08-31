"""Decimal-first numeric primitives for Plutus.

Rules
-----
* Anything that represents money, price, ratio, or percent MUST use these
  aliases. `float` is banned for financial values (verified by a CI grep gate).
* `to_decimal()` is the ONLY sanctioned way to convert an external
  (yfinance / JSON / CSV) value into a Decimal. It normalizes ``None``,
  ``NaN``, empty strings, and infinities to ``None`` so downstream code never
  has to guess.
* Two rounding helpers are exposed. Callers must choose explicitly — never
  rely on Python's default ``round()``.

The module is intentionally tiny and dependency-free so it can be imported
from anywhere (adapters, metrics, sync, scan) with zero side effects.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN, ROUND_HALF_UP
from typing import Optional, Union

# ---------------------------------------------------------------------------
# Type aliases — semantic markers over Decimal. They are *aliases*, not
# subclasses, so runtime behaviour is identical to Decimal while the intent is
# still obvious at call sites and in type checkers.
# ---------------------------------------------------------------------------
Money = Decimal    # Currency amounts (₹ Cr, ₹ absolute). Scale set at storage.
Price = Decimal    # Per-share prices. Typically 2 dp.
Ratio = Decimal    # Dimensionless ratios (PE, PB, D/E). Typically 2–4 dp.
Percent = Decimal  # Values expressed as a percent (0..100), NOT 0..1.

# Anything numeric-ish that a caller might have.
Numeric = Union[int, float, str, Decimal, None]


# Sentinels used by ``to_decimal`` to detect bad float inputs before they
# pollute the DB. Plain ``Decimal(NaN)`` compares oddly, so we bail early.
_BAD_STRINGS = frozenset({"", "nan", "NaN", "NAN", "None", "null", "NULL", "inf", "-inf", "Infinity", "-Infinity"})


def to_decimal(value: Numeric, *, allow_negative: bool = True) -> Optional[Decimal]:
    """Normalize any numeric-ish input to a ``Decimal`` or ``None``.

    This is the ONLY approved conversion path for external numeric data.

    Behaviour
    ---------
    * ``None``                              -> ``None``
    * ``float('nan')`` / ``float('inf')``   -> ``None``
    * ``""`` / ``"NaN"`` / ``"null"``       -> ``None``
    * ``int`` / ``str`` / ``Decimal``       -> ``Decimal(value)``
    * ``float``                             -> ``Decimal(str(value))`` (avoids
      binary-float artefacts like ``0.1 -> 0.1000000000000000055``).

    Parameters
    ----------
    value:
        Raw input from yfinance, JSON, CSV, or user.
    allow_negative:
        If ``False``, negative results are coerced to ``None``. Useful for
        fields like price and market cap which are strictly positive.
    """
    if value is None:
        return None
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, bool):
        # Booleans are ints in Python — reject explicitly to avoid silent 0/1.
        raise TypeError("to_decimal does not accept bool; convert intent explicitly.")
    elif isinstance(value, int):
        result = Decimal(value)
    elif isinstance(value, float):
        # NaN / inf checks.
        if value != value or value in (float("inf"), float("-inf")):
            return None
        # ``str(float)`` reproduces the shortest repr — safe for Decimal.
        result = Decimal(str(value))
    elif isinstance(value, str):
        stripped = value.strip()
        if stripped in _BAD_STRINGS:
            return None
        try:
            result = Decimal(stripped)
        except InvalidOperation:
            return None
    else:
        raise TypeError(f"Unsupported type for to_decimal: {type(value).__name__}")

    # Reject NaN/Inf that snuck through.
    if not result.is_finite():
        return None

    if not allow_negative and result < 0:
        return None
    return result


def round_half_up(value: Optional[Decimal], places: int) -> Optional[Decimal]:
    """Round using ROUND_HALF_UP (school-book rounding).

    Prefer this for display-facing values (e.g. table cells).
    """
    if value is None:
        return None
    if places < 0:
        raise ValueError("places must be >= 0")
    quant = Decimal(1).scaleb(-places)
    return value.quantize(quant, rounding=ROUND_HALF_UP)


def round_bankers(value: Optional[Decimal], places: int) -> Optional[Decimal]:
    """Round using ROUND_HALF_EVEN (banker's rounding).

    Prefer this for accumulated financial values where bias matters.
    """
    if value is None:
        return None
    if places < 0:
        raise ValueError("places must be >= 0")
    quant = Decimal(1).scaleb(-places)
    return value.quantize(quant, rounding=ROUND_HALF_EVEN)
