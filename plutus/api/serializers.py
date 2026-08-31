"""
JSON serialisation helpers for the read-only API.

Rules:
  * Decimal -> str (never float — no round-trip drift).
  * date / datetime -> ISO 8601 string.
  * None passes through.
  * Unknown types raise TypeError so callers never silently ship garbage.

This module is used both by the FastAPI response encoder and by unit tests.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, Iterable, List


def to_wire(value: Any) -> Any:
    """Recursively convert ``value`` to JSON-safe primitives."""
    if value is None:
        return None
    if isinstance(value, bool):  # bool is subclass of int — check first
        return value
    if isinstance(value, Decimal):
        # Keep full precision; frontend parses as string or Number.
        return str(value)
    if isinstance(value, (int, float, str)):
        return value
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: to_wire(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_wire(v) for v in value]
    raise TypeError(f"Unsupported type for wire: {type(value).__name__}")


def serialize_rows(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Vectorised ``to_wire`` for a list of DB row dicts."""
    return [to_wire(r) for r in rows]
