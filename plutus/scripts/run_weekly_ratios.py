"""
CLI entrypoint: `python -m plutus.scripts.run_weekly_ratios`

Fetches Screener.in valuation ratios (PE / PB / Market Cap) for the active
universe into the `screener_ratios` table. Scheduled Saturday 05:00 IST;
the daily sync stamps the stored values into every day's snapshot.

Options mirror the other sync CLIs: --dry-run, --symbols, --pool, --limit.

Exit codes: 0 ok · 1 per-symbol/upsert failures · 2 orchestration error.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import Any, List, Optional, Sequence

from plutus.alerts.sync_hook import maybe_alert_on_run_report
from plutus.sync.context import build_run_context
from plutus.sync.weekly_ratios import WeeklyRatiosWorker

logger = logging.getLogger("plutus.run_weekly_ratios")


def _load_symbols_from_db(*, pool, limit, supabase_client=None) -> List[str]:
    from plutus.adapters.supabase_client import get_client
    cli = supabase_client if supabase_client is not None else get_client()
    res = cli.table("stocks").select("symbol,pools,active").eq("active", True).execute()
    rows = getattr(res, "data", None) or []
    symbols = []
    for r in rows:
        if pool and pool not in (r.get("pools") or []):
            continue
        if r.get("symbol"):
            symbols.append(r["symbol"])
    return symbols[:limit] if limit is not None else symbols


def _parse_args(argv):
    ap = argparse.ArgumentParser(prog="run_weekly_ratios",
                                 description="Plutus weekly Screener ratios sync.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--symbols", type=str, default=None)
    ap.add_argument("--pool", type=str, default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--verbose", action="store_true")
    return ap.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None, *,
         worker: Optional[WeeklyRatiosWorker] = None,
         load_symbols: Any = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.symbols:
        symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
        if args.limit is not None:
            symbols = symbols[:args.limit]
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

    run_ctx = build_run_context(
        pool=args.pool,
        symbols=symbols if args.symbols else None,
    )
    w = worker or WeeklyRatiosWorker(run_context=run_ctx)
    if worker is not None and getattr(worker, "run_context", False) is None:
        worker.run_context = run_ctx  # injected worker without a context
    report = w.run_all(symbols, dry_run=args.dry_run)

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
