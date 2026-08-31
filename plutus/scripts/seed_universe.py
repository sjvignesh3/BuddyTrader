"""
Seed the `stocks` universe table from the master CSV.

Usage:
    python -m plutus.scripts.seed_universe --csv path/to/master.csv [--dry-run]

CONTRACT:
  - Idempotent — re-running with the same CSV produces zero net changes.
  - The master template holds THREE side-by-side tables. The curated
    universe is the LEFT-HAND table (columns 0-5):
        0 List (symbol) | 1 Sector | 2 Short Form (pool code) |
        3 Category (pool name) | 4 For TV | 5 Market Cap (cap type)
    This matches the legacy loader `backend/app/core/universe.py`. The
    right-hand "Ticker" column is the ALL-LISTED NSE dump (~4800 rows) and
    the "Flagship 40 (F40)"/"Emerging 40 (E40)"/... marker columns belong
    to the strategy × pool matrix — neither describes the curated universe.
  - A symbol appearing under several pools gets ALL of them merged into
    its `pools` array.
  - `metadata` JSONB captures the remaining left-table columns.
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from plutus.adapters.supabase_client import bulk_upsert
from plutus.adapters.validators import sanity_check_symbol

logger = logging.getLogger("plutus.seed_universe")

# Left-table positional columns (the header names collide across the three
# side-by-side tables, so positional access is the only reliable parse).
IDX_SYMBOL = 0     # "List"
IDX_SECTOR = 1     # "Sector"
IDX_POOL = 2       # "Short Form"  — F40 / E40 / S200
IDX_POOL_NAME = 3  # "Category"
IDX_FOR_TV = 4     # "For TV"
IDX_CAP_TYPE = 5   # "Market Cap"  — manual cap classification

KNOWN_POOLS = {"F40", "E40", "S200", "PlayArea"}


def _clean(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    v = value.strip()
    return v or None


def parse_row(cells: Sequence[str]) -> Optional[Dict[str, Any]]:
    """
    Convert one positional CSV row (left table) into a `stocks` row dict.
    Returns None for blank filler rows or rows without a pool code.
    """
    if len(cells) < 6:
        return None
    ticker_raw = _clean(cells[IDX_SYMBOL])
    pool_code = _clean(cells[IDX_POOL])
    if not ticker_raw or not pool_code:
        return None
    if pool_code not in KNOWN_POOLS:
        logger.warning("skipping row with unknown pool code %r (symbol %r)",
                       pool_code, ticker_raw)
        return None

    # Accept 'RELIANCE' or 'RELIANCE.NS' from CSV; store canonical (with .NS)
    # in `symbol` since that's what yfinance needs. Frontend can strip suffix.
    ticker = ticker_raw.upper()
    if not ticker.endswith((".NS", ".BO")):
        ticker = f"{ticker}.NS"
    try:
        symbol = sanity_check_symbol(ticker)
    except ValueError as exc:
        logger.warning("skipping invalid ticker %r: %s", ticker_raw, exc)
        return None

    metadata: Dict[str, Any] = {}
    pool_name = _clean(cells[IDX_POOL_NAME])
    if pool_name:
        metadata["pool_name"] = pool_name
    for_tv = _clean(cells[IDX_FOR_TV])
    if for_tv:
        metadata["for_tv"] = for_tv

    return {
        "symbol": symbol,
        "sector": _clean(cells[IDX_SECTOR]),
        "exchange": "NSE" if symbol.endswith(".NS") else "BSE",
        "active": True,
        "pools": [pool_code],
        "cap_type_manual": _clean(cells[IDX_CAP_TYPE]),
        "metadata": metadata,
    }


def load_csv(path: Path) -> List[Dict[str, Any]]:
    """Read master CSV, return list of parsed stock rows.

    Duplicate symbols MERGE their pool arrays (a stock can belong to several
    pools); the latest row wins for the scalar columns.
    """
    if not path.exists():
        raise FileNotFoundError(path)

    seen: Dict[str, Dict[str, Any]] = {}
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        next(reader, None)  # header row
        for cells in reader:
            parsed = parse_row(cells)
            if parsed is None:
                continue
            prior = seen.get(parsed["symbol"])
            if prior is not None:
                # Merge pools; keep the FIRST row's scalar columns — the
                # earlier (F40/E40) sections carry the curated sector names,
                # later S200 rows hold volatility labels in that column.
                prior["pools"] = list(dict.fromkeys(prior["pools"] + parsed["pools"]))
            else:
                seen[parsed["symbol"]] = parsed
    return list(seen.values())


def run(csv_path: Path, *, dry_run: bool = False) -> Dict[str, Any]:
    rows = load_csv(csv_path)
    logger.info("parsed %d unique stock rows from %s", len(rows), csv_path)

    if dry_run:
        return {
            "dry_run": True,
            "row_count": len(rows),
            "sample": rows[:3],
        }

    report = bulk_upsert(
        table="stocks",
        rows=rows,
        conflict_cols=["symbol"],
    )
    return {
        "dry_run": False,
        "row_count": len(rows),
        "succeeded": report.succeeded,
        "failed": report.failed,
        "errors": report.errors,
        "latency_ms": report.latency_ms,
    }


def _cli() -> int:
    parser = argparse.ArgumentParser(description="Seed the Plutus stocks universe.")
    parser.add_argument("--csv", required=True, type=Path,
                        help="Path to the master template CSV.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse & print sample rows without writing to Supabase.")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
    )

    try:
        summary = run(args.csv, dry_run=args.dry_run)
    except Exception as exc:  # noqa: BLE001 — CLI boundary
        logger.error("seed_universe failed: %s", exc, exc_info=True)
        return 1

    print(json.dumps(summary, indent=2, default=str))
    return 0 if summary.get("failed", 0) == 0 else 2


if __name__ == "__main__":
    sys.exit(_cli())
