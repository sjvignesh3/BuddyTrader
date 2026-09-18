"""
CLI entrypoint: `python -m plutus.scripts.run_scan`

Usage:
    python -m plutus.scripts.run_scan \
        --pool F40 --as-of 2024-06-01 \
        --strategies envelope_200dma,week52_high_low \
        --triggered-by manual --dry-run

`--as-of` is an UPPER BOUND (default: today, IST). Snapshot rows are labelled
by the session they describe, so "today" has no rows before the evening sync
and none on a weekend — the scan runs on the newest session on or before it.

Exit codes:
    0 — scan completed. Per-symbol strategy errors are LOGGED, not fatal:
        one recently-listed stock without a 200-DMA must not paint the
        whole workflow red while 2,000 results landed fine.
    1 — upsert errors: computed results did NOT all reach the DB.
    2 — fatal orchestration error (bad args, no snapshots).
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, datetime, timedelta, timezone
from typing import Any, List, Optional, Sequence

from plutus.scan.engine import ScanEngine
from plutus.scan.registry import list_strategy_ids

logger = logging.getLogger("plutus.run_scan")

# The four canonical pools (matches migrations/002_pools.sql seed).
ALL_POOLS = ("F40", "E40", "S200", "PlayArea")


def _parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="run_scan", description="Plutus scan engine CLI.")
    ap.add_argument("--pool", required=True,
                    help="Pool code (F40, E40, S200, PlayArea) or ALL "
                         "to scan every pool in sequence.")
    ap.add_argument("--as-of", default=None,
                    help="Upper bound for the snapshot date (YYYY-MM-DD, "
                         "default today IST); the newest session on or "
                         "before it is scanned.")
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


def _today_ist() -> date:
    # The market's calendar, regardless of runner TZ (Actions runs in UTC).
    return datetime.now(tz=timezone(timedelta(hours=5, minutes=30))).date()


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
        as_of = _resolve_date(args.as_of) if args.as_of else _today_ist()
    except ValueError as exc:
        logger.error("bad --as-of value: %s", exc)
        return 2

    strategy_ids: Optional[List[str]] = None
    if args.strategies:
        strategy_ids = [s.strip() for s in args.strategies.split(",") if s.strip()]

    eng = engine or ScanEngine()

    # Rows are labelled by SESSION date — scan the newest one on or before
    # as_of. Engines without a resolver (test stubs) scan as_of literally.
    resolver = getattr(eng, "resolve_snapshot_date", None)
    if callable(resolver):
        resolved = resolver(as_of)
        if resolved is None:
            logger.error("no snapshots on or before %s", as_of)
            return 2
        if resolved != as_of:
            logger.info("scanning session %s (newest on or before %s)",
                        resolved, as_of)
        as_of = resolved

    # `--pool ALL` (the workflow's cron default) fans out over every pool.
    # A pool with zero snapshots is skipped with a warning; the run only
    # fails hard (exit 2) when NO pool had anything to scan.
    pools = ALL_POOLS if args.pool.upper() == "ALL" else [args.pool]

    exit_code = 0
    scanned_any = False
    reports = []
    strategy_errors = []
    for pool in pools:
        report = eng.run(
            pool_code=pool,
            snapshot_date=as_of,
            strategy_ids=strategy_ids,
            triggered_by=args.triggered_by,
            dry_run=args.dry_run,
        )
        reports.append(report.as_json())

        if report.total_stocks == 0:
            logger.warning("no snapshots found for pool=%s date=%s", pool, as_of)
            continue
        scanned_any = True
        if report.upsert_errors:
            exit_code = 1
        strategy_errors.extend(
            f"{pool}/{r.symbol}/{r.strategy_id}: {r.error}"
            for r in report.per_result if r.error)

    print(json.dumps(reports if len(reports) > 1 else reports[0],
                     indent=2, default=str))

    if strategy_errors:
        logger.warning("%d strategy evaluation error(s) — results for the "
                       "other symbols were written: %s",
                       len(strategy_errors), strategy_errors[:5])

    if not scanned_any:
        return 2
    return exit_code


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
