"""
Static gate for the personal-tool migrations (013 journal → 017 net worth).

Like test_rls_migration, we do not execute SQL — Supabase Postgres is the
source of truth for that. These checks guarantee the files keep the
conventions every later migration copied from 013/015:
  * every new table enables RLS and has a service_role policy,
  * anon is never granted anything (no policy = deny),
  * FLOAT / REAL / DOUBLE PRECISION never appear (money is NUMERIC),
  * every CREATE POLICY has a matching DROP POLICY IF EXISTS,
  * every table with updated_at has a plutus_touch_updated_at trigger,
  * DDL is idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"

FILES = {
    "013_journal.sql": ["journal_settings", "journal_opportunities", "journal_trades"],
    "015_expenses.sql": ["expense_categories", "expense_recurring", "expenses",
                         "expense_items", "expense_budgets"],
    "016_sizing_plans.sql": ["sizing_plans"],
    "017_net_worth.sql": ["networth_assets", "networth_liabilities", "networth_snapshots",
                          "networth_income", "networth_milestones", "networth_settings"],
}


@pytest.fixture(scope="module")
def sqls() -> dict:
    out = {}
    for name in FILES:
        path = MIGRATIONS / name
        assert path.exists(), f"missing migration: {path}"
        out[name] = path.read_text(encoding="utf-8")
    return out


def _tables_created(sql: str) -> set:
    return set(re.findall(r"CREATE TABLE IF NOT EXISTS\s+(\w+)", sql))


class TestPersonalMigrations:
    def test_expected_tables_are_created_idempotently(self, sqls):
        for name, tables in FILES.items():
            created = _tables_created(sqls[name])
            assert set(tables) <= created, f"{name}: missing {set(tables) - created}"
            # No bare CREATE TABLE (must always be IF NOT EXISTS).
            assert not re.search(r"CREATE TABLE\s+(?!IF NOT EXISTS)", sqls[name]), name

    def test_every_table_has_rls_and_service_policy(self, sqls):
        for name, tables in FILES.items():
            sql = sqls[name]
            for t in tables:
                assert re.search(rf"ALTER TABLE {t}\s+ENABLE ROW LEVEL SECURITY", sql), \
                    f"{name}: RLS not enabled on {t}"
                assert re.search(rf"CREATE POLICY \w+ ON {t}\s+FOR ALL TO service_role", sql), \
                    f"{name}: no service_role policy on {t}"

    def test_anon_and_public_never_granted(self, sqls):
        for name, sql in sqls.items():
            low = sql.lower()
            assert "to anon" not in low, f"{name}: anon must have no access"
            assert "to public" not in low, f"{name}: public must never be granted"

    def test_no_float_types(self, sqls):
        for name, sql in sqls.items():
            for banned in ("FLOAT", "REAL", "DOUBLE PRECISION"):
                # Word-boundary match so 'REAL' in a comment like 'Real Estate' is
                # ignored only when it isn't a type: check DDL lines only.
                for line in sql.splitlines():
                    if line.strip().startswith("--"):
                        continue
                    code = line.split("--")[0]
                    assert not re.search(rf"\b{banned}\b(?!\s+Estate)", code, re.IGNORECASE), \
                        f"{name}: banned type {banned!r} in: {line.strip()}"

    def test_drop_before_create_policy(self, sqls):
        for name, sql in sqls.items():
            creates = set(re.findall(r"CREATE POLICY (\w+)", sql))
            drops = set(re.findall(r"DROP POLICY IF EXISTS (\w+)", sql))
            assert creates <= drops, f"{name}: CREATE POLICY without DROP: {creates - drops}"

    def test_updated_at_tables_have_touch_trigger(self, sqls):
        for name, sql in sqls.items():
            for table in _tables_created(sql):
                body = sql.split(f"CREATE TABLE IF NOT EXISTS {table}", 1)[1].split(");", 1)[0]
                if "updated_at" in body:
                    assert re.search(
                        rf"BEFORE UPDATE ON {table}\s+FOR EACH ROW EXECUTE FUNCTION "
                        r"plutus_touch_updated_at\(\)", sql), \
                        f"{name}: {table} has updated_at but no touch trigger"

    def test_money_columns_are_numeric(self, sqls):
        money_cols = {
            "016_sizing_plans.sql": ["capital", "risk_pct", "entry", "stop", "stop_price"],
            "017_net_worth.sql": ["current_value", "cost_basis", "outstanding", "emi",
                                  "equity_value", "assets_value", "liabilities_value",
                                  "net_worth", "amount", "target", "ff_target_corpus"],
        }
        for name, cols in money_cols.items():
            for col in cols:
                assert re.search(rf"\b{col}\s+NUMERIC\(", sqls[name]), \
                    f"{name}: {col} must be NUMERIC(p,s)"

    def test_016_adds_stop_price_idempotently(self, sqls):
        sql = sqls["016_sizing_plans.sql"]
        for t in ("journal_opportunities", "journal_trades"):
            assert re.search(
                rf"ALTER TABLE {t}\s+ADD COLUMN IF NOT EXISTS stop_price NUMERIC", sql), t
        assert "CHECK (stop < entry)" in sql

    def test_017_monthly_tables_are_unique_per_month(self, sqls):
        sql = sqls["017_net_worth.sql"]
        assert "UNIQUE (snapshot_date)" in sql
        assert "UNIQUE (month)" in sql
        assert "EXTRACT(DAY FROM snapshot_date) = 1" in sql

    def test_readme_lists_new_migrations(self):
        readme = (MIGRATIONS / "README.md").read_text(encoding="utf-8")
        for name in ("015_expenses.sql", "016_sizing_plans.sql", "017_net_worth.sql"):
            assert name in readme, f"migrations/README.md must list {name}"

    def test_017_evolves_the_asset_class_constraint_idempotently(self, sqls):
        """017 follows the 003 precedent: the table is evolved in-place, so a
        re-run must DROP ... IF EXISTS before ADD or it fails the second time."""
        sql = sqls["017_net_worth.sql"]
        drop = sql.index("DROP CONSTRAINT IF EXISTS networth_assets_asset_class_check")
        add = sql.index("ADD CONSTRAINT networth_assets_asset_class_check")
        assert drop < add

    def test_asset_classes_match_the_sql_constraint(self, sqls):
        """The allowed classes live in three places (SQL, Python, TypeScript).
        A row the API accepts but Postgres rejects surfaces as a 502, so gate
        the SQL/Python pair here; TypeScript is gated by tsc against the same
        literal union. 017 carries the list twice (inline CHECK for a fresh
        DB, ADD CONSTRAINT for an existing one) — both must agree."""
        from plutus.api.networth import ASSET_CLASSES

        lists = re.findall(r"CHECK \(asset_class IN \((.*?)\)\)",
                           sqls["017_net_worth.sql"], re.DOTALL)
        assert len(lists) == 2, "017 must carry the inline CHECK and the evolution ADD"
        inline, evolved = (set(re.findall(r"'([^']+)'", body)) for body in lists)
        assert inline == evolved, f"017 inline vs evolution lists differ: {inline ^ evolved}"
        assert inline == ASSET_CLASSES, (
            f"drifted: only in SQL {inline - ASSET_CLASSES}, "
            f"only in Python {ASSET_CLASSES - inline}")
