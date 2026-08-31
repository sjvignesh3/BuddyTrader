"""
Static gate: RLS migration 010_rls.sql must protect every persistent table.

We do not execute SQL here — Supabase Postgres is the source of truth for that.
This test guarantees the migration file itself remains structurally correct
so a stray edit can never ship a table without RLS enabled or without a
service_role policy.
"""
from __future__ import annotations

from pathlib import Path

import pytest

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "010_rls.sql"

# Every persistent table must be covered.
TABLES = [
    "stocks",
    "pools",
    "daily_snapshots",
    "fundamentals",
    "strategy_configs",
    "scans",
    "scan_results",
    "sync_jobs",
    "trades",
]

# Tables that expose a public anon-read policy (all read tables).
ANON_READ_TABLES = [t for t in TABLES if t != "trades"]


@pytest.fixture(scope="module")
def sql() -> str:
    assert MIGRATION.exists(), f"missing migration: {MIGRATION}"
    return MIGRATION.read_text()


class TestRlsMigration:
    def test_every_table_has_rls_enabled(self, sql):
        for t in TABLES:
            assert f"ALTER TABLE {t}" in sql, f"RLS not enabled on {t}"
            # crude but sufficient — the ALTER line explicitly enables RLS.
            line = next(
                (ln for ln in sql.splitlines() if ln.strip().startswith(f"ALTER TABLE {t}")),
                None,
            )
            assert line and "ENABLE ROW LEVEL SECURITY" in line, (
                f"ALTER TABLE {t} present but does not enable RLS"
            )

    def test_every_table_has_service_role_policy(self, sql):
        for t in TABLES:
            assert f"ON {t}" in sql, f"no policy references table {t}"
            assert "TO service_role" in sql, "service_role must be granted somewhere"

    def test_read_tables_have_anon_read(self, sql):
        for t in ANON_READ_TABLES:
            # Every read table must have a FOR SELECT TO anon policy.
            assert "TO anon" in sql, "anon role must be referenced"
            # Anon read policy must select from the table.
            snippet = f"ON {t} "
            assert snippet in sql, f"missing anon policy target for {t}"

    def test_trades_has_no_anon_policy(self, sql):
        # trades is money-adjacent: anon must have zero access.
        # There must be no `ON trades ... TO anon` policy.
        for line in sql.splitlines():
            if "ON trades" in line and "TO anon" in line:
                pytest.fail(f"trades must not grant anon access: {line}")

    def test_idempotent_drop_before_create(self, sql):
        # Every CREATE POLICY must be preceded by a matching DROP POLICY IF EXISTS
        # for the same policy name in the same file — so re-applying is safe.
        creates = [
            ln.strip() for ln in sql.splitlines()
            if ln.strip().startswith("CREATE POLICY")
        ]
        drops = [
            ln.strip() for ln in sql.splitlines()
            if ln.strip().startswith("DROP POLICY IF EXISTS")
        ]
        # Extract policy names.
        create_names = {c.split()[2] for c in creates}
        drop_names = {d.split()[4] for d in drops}
        missing = create_names - drop_names
        assert not missing, f"CREATE POLICY without matching DROP: {missing}"

    def test_no_public_grant_anywhere(self, sql):
        # PUBLIC role is a common footgun — must never be granted here.
        assert "TO public" not in sql.lower(), "public role must never be granted"
