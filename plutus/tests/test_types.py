"""Tests for plutus.registry.types.

These are pure unit tests -- no I/O, no network. They lock down the
conversion + rounding contract that every downstream stage depends on.
"""

from decimal import Decimal

import pytest

from plutus.registry.types import (
    round_bankers,
    round_half_up,
    to_decimal,
)


class TestToDecimal:
    def test_none_returns_none(self):
        assert to_decimal(None) is None

    def test_empty_string_returns_none(self):
        assert to_decimal("") is None
        assert to_decimal("   ") is None

    @pytest.mark.parametrize("bad", ["NaN", "nan", "null", "None", "inf", "-inf", "Infinity"])
    def test_bad_string_returns_none(self, bad):
        assert to_decimal(bad) is None

    def test_int(self):
        assert to_decimal(42) == Decimal("42")

    def test_float_avoids_binary_artefacts(self):
        # If we did Decimal(0.1) we'd get 0.1000000000000000055...
        # str(0.1) gives '0.1' which is what we want.
        assert to_decimal(0.1) == Decimal("0.1")

    def test_float_nan(self):
        assert to_decimal(float("nan")) is None

    def test_float_inf(self):
        assert to_decimal(float("inf")) is None
        assert to_decimal(float("-inf")) is None

    def test_string_numeric(self):
        assert to_decimal("123.45") == Decimal("123.45")

    def test_string_with_whitespace(self):
        assert to_decimal("  99.9  ") == Decimal("99.9")

    def test_decimal_passthrough(self):
        d = Decimal("7.77")
        assert to_decimal(d) == d

    def test_bool_rejected(self):
        with pytest.raises(TypeError):
            to_decimal(True)
        with pytest.raises(TypeError):
            to_decimal(False)

    def test_allow_negative_default(self):
        assert to_decimal(-5) == Decimal("-5")

    def test_disallow_negative(self):
        assert to_decimal(-5, allow_negative=False) is None
        assert to_decimal(-0.01, allow_negative=False) is None

    def test_disallow_negative_keeps_positive(self):
        assert to_decimal(5, allow_negative=False) == Decimal("5")
        assert to_decimal(0, allow_negative=False) == Decimal("0")


class TestRoundHalfUp:
    def test_none_passthrough(self):
        assert round_half_up(None, 2) is None

    def test_half_rounds_up(self):
        # School-book: 0.5 rounds up.
        assert round_half_up(Decimal("0.5"), 0) == Decimal("1")
        assert round_half_up(Decimal("1.5"), 0) == Decimal("2")
        assert round_half_up(Decimal("2.5"), 0) == Decimal("3")

    def test_precision(self):
        assert round_half_up(Decimal("1.23456"), 2) == Decimal("1.23")
        assert round_half_up(Decimal("1.235"), 2) == Decimal("1.24")

    def test_negative_places_raises(self):
        with pytest.raises(ValueError):
            round_half_up(Decimal("1"), -1)


class TestRoundBankers:
    def test_none_passthrough(self):
        assert round_bankers(None, 2) is None

    def test_banker_rounding(self):
        # Banker's: 0.5 rounds to nearest even.
        assert round_bankers(Decimal("0.5"), 0) == Decimal("0")
        assert round_bankers(Decimal("1.5"), 0) == Decimal("2")
        assert round_bankers(Decimal("2.5"), 0) == Decimal("2")
        assert round_bankers(Decimal("3.5"), 0) == Decimal("4")

    def test_precision(self):
        assert round_bankers(Decimal("1.235"), 2) == Decimal("1.24")
        assert round_bankers(Decimal("1.245"), 2) == Decimal("1.24")  # even

    def test_negative_places_raises(self):
        with pytest.raises(ValueError):
            round_bankers(Decimal("1"), -1)
