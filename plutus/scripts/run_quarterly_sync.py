"""
CLI entrypoint: `python -m plutus.scripts.run_quarterly_sync`

Options mirror the daily sync CLI (--dry-run, --symbols, --pool, --limit).
Additionally:
    --overrides-csv <path>   apply manual ROCE/ROE/pledging CSV upload.
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from datetime import date, datetime
from typing import Any, List, Optional, Sequence

from plutus.alerts.sync_hook import maybe_alert_on_run_report
from plutus.sync.quarterly import QuarterlySyncWorker, apply_manual_overrides

logger = logging.getLogger("plutus.run_quarterly_sync")


def _load_symbols_from_db(*, pool, limit, supabase_client=None) -> List[str]:
    from plutus.adapters.supabase_client import get_client
    cli = supabase_client if supabase_client is not None else get_client()
    q = cli.table("stocks").select("symbol,pools,active").eq("active", True)
    res = q.execute()
    rows = getattr(res, "data", None) or []
    symbols = []
    for r in rows:
        if pool:
            tags = r.get("pools") or []
            if pool not in tags:
                continue
        sym = r.get("symbol")
        if sym:
            symbols.append(sym)
    if limit is not None:
        symbols = symbols[:limit]
    return symbols


def _parse_args(argv):
    ap = argparse.ArgumentParser(prog="run_quarterly_sync",
                                 description="Plutus quarterly sync worker.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--symbols", type=str, default=None)
    ap.add_argument("--pool", type=str, default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--as-of", type=str, default=None)
    ap.add_argument("--overrides-csv", type=str, default=None,
                    help="Path to a CSV with manual ROCE / ROE / pledging fixes.")
    ap.add_argument("--verbose", action="store_true")
    return ap.parse_args(argv)


def _resolve_as_of(raw):
    if raw is None:
        return date.today()
    return datetime.strptime(raw, "%Y-%m-%d").date()


def _load_csv(path: str) -> List[dict]:
    with open(path, newline="") as fh:
        return list(csv.DictReader(fh))


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    worker: Optional[QuarterlySyncWorker] = None,
    load_symbols: Any = None,
    overrides_loader: Any = None,
    overrides_applier: Any = None,
) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    # Overrides-only mode: no yfinance fetch needed.
    if args.overrides_csv and not args.symbols and not args.pool:
        loader = overrides_loader or _load_csv
        applier = overrides_applier or apply_manual_overrides
        try:
            rows = loader(args.overrides_csv)
        except Exception as exc:
            logger.error("overrides CSV read failed: %s", exc)
            return 2
        result = applier(rows)
        print(json.dumps(result, indent=2, default=str))
        return 0 if not result["errors"] else 1

    if args.symbols:
        symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    else:
        loader = load_symbols or _load_symbols_from_db
        try:
            symbols = loader(pool=args.pool, limit=args.limit)
        except Exception as exc:
            logger.error("symbol load failed: %s", exc)
            return 2

    if not symbols:
        logger.error("no symbols to sync")
        return 2

    as_of = _resolve_as_of(args.as_of)
    w = worker or QuarterlySyncWorker()
    report = w.run_all(symbols, as_of=as_of, dry_run=args.dry_run)

    # Optionally chain override CSV after the yfinance pass.
    if args.overrides_csv:
        loader = overrides_loader or _load_csv
        applier = overrides_applier or apply_manual_overrides
        try:
            rows = loader(args.overrides_csv)
            _ = applier(rows)
        except Exception as exc:
            logger.warning("overrides step failed: %s", exc)

    report_json = report.as_json()
    print(json.dumps(report_json, indent=2, default=str))

    try:
        maybe_alert_on_run_report(report_json)
    except Exception as exc:  # noqa: BLE001
        logger.warning("alert dispatch skipped: %s", exc)

    if report.symbols_failed or report.upsert_errors:
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
