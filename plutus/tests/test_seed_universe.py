"""
Seed universe tests — CSV parsing only, no network / no Supabase.

The real master CSV has redundant columns; the parser must:
  - skip empty ticker rows
  - dedupe symbols
  - auto-append .NS if missing
  - detect pool memberships from marker columns
  - preserve extra columns in metadata JSONB
"""
from __future__ import annotations

import csv
from pathlib import Path

import pytest

from plutus.scripts import seed_universe as su


HEADERS = [
    "Ticker",
    "Cap Type",
    "Flagship 40 (F40)",
    "Emerging 40 (E40)",
    "Smartpick 200 (S200)",
    "All listed",
    "Priority",
    "Volatility",
]


def _write_csv(path: Path, rows):
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=HEADERS)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def test_parse_row_valid_full(tmp_path: Path) -> None:
    parsed = su.parse_row({
        "Ticker": "reliance",
        "Cap Type": "Large Cap",
        "Flagship 40 (F40)": "X",
        "Emerging 40 (E40)": "",
        "Smartpick 200 (S200)": "",
        "All listed": "X",
        "Priority": "First",
        "Volatility": "Low",
    })
    assert parsed is not None
    assert parsed["symbol"] == "RELIANCE.NS"
    assert parsed["exchange"] == "NSE"
    assert parsed["active"] is True
    assert parsed["cap_type_manual"] == "Large Cap"
    assert set(parsed["pools"]) == {"F40", "PlayArea"}
    assert parsed["metadata"]["Priority"] == "First"


def test_parse_row_blank_ticker_returns_none() -> None:
    assert su.parse_row({"Ticker": "", "Cap Type": "x"}) is None
    assert su.parse_row({"Ticker": None}) is None


def test_parse_row_invalid_ticker_returns_none() -> None:
    # Weird characters -> validator raises inside parse_row -> None
    assert su.parse_row({"Ticker": "!!bad!!"}) is None


def test_parse_row_appends_ns_suffix() -> None:
    parsed = su.parse_row({"Ticker": "TCS"})
    assert parsed["symbol"] == "TCS.NS"


def test_parse_row_preserves_bo_suffix() -> None:
    parsed = su.parse_row({"Ticker": "500325.BO"})
    assert parsed["symbol"] == "500325.BO"
    assert parsed["exchange"] == "BSE"


def test_load_csv_dedupes(tmp_path: Path) -> None:
    csv_path = tmp_path / "u.csv"
    _write_csv(csv_path, [
        {"Ticker": "RELIANCE", "Flagship 40 (F40)": "X",
         "Emerging 40 (E40)": "", "Smartpick 200 (S200)": "",
         "All listed": "", "Cap Type": "Large", "Priority": "1", "Volatility": ""},
        {"Ticker": "RELIANCE", "Flagship 40 (F40)": "",
         "Emerging 40 (E40)": "X", "Smartpick 200 (S200)": "",
         "All listed": "", "Cap Type": "Large", "Priority": "2", "Volatility": ""},
        {"Ticker": "TCS", "Flagship 40 (F40)": "X",
         "Emerging 40 (E40)": "", "Smartpick 200 (S200)": "",
         "All listed": "", "Cap Type": "Large", "Priority": "3", "Volatility": ""},
    ])
    rows = su.load_csv(csv_path)
    assert len(rows) == 2
    symbols = {r["symbol"] for r in rows}
    assert symbols == {"RELIANCE.NS", "TCS.NS"}
    # Later duplicate wins -> RELIANCE ends up in E40, not F40
    reliance = next(r for r in rows if r["symbol"] == "RELIANCE.NS")
    assert reliance["pools"] == ["E40"]


def test_load_csv_skips_blanks(tmp_path: Path) -> None:
    csv_path = tmp_path / "u.csv"
    _write_csv(csv_path, [
        {"Ticker": "", "Cap Type": "", "Flagship 40 (F40)": "",
         "Emerging 40 (E40)": "", "Smartpick 200 (S200)": "",
         "All listed": "", "Priority": "", "Volatility": ""},
        {"Ticker": "INFY", "Cap Type": "Large", "Flagship 40 (F40)": "X",
         "Emerging 40 (E40)": "", "Smartpick 200 (S200)": "",
         "All listed": "", "Priority": "", "Volatility": ""},
    ])
    rows = su.load_csv(csv_path)
    assert [r["symbol"] for r in rows] == ["INFY.NS"]


def test_run_dry_run_no_network(tmp_path: Path) -> None:
    csv_path = tmp_path / "u.csv"
    _write_csv(csv_path, [
        {"Ticker": "INFY", "Cap Type": "Large", "Flagship 40 (F40)": "X",
         "Emerging 40 (E40)": "", "Smartpick 200 (S200)": "",
         "All listed": "", "Priority": "", "Volatility": ""},
    ])
    summary = su.run(csv_path, dry_run=True)
    assert summary["dry_run"] is True
    assert summary["row_count"] == 1
    assert summary["sample"][0]["symbol"] == "INFY.NS"


def test_load_csv_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        su.load_csv(tmp_path / "nope.csv")
