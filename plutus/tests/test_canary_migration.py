"""Static gates for `011_canary_checks.sql`."""
from __future__ import annotations

from pathlib import Path

import pytest

SQL = Path(__file__).resolve().parents[1] / "migrations" / "011_canary_checks.sql"


@pytest.fixture(scope="module")
def sql_text() -> str:
    assert SQL.exists(), f"migration missing: {SQL}"
    return SQL.read_text()


def test_creates_table(sql_text: str) -> None:
    assert "CREATE TABLE IF NOT EXISTS canary_checks" in sql_text


def test_numeric_columns_are_numeric_not_float(sql_text: str) -> None:
    # Money-safety: no FLOAT / DOUBLE / REAL types in the SCHEMA (comments
    # are allowed to mention them — that's how we document the ban).
    executable = "\n".join(
        line.split("--", 1)[0] for line in sql_text.splitlines()
    ).lower()
    for banned in (" float", " double", " real"):
        assert banned not in executable, f"forbidden numeric type: {banned!r}"
    for col in ("expected_close", "tolerance_pct",
                "last_observed_close", "last_drift_pct"):
        assert col in sql_text
    assert "NUMERIC(18, 4)" in sql_text
    assert "NUMERIC(6, 4)" in sql_text


def test_natural_key_uniqueness(sql_text: str) -> None:
    assert "UNIQUE (symbol, check_date)" in sql_text


def test_updated_at_trigger_reuses_shared_function(sql_text: str) -> None:
    # We MUST reuse the trigger function created in 001_stocks.sql, not
    # redefine it — same money-safety reason as every other table.
    assert "trg_canary_touch" in sql_text
    assert "plutus_touch_updated_at" in sql_text


def test_rls_locked_down(sql_text: str) -> None:
    assert "ENABLE ROW LEVEL SECURITY" in sql_text
    assert "canary_anon_read" in sql_text
    assert "canary_service_write" in sql_text
    # anon must be SELECT-only. Grep the exact policy line.
    assert "canary_anon_read     ON canary_checks FOR SELECT TO anon" in sql_text
    # service_role gets FOR ALL.
    assert "canary_service_write ON canary_checks FOR ALL    TO service_role" in sql_text


def test_idempotent_reapply(sql_text: str) -> None:
    assert "DROP POLICY IF EXISTS canary_anon_read" in sql_text
    assert "DROP POLICY IF EXISTS canary_service_write" in sql_text
    assert "DROP TRIGGER IF EXISTS trg_canary_touch" in sql_text
    assert "CREATE TABLE IF NOT EXISTS canary_checks" in sql_text
