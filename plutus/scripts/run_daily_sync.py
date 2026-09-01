"""
CLI entrypoint: `python -m plutus.scripts.run_daily_sync`

Options:
    --dry-run          : compute everything, write nothing.
    --symbols A,B,C    : sync just these tickers (bypasses DB lookup).
    --pool F40         : filter universe to a pool tag.
    --limit N          : cap the number of symbols processed.
    --as-of YYYY-MM-DD : override snapshot_date (default = today, IST).

Exit codes:
    0 — all symbols succeeded (or dry-run completed).
    1 — one or more per-symbol failures.
    2 — a fatal orchestration error (bad args, no symbols, etc.).
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, datetime
from typing import Any, List, Optional, Sequence

from plutus.alerts.sync_hook import maybe_alert_on_run_report
from plutus.sync.worker import DailySyncWorker

logger = logging.getLogger("plutus.run_daily_sync")


# ---------------------------------------------------------------------------
# Symbol loading — dependency-injected for tests
# ---------------------------------------------------------------------------
def _load_symbols_from_db(
    *,
    pool: Optional[str],
    limit: Optional[int],
    supabase_client: Any = None,
) -> List[str]:
    """Read active symbols from the `stocks` table."""
    from plutus.adapters.supabase_client import get_client

    cli = supabase_client if supabase_client is not None else get_client()
    q = cli.table("stocks").select("symbol,pools,active").eq("active", True)
    res = q.execute()
    rows = getattr(res, "data", None) or []
    symbols: List[str] = []
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


def _parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="run_daily_sync",
                                 description="Plutus daily sync worker.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute snapshots but do not write to Supabase.")
    ap.add_argument("--symbols", type=str, default=None,
                    help="Comma-separated tickers to sync (bypass DB lookup).")
    ap.add_argument("--pool", type=str, default=None,
                    help="Filter universe to a pool tag (F40, E40, S200, PlayArea).")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap number of symbols processed.")
    ap.add_argument("--as-of", type=str, default=None,
                    help="Override snapshot date (YYYY-MM-DD).")
    ap.add_argument("--no-enrich", action="store_true",
                    help="Skip the fetch-on-miss Screener enrichment for "
                         "symbols with no fundamentals / ratios in the DB.")
    ap.add_argument("--verbose", action="store_true")
    return ap.parse_args(argv)


# ---------------------------------------------------------------------------
# Fetch-on-miss enrichment — the legacy BuddyTrader cache contract:
# "only symbols NOT yet in the cache are fetched live". Any symbol that just
# synced but has NO fundamentals row / NO screener_ratios row is fetched
# from Screener.in right now, so a fresh PlayArea addition (or newly seeded
# stock) is fully scored by the scan step that follows this CLI.
# ---------------------------------------------------------------------------
def _find_missing(symbols: Sequence[str], table: str,
                  supabase_client: Any = None) -> List[str]:
    from plutus.adapters.supabase_client import get_client
    cli = supabase_client if supabase_client is not None else get_client()
    res = (cli.table(table).select("symbol")
           .in_("symbol", list(symbols)).execute())
    have = {r.get("symbol") for r in (getattr(res, "data", None) or [])}
    return [s for s in symbols if s not in have]


def enrich_missing_fundamentals(
    symbols: Sequence[str],
    *,
    supabase_client: Any = None,
    quarterly_worker: Any = None,
    ratios_worker: Any = None,
    find_missing: Any = None,
) -> dict:
    """Best-effort: never raises, never changes the daily sync's exit code."""
    summary: dict = {"fundamentals_fetched": 0, "ratios_fetched": 0,
                     "missing_fundamentals": [], "missing_ratios": [],
                     "errors": []}
    finder = find_missing or _find_missing
    try:
        missing_fund = finder(symbols, "fundamentals",
                              supabase_client=supabase_client)
        missing_ratios = finder(symbols, "screener_ratios",
                                supabase_client=supabase_client)
        summary["missing_fundamentals"] = missing_fund
        summary["missing_ratios"] = missing_ratios

        if missing_fund:
            from plutus.sync.quarterly import QuarterlySyncWorker
            qw = quarterly_worker or QuarterlySyncWorker()
            qrep = qw.run_all(missing_fund)
            summary["fundamentals_fetched"] = qrep.symbols_ok
            summary["errors"].extend(
                f"fundamentals {s.symbol}: {s.error}"
                for s in qrep.per_symbol if not s.ok)

        if missing_ratios:
            from plutus.sync.weekly_ratios import WeeklyRatiosWorker
            rw = ratios_worker or WeeklyRatiosWorker()
            rrep = rw.run_all(missing_ratios)
            summary["ratios_fetched"] = rrep.symbols_ok
            summary["errors"].extend(
                f"ratios {s.symbol}: {s.error}"
                for s in rrep.per_symbol if not s.ok)
    except Exception as exc:  # noqa: BLE001 — enrichment must not break the sync
        summary["errors"].append(f"{type(exc).__name__}: {exc}")
    return summary


def _resolve_as_of(raw: Optional[str]) -> date:
    if raw is None:
        # "Today" in IST — the market's calendar — regardless of runner TZ
        # (GitHub Actions runs in UTC; 18:30+ IST would otherwise date-shift).
        from datetime import timedelta, timezone
        ist = timezone(timedelta(hours=5, minutes=30))
        return datetime.now(tz=ist).date()
    return datetime.strptime(raw, "%Y-%m-%d").date()


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    worker: Optional[DailySyncWorker] = None,
    load_symbols: Any = None,
) -> int:
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
        logger.error("no symbols to sync (pool=%s limit=%s)",
                     args.pool, args.limit)
        return 2

    as_of = _resolve_as_of(args.as_of)

    # Wire PLUTUS_YF_TIMEOUT_SECONDS into yfinance's HTTP session so a hung
    # Yahoo socket cannot stall the whole run. Best-effort — a failure here
    # must not block the sync.
    try:
        from plutus.adapters.yf_client import apply_session_timeout
        apply_session_timeout()
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not apply yfinance session timeout: %s", exc)

    w = worker or DailySyncWorker()
    report = w.run_all(symbols, as_of=as_of, dry_run=args.dry_run)

    # One-shot summary to stdout for humans + machines.
    report_json = report.as_json()

    # Fetch-on-miss (legacy cache contract): symbols that synced OK but have
    # no fundamentals / screener ratios yet are fetched from Screener now,
    # so the scan that follows can score them. Best-effort — never changes
    # the exit code.
    if not args.dry_run and not args.no_enrich:
        ok_symbols = [s.symbol for s in report.per_symbol if s.ok]
        if ok_symbols:
            enrichment = enrich_missing_fundamentals(ok_symbols)
            report_json["enrichment"] = enrichment
            if enrichment["errors"]:
                logger.warning("enrichment errors: %s", enrichment["errors"][:5])

    print(json.dumps(report_json, indent=2, default=str))

    # Silence-on-green alerting. Never raises — returns None if disabled.
    try:
        maybe_alert_on_run_report(report_json)
    except Exception as exc:  # noqa: BLE001 — alerting NEVER breaks the CLI
        logger.warning("alert dispatch skipped: %s", exc)

    if report.symbols_failed or report.upsert_errors:
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
