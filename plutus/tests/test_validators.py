"""Sanity-band tests for zero-trust validators."""
from __future__ import annotations

import math
from decimal import Decimal

import pytest

from plutus.adapters.validators import (
    sanity_check_count,
    sanity_check_price,
    sanity_check_ratio,
    sanity_check_symbol,
)


# --- symbol ------------------------------------------------------------------

@pytest.mark.parametrize("s", [
    "RELIANCE.NS", "TCS.NS", "M&M.NS", "L&TFH.NS", "500325.BO", "3IINFOLTD.NS",
])
def test_symbol_valid(s: str) -> None:
    assert sanity_check_symbol(s) == s.upper()


@pytest.mark.parametrize("s", [
    "", "RELIANCE", "RELIANCE.XX", "reliance ns",
    "TOOOOO_LONG_SYMBOL_NAME_HERE.NS",  # > 20 char body
    "  ", None, 123,
])
def test_symbol_invalid(s) -> None:
    with pytest.raises((ValueError, TypeError)):
        sanity_check_symbol(s)


def test_symbol_trims_whitespace() -> None:
    assert sanity_check_symbol("  RELIANCE.NS  ") == "RELIANCE.NS"


def test_symbol_uppercases() -> None:
    assert sanity_check_symbol("reliance.ns") == "RELIANCE.NS"


# --- price -------------------------------------------------------------------

def test_price_accepts_int_float_str() -> None:
    assert sanity_check_price(100) == Decimal("100")
    assert sanity_check_price(100.55) == Decimal("100.55")
    assert sanity_check_price("100.5500") == Decimal("100.5500")


def test_price_rejects_non_positive() -> None:
    with pytest.raises(ValueError):
        sanity_check_price(0)
    with pytest.raises(ValueError):
        sanity_check_price(-1)


def test_price_rejects_none_and_nan() -> None:
    with pytest.raises(ValueError):
        sanity_check_price(None)
    with pytest.raises(ValueError):
        sanity_check_price(float("nan"))


def test_price_rejects_above_cap() -> None:
    with pytest.raises(ValueError):
        sanity_check_price(Decimal("10000001"))


# --- ratio -------------------------------------------------------------------

def test_ratio_accepts_negative() -> None:
    assert sanity_check_ratio(-50) == Decimal("-50")


def test_ratio_none_and_nan_pass_through() -> None:
    assert sanity_check_ratio(None) is None
    assert sanity_check_ratio(float("nan")) is None


def test_ratio_rejects_out_of_band() -> None:
    with pytest.raises(ValueError):
        sanity_check_ratio(Decimal("1001"))
    with pytest.raises(ValueError):
        sanity_check_ratio(Decimal("-1001"))


# --- count -------------------------------------------------------------------

def test_count_accepts_int_and_float() -> None:
    assert sanity_check_count(100) == 100
    assert sanity_check_count(100.0) == 100


def test_count_rejects_bool() -> None:
    with pytest.raises(ValueError):
        sanity_check_count(True)


def test_count_rejects_negative() -> None:
    with pytest.raises(ValueError):
        sanity_check_count(-1)


def test_count_none_passes_through() -> None:
    assert sanity_check_count(None) is None


def test_count_nan_and_inf_become_none() -> None:
    assert sanity_check_count(float("nan")) is None
    assert sanity_check_count(float("inf")) is None
