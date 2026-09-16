"""
Seed universe tests — CSV parsing only, no network / no Supabase.

The master template holds three side-by-side tables; the curated universe
is the LEFT-HAND table (positional columns 0-5, matching the legacy
Buddy universe loader):

    0 List (symbol) | 1 Sector | 2 Short Form (pool code) |
    3 Category (pool name) | 4 For TV | 5 Market Cap (cap type)

The parser must:
  - skip blank-symbol and blank-pool rows
  - MERGE pools when a symbol appears under several pools
  - keep the FIRST row's scalar columns on merge
  - auto-append .NS if missing
  - store sector / cap type / metadata
"""
from __future__ import annotations

import csv
from pathlib import Path

import pytest

from plutus.scripts import seed_universe as su


HEADER = ["List", "Sector", "Short Form", "Category", "For TV", "Market Cap"]


def _row(symbol="", sector="", pool="", category="", for_tv="", cap=""):
    return [symbol, sector, pool, category, for_tv, cap]


def _write_csv(path: Path, rows):
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(HEADER)
        for r in rows:
            w.writerow(r)


def test_parse_row_valid_full() -> None:
    parsed = su.parse_row(
        _row("reliance", "ENERGY", "F40", "Flagship 40", "RELIANCE,", "Large Cap"))
    assert parsed is not None
    assert parsed["symbol"] == "RELIANCE.NS"
    assert parsed["exchange"] == "NSE"
    assert parsed["active"] is True
    assert parsed["sector"] == "ENERGY"
    assert parsed["cap_type_manual"] == "Large Cap"
    assert parsed["pools"] == ["F40"]
    assert parsed["metadata"]["pool_name"] == "Flagship 40"


def test_parse_row_blank_symbol_returns_none() -> None:
    assert su.parse_row(_row("", "X", "F40")) is None
    assert su.parse_row(_row("RELIANCE", "X", "")) is None  # no pool code
    assert su.parse_row([]) is None


def test_parse_row_unknown_pool_returns_none() -> None:
    assert su.parse_row(_row("RELIANCE", "ENERGY", "NOTAPOOL")) is None


def test_parse_row_invalid_ticker_returns_none() -> None:
    # Weird characters -> validator raises inside parse_row -> None
    assert su.parse_row(_row("!!bad!!", "X", "F40")) is None


def test_parse_row_appends_ns_suffix() -> None:
    parsed = su.parse_row(_row("TCS", "IT", "F40"))
    assert parsed["symbol"] == "TCS.NS"


def test_parse_row_preserves_bo_suffix() -> None:
    parsed = su.parse_row(_row("500325.BO", "ENERGY", "S200"))
    assert parsed["symbol"] == "500325.BO"
    assert parsed["exchange"] == "BSE"


def test_load_csv_merges_pools_for_duplicate_symbol(tmp_path: Path) -> None:
    csv_path = tmp_path / "u.csv"
    _write_csv(csv_path, [
        _row("RELIANCE", "ENERGY", "F40", "Flagship 40", "", "Large Cap"),
        _row("RELIANCE", "Normal", "S200", "Smartpick 200", "", "Large Cap"),
        _row("TCS", "IT", "F40", "Flagship 40", "", "Large Cap"),
    ])
    rows = su.load_csv(csv_path)
    assert len(rows) == 2
    reliance = next(r for r in rows if r["symbol"] == "RELIANCE.NS")
    # Pools merge; the FIRST row's scalars win (S200 rows carry volatility
    # labels in the Sector column, not real sectors).
    assert reliance["pools"] == ["F40", "S200"]
    assert reliance["sector"] == "ENERGY"


def test_load_csv_skips_blanks(tmp_path: Path) -> None:
    csv_path = tmp_path / "u.csv"
    _write_csv(csv_path, [
        _row(),                                   # fully blank filler
        _row("INFY", "IT", "F40", "Flagship 40"),
    ])
    rows = su.load_csv(csv_path)
    assert [r["symbol"] for r in rows] == ["INFY.NS"]


def test_run_dry_run_no_network(tmp_path: Path) -> None:
    csv_path = tmp_path / "u.csv"
    _write_csv(csv_path, [
        _row("INFY", "IT", "F40", "Flagship 40", "", "Large Cap"),
    ])
    summary = su.run(csv_path, dry_run=True)
    assert summary["dry_run"] is True
    assert summary["row_count"] == 1
    assert summary["sample"][0]["symbol"] == "INFY.NS"


def test_load_csv_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        su.load_csv(tmp_path / "nope.csv")


def test_real_master_csv_parses_curated_universe() -> None:
    """Against the actual repo CSV: the curated universe is ~440+ unique
    symbols across F40/E40/S200 — NOT the ~4800-row all-listed dump."""
    path = Path(__file__).resolve().parents[2] / "UserData" / "Vicky - Master Template - Master.csv"
    if not path.exists():
        pytest.skip("master CSV not present")
    rows = su.load_csv(path)
    assert 300 < len(rows) < 1000, f"unexpected universe size {len(rows)}"
    pools = {p for r in rows for p in r["pools"]}
    assert {"F40", "E40", "S200"} <= pools
