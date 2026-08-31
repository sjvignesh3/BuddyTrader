"""
CLI entrypoint: `python -m plutus.scripts.run_scan`

Usage:
    python -m plutus.scripts.run_scan \
        --pool F40 --as-of 2024-06-01 \
        --strategies envelope_200dma,week52_high_low \
        --triggered-by manual --dry-run

Exit codes:
    0 — scan completed with no errors.
    1 — one or more per-symbol errors OR upsert errors.
    2 — fatal orchestration error (bad args, no snapshots).
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, datetime
from typing import Any, List, Optional, Sequence

from plutus.scan.engine import ScanEngine
from plutus.scan.registry import list_strategy_ids

logger = logging.getLogger("plutus.run_scan")


def _parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="run_scan", description="Plutus scan engine CLI.")
    ap.add_argument("--pool", required=True,
                    help="Pool code (F40, E40, S200, PlayArea).")
    ap.add_argument("--as-of", required=True,
                    help="Snapshot date (YYYY-MM-DD).")
    ap.add_argument("--strategies", default=None,
                    help=("Comma-separated strategy ids to run. "
                          f"Default: all registered ({','.join(list_strategy_ids())})."))
    ap.add_argument("--triggered-by", default="manual",
                    help="'manual' | 'cron' | 'api' — recorded on the scan row.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Evaluate strategies but do not write to Supabase.")
    ap.add_argument("--verbose", action="store_true")
    return ap.parse_args(argv)


def _resolve_date(raw: str) -> date:
    return datetime.strptime(raw, "%Y-%m-%d").date()


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    engine: Optional[ScanEngine] = None,
) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    try:
        as_of = _resolve_date(args.as_of)
    except ValueError as exc:
        logger.error("bad --as-of value: %s", exc)
        return 2

    strategy_ids: Optional[List[str]] = None
    if args.strategies:
        strategy_ids = [s.strip() for s in args.strategies.split(",") if s.strip()]

    eng = engine or ScanEngine()
    report = eng.run(
        pool_code=args.pool,
        snapshot_date=as_of,
        strategy_ids=strategy_ids,
        triggered_by=args.triggered_by,
        dry_run=args.dry_run,
    )

    print(json.dumps(report.as_json(), indent=2, default=str))

    if report.total_stocks == 0:
        logger.warning("no snapshots found for pool=%s date=%s", args.pool, as_of)
        return 2
    if report.upsert_errors:
        return 1
    per_result_errors = [r for r in report.per_result if r.error]
    if per_result_errors:
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
