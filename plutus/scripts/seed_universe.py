"""
Seed the `stocks` universe table from the master CSV.

Usage:
    python -m plutus.scripts.seed_universe --csv path/to/master.csv [--dry-run]

CONTRACT:
  - Idempotent — re-running with the same CSV produces zero net changes.
  - Pool tags are parsed from the CSV's "Flagship 40 (F40)", "Emerging 40 (E40)",
    "Smartpick 200 (S200)" and "PlayArea" columns (any non-empty cell = member).
  - Symbols are read from the *right-hand* Ticker column of the master CSV,
    because the leftmost column is the display-list (contains cosmetic entries).
  - `metadata` JSONB captures the remaining CSV columns for lossless round-trip.
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from plutus.adapters.supabase_client import bulk_upsert
from plutus.adapters.validators import sanity_check_symbol

logger = logging.getLogger("plutus.seed_universe")

# CSV column names as they appear in the master template.
COL_TICKER = "Ticker"
COL_CAP_TYPE = "Cap Type"
COL_POOL_F40 = "Flagship 40 (F40)"
COL_POOL_E40 = "Emerging 40 (E40)"
COL_POOL_S200 = "Smartpick 200 (S200)"
COL_POOL_PLAY = "All listed"  # PlayArea membership column


def _clean(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    v = value.strip()
    return v or None


def _bool_marker(value: Optional[str]) -> bool:
    """CSV marker cells ('X', 'x', '1', 'yes') mean membership."""
    v = _clean(value)
    if not v:
        return False
    return v.lower() in {"x", "1", "y", "yes", "true"}


def parse_row(raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Convert a CSV row into a `stocks` row dict.
    Returns None for rows with no ticker (blank filler rows in the template).
    """
    ticker_raw = _clean(raw.get(COL_TICKER))
    if not ticker_raw:
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

    pools: List[str] = []
    if _bool_marker(raw.get(COL_POOL_F40)):
        pools.append("F40")
    if _bool_marker(raw.get(COL_POOL_E40)):
        pools.append("E40")
    if _bool_marker(raw.get(COL_POOL_S200)):
        pools.append("S200")
    if _bool_marker(raw.get(COL_POOL_PLAY)):
        pools.append("PlayArea")

    metadata = {
        k: v for k, v in raw.items()
        if k not in {COL_TICKER, COL_CAP_TYPE,
                     COL_POOL_F40, COL_POOL_E40,
                     COL_POOL_S200, COL_POOL_PLAY}
        and _clean(v) is not None
    }

    return {
        "symbol": symbol,
        "exchange": "NSE" if symbol.endswith(".NS") else "BSE",
        "active": True,
        "pools": pools,
        "cap_type_manual": _clean(raw.get(COL_CAP_TYPE)),
        "metadata": metadata,
    }


def load_csv(path: Path) -> List[Dict[str, Any]]:
    """Read master CSV, return list of parsed stock rows (deduped by symbol)."""
    if not path.exists():
        raise FileNotFoundError(path)

    seen: Dict[str, Dict[str, Any]] = {}
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            parsed = parse_row(row)
            if parsed is None:
                continue
            # Later duplicates overwrite earlier — CSV is authoritative bottom-up.
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
