"""Tests for the field registry.

These lock down the invariants that keep migrations, adapters, and metrics
in sync with a single source of truth.
"""

import re
from pathlib import Path

import pytest

from plutus.registry.fields import (
    FIELDS,
    Field,
    FieldDType,
    FieldSource,
    FieldTier,
    fields_for,
    get_field,
    tables,
)


# ---------------------------------------------------------------------------
# Registry invariants
# ---------------------------------------------------------------------------
def test_registry_not_empty():
    assert len(FIELDS) > 30, "Field registry looks suspiciously small."


def test_all_names_are_snake_case():
    pat = re.compile(r"^[a-z][a-z0-9_]*$")
    for (table, name), f in FIELDS.items():
        assert pat.match(name), f"{table}.{name} is not snake_case"
        assert pat.match(table), f"{table} is not snake_case"


def test_decimal_fields_have_precision():
    for f in FIELDS.values():
        if f.dtype is FieldDType.DECIMAL:
            assert f.precision is not None, (
                f"DECIMAL field '{f.table}.{f.name}' must declare precision (p, s)"
            )
            p, s = f.precision
            assert p > 0 and s >= 0 and s <= p, (
                f"Bad precision {f.precision} on {f.table}.{f.name}"
            )


def test_derived_fields_have_formula():
    for f in FIELDS.values():
        if f.source is FieldSource.DERIVED:
            assert f.formula, f"{f.table}.{f.name} is DERIVED but has no formula"


def test_yf_fields_have_yf_key():
    """Every non-payload yfinance-sourced field must name its source key.

    JSONB payload dumps (``raw_yf_meta``, ``raw_yf_payload``) intentionally
    store the whole blob and therefore do not correspond to a single key.
    They are excluded by dtype rather than by hardcoded name.
    """
    yf_sources = {
        FieldSource.YF_INFO,
        FieldSource.YF_HISTORY,
        FieldSource.YF_QUARTERLY,
        FieldSource.YF_HOLDERS,
    }
    for f in FIELDS.values():
        if f.source in yf_sources and f.dtype is not FieldDType.JSONB:
            assert f.yf_key, (
                f"{f.table}.{f.name} sourced from {f.source.value} must set yf_key"
            )


def test_expected_tables_present():
    expected = {
        "stocks",
        "daily_snapshots",
        "fundamentals",
    }
    assert expected.issubset(set(tables()))


# ---------------------------------------------------------------------------
# Critical fields must exist -- these are consumed by strategies later.
# ---------------------------------------------------------------------------
CRITICAL = [
    ("stocks", "symbol"),
    ("stocks", "pools"),
    ("daily_snapshots", "close"),
    ("daily_snapshots", "dma_200"),
    ("daily_snapshots", "below_200dma_pct"),
    ("daily_snapshots", "ath"),
    ("daily_snapshots", "fall_from_ath_pct"),
    ("daily_snapshots", "high_52w"),
    ("daily_snapshots", "low_52w"),
    ("daily_snapshots", "pe_current"),
    ("daily_snapshots", "pb_current"),
    ("daily_snapshots", "market_cap"),
    ("daily_snapshots", "cap_bucket"),
    ("daily_snapshots", "has_valid_20pct_rally"),
    ("fundamentals", "sales"),
    ("fundamentals", "pbt"),
    ("fundamentals", "net_profit"),
    ("fundamentals", "promoter_holding_pct"),
    ("fundamentals", "promoter_pledging_pct"),
]


@pytest.mark.parametrize(("table", "name"), CRITICAL)
def test_critical_field_exists(table, name):
    f = get_field(name, table=table)
    assert isinstance(f, Field)
    assert f.table == table
    assert f.name == name


# ---------------------------------------------------------------------------
# get_field disambiguation
# ---------------------------------------------------------------------------
def test_get_field_ambiguous_raises():
    # 'symbol' appears on multiple tables; must require explicit table.
    with pytest.raises(KeyError):
        get_field("symbol")


def test_get_field_unique_works():
    f = get_field("ath")  # only on daily_snapshots
    assert f.table == "daily_snapshots"


def test_get_field_unknown_raises():
    with pytest.raises(KeyError):
        get_field("no_such_field_ever")


# ---------------------------------------------------------------------------
# fields_for helper
# ---------------------------------------------------------------------------
def test_fields_for_returns_only_that_table():
    for f in fields_for("daily_snapshots"):
        assert f.table == "daily_snapshots"


# ---------------------------------------------------------------------------
# Migration <-> Registry alignment
# ---------------------------------------------------------------------------
# Every registry column for `stocks`, `daily_snapshots`, `fundamentals`
# MUST appear (as a whole-word match) inside the matching migration file.
# This is the guardrail that stops the two from drifting.
MIGRATION_MAP = {
    "stocks": "001_stocks.sql",
    "daily_snapshots": "003_daily_snapshots.sql",
    "fundamentals": "004_fundamentals.sql",
}


@pytest.mark.parametrize("table", list(MIGRATION_MAP.keys()))
def test_registry_columns_present_in_migration(table):
    migrations_dir = Path(__file__).resolve().parents[1] / "migrations"
    sql_path = migrations_dir / MIGRATION_MAP[table]
    assert sql_path.exists(), f"Missing migration file: {sql_path}"
    sql = sql_path.read_text(encoding="utf-8")
    for f in fields_for(table):
        # id / created_at / updated_at are DB-managed; skip.
        if f.name in {"id", "created_at", "updated_at"}:
            continue
        pattern = re.compile(rf"\b{re.escape(f.name)}\b")
        assert pattern.search(sql), (
            f"Registry field '{table}.{f.name}' not found in {sql_path.name}. "
            "Registry and migration are out of sync."
        )
