"""Personal-data backup & restore (plutus/backup/personal.py) — offline.

Export goes through a fake PostgREST client (select / order / range), restore
through an injected upsert that records every call, so the FK order,
conflict keys and self-referencing waves are all asserted without a DB.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from plutus.backup import personal
from plutus.tests.test_api_repository import FakeSupabase


def _tables():
    return {
        "pools": [{"code": "F40", "name": "Flagship 40"}],
        "stocks": [{"id": 7, "symbol": "TCS.NS", "pools": ["F40"], "sector_group": "Normal"},
                   {"id": 9, "symbol": "HDFCBANK.NS", "pools": ["F40"], "sector_group": "Banks"}],
        "journal_settings": [{"id": 1, "capital": "1000000"}],
        "journal_opportunities": [{"id": 3, "symbol": "TCS.NS", "status": "open"}],
        "journal_trades": [{"id": 11, "opportunity_id": 3, "symbol": "TCS.NS",
                            "qty": 10, "buy_price": Decimal("2348.50")}],
        "expense_categories": [{"id": 2, "name": "Food", "parent_id": 1},
                               {"id": 1, "name": "Living", "parent_id": None},
                               {"id": 3, "name": "Rent", "parent_id": 1}],
        "expenses": [{"id": 5, "category_id": 2, "amount": "250.00", "spent_on": "2026-09-30"}],
        "networth_settings": [{"id": 1, "target_amount": "50000000"}],
        "watchlists": [{"id": 4, "name": "S1", "symbols": ["TCS.NS"]}],
    }


class TestSelectTables:
    def test_default_is_everything_in_fk_order(self):
        names = [t.name for t in personal.select_tables()]
        assert names.index("journal_opportunities") < names.index("journal_trades")
        assert names.index("expense_categories") < names.index("expenses")
        assert names.index("pools") < names.index("stocks")
        assert names[0] == "pools" and "watchlists" in names

    def test_groups_and_names_mix(self):
        names = [t.name for t in personal.select_tables(["journal", "watchlists", "expenses"])]
        assert "journal_trades" in names and "watchlists" in names and "expenses" in names
        assert "networth_assets" not in names and "stocks" not in names
        # FK order preserved even when picked by group
        assert names.index("journal_opportunities") < names.index("journal_trades")

    def test_unknown_name_raises(self):
        with pytest.raises(ValueError, match="unknown table/group: journl"):
            personal.select_tables(["journl"])


class TestExport:
    def test_writes_one_file_per_table_and_manifest(self, tmp_path: Path):
        cli = FakeSupabase(_tables())
        now = datetime(2026, 10, 2, 21, 0, 0, tzinfo=timezone.utc)
        m = personal.export_tables(cli, tmp_path, source="https://x.supabase.co", now=now)
        out = Path(m["dir"])
        assert out.name == "2026-10-02_210000"
        assert (out / "manifest.json").exists()
        assert m["tables"]["stocks"]["rows"] == 2
        assert m["tables"]["journal_trades"]["rows"] == 1
        # Tables absent from the fake DB still land as empty arrays.
        assert m["tables"]["networth_assets"]["rows"] == 0
        assert m["errors"] == {}
        trades = json.loads((out / "journal_trades.json").read_text(encoding="utf-8"))
        assert trades[0]["buy_price"] == "2348.50"        # Decimal -> string, never float
        assert trades[0]["opportunity_id"] == 3           # ids kept for FK fidelity
        # Exported in natural-key order (fake applies .order()).
        cats = json.loads((out / "expense_categories.json").read_text(encoding="utf-8"))
        assert [c["id"] for c in cats] == [1, 2, 3]

    def test_failed_table_is_reported_not_fatal(self, tmp_path: Path):
        def fetch(client, spec):
            if spec.name == "expenses":
                raise RuntimeError("boom")
            return [{"id": 1}]
        m = personal.export_tables(FakeSupabase({}), tmp_path, fetch=fetch,
                                   tables=personal.select_tables(["expenses", "watchlists"]))
        assert "expenses" in m["errors"] and "RuntimeError" in m["errors"]["expenses"]
        assert m["tables"]["watchlists"]["rows"] == 1

    def test_prune_keeps_newest_n_and_ignores_strangers(self, tmp_path: Path):
        for stamp in ("2026-09-01_000000", "2026-09-08_000000", "2026-09-15_000000"):
            d = tmp_path / stamp
            d.mkdir()
            (d / "manifest.json").write_text("{}", encoding="utf-8")
        (tmp_path / "notes").mkdir()                     # no manifest -> untouched
        removed = personal.prune_backups(tmp_path, keep=2)
        assert [p.name for p in removed] == ["2026-09-01_000000"]
        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "2026-09-08_000000", "2026-09-15_000000", "notes"]
        assert personal.prune_backups(tmp_path, keep=0) == []


class TestRestore:
    def _backup(self, tmp_path: Path) -> Path:
        m = personal.export_tables(FakeSupabase(_tables()), tmp_path)
        return Path(m["dir"])

    def test_restores_in_fk_order_with_right_keys(self, tmp_path: Path):
        calls = []

        class Rep:
            succeeded = 0; failed = 0; errors = []  # noqa: E702

            def __init__(self, n): self.succeeded = n  # noqa: E704

        def upsert(table, rows, *, conflict_cols, client):
            calls.append((table, [dict(r) for r in rows], tuple(conflict_cols)))
            return Rep(len(rows))

        rep = personal.restore_tables("cli", self._backup(tmp_path), upsert=upsert)
        assert rep["ok"] is True
        order = [c[0] for c in calls]
        assert order.index("pools") < order.index("stocks")
        assert order.index("journal_opportunities") < order.index("journal_trades")
        assert order.index("expense_categories") < order.index("expenses")
        # Empty tables are skipped, present ones upserted once (categories twice).
        assert order.count("networth_assets") == 0
        assert order.count("expense_categories") == 2
        by = {}
        for t, rows, keys in calls:
            by.setdefault(t, []).append((rows, keys))
        # stocks: id dropped, natural key = symbol
        rows, keys = by["stocks"][0]
        assert keys == ("symbol",) and all("id" not in r for r in rows)
        assert by["pools"][0][1] == ("code",)
        assert by["journal_trades"][0][1] == ("id",)
        assert by["journal_trades"][0][0][0]["opportunity_id"] == 3
        # expense_categories: parents (parent_id NULL) first, then children
        (roots, _), (children, _) = by["expense_categories"]
        assert [r["id"] for r in roots] == [1]
        assert sorted(r["id"] for r in children) == [2, 3]
        assert rep["tables"]["expense_categories"]["succeeded"] == 3

    def test_dry_run_writes_nothing(self, tmp_path: Path):
        def upsert(*a, **k):
            raise AssertionError("must not be called in dry run")
        rep = personal.restore_tables("cli", self._backup(tmp_path), dry_run=True, upsert=upsert)
        assert rep["dry_run"] is True and rep["ok"] is True
        assert rep["tables"]["stocks"]["succeeded"] == 2

    def test_table_subset(self, tmp_path: Path):
        seen = []

        class Rep:
            succeeded = 1; failed = 0; errors = []  # noqa: E702

        def upsert(table, rows, *, conflict_cols, client):
            seen.append(table); return Rep()  # noqa: E702
        personal.restore_tables("cli", self._backup(tmp_path),
                                tables=personal.select_tables(["journal"]), upsert=upsert)
        assert set(seen) == {"journal_settings", "journal_opportunities", "journal_trades"}

    def test_upsert_errors_flip_ok(self, tmp_path: Path):
        class Rep:
            succeeded = 0; failed = 1; errors = ["chunk 0: 409"]  # noqa: E702

        rep = personal.restore_tables("cli", self._backup(tmp_path),
                                      tables=personal.select_tables(["watchlists"]),
                                      upsert=lambda *a, **k: Rep())
        assert rep["ok"] is False
        assert rep["tables"]["watchlists"]["errors"] == ["chunk 0: 409"]

    def test_missing_manifest_is_a_clear_error(self, tmp_path: Path):
        with pytest.raises(FileNotFoundError, match="not a Plutus backup folder"):
            personal.load_backup(tmp_path)

    def test_reset_sequences_reports_missing_rpc(self):
        class NoRpc:
            def rpc(self, name, params):
                raise RuntimeError("function plutus_reset_sequences() does not exist")
        ok, payload = personal.reset_sequences(NoRpc())
        assert ok is False and "does not exist" in payload
        sql = personal.manual_reset_sql()
        assert "journal_trades" in sql and "journal_settings" not in sql
        assert "pg_get_serial_sequence" in sql
