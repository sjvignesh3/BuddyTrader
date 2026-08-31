"""Unit tests for plutus.api.serializers — money-safety on the wire."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pytest

from plutus.api.serializers import serialize_rows, to_wire


class TestToWirePrimitives:
    def test_none_passes_through(self):
        assert to_wire(None) is None

    def test_bool_preserved_not_converted_to_int(self):
        assert to_wire(True) is True
        assert to_wire(False) is False

    def test_int_and_str_pass_through(self):
        assert to_wire(42) == 42
        assert to_wire("HDFCBANK") == "HDFCBANK"

    def test_decimal_becomes_string_not_float(self):
        # This is the money-safety guarantee: no float() on financials.
        wire = to_wire(Decimal("1234.567890123"))
        assert wire == "1234.567890123"
        assert isinstance(wire, str)

    def test_date_isoformat(self):
        assert to_wire(date(2025, 1, 15)) == "2025-01-15"

    def test_datetime_isoformat(self):
        assert to_wire(datetime(2025, 1, 15, 9, 30, 0)) == "2025-01-15T09:30:00"

    def test_unknown_type_raises(self):
        class Weird:
            pass

        with pytest.raises(TypeError):
            to_wire(Weird())


class TestToWireNested:
    def test_dict_recurses(self):
        row = {
            "symbol": "TCS",
            "close": Decimal("3500.75"),
            "snapshot_date": date(2025, 1, 15),
            "active": True,
            "sector": None,
        }
        assert to_wire(row) == {
            "symbol": "TCS",
            "close": "3500.75",
            "snapshot_date": "2025-01-15",
            "active": True,
            "sector": None,
        }

    def test_list_recurses(self):
        assert to_wire([Decimal("1.5"), Decimal("2.5")]) == ["1.5", "2.5"]

    def test_deeply_nested(self):
        payload = {
            "scan": {
                "id": "s1",
                "summary": {"buy_zone": Decimal("12")},
                "results": [
                    {"symbol": "A", "score": Decimal("100")},
                    {"symbol": "B", "score": Decimal("70")},
                ],
            }
        }
        wire = to_wire(payload)
        assert wire["scan"]["summary"]["buy_zone"] == "12"
        assert wire["scan"]["results"][0]["score"] == "100"


class TestSerializeRows:
    def test_empty(self):
        assert serialize_rows([]) == []

    def test_batch(self):
        rows = [
            {"symbol": "A", "close": Decimal("10")},
            {"symbol": "B", "close": Decimal("20")},
        ]
        assert serialize_rows(rows) == [
            {"symbol": "A", "close": "10"},
            {"symbol": "B", "close": "20"},
        ]
