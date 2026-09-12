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
from plutus.sync.context import build_run_context
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
# Fetch-on-miss children get their OWN job_type so their sync_jobs row can
# never overwrite the scheduled quarterly / weekly run for the same date
# (sync_jobs upserts on (job_type, as_of_date); column is VARCHAR(30)).
ON_MISS_QUARTERLY_JOB_TYPE = "quarterly_fetch_on_miss"
ON_MISS_RATIOS_JOB_TYPE = "ratios_fetch_on_miss"


def _find_missing(symbols: Sequence[str], table: str,
                  supabase_client: Any = None) -> List[str]:
    """Symbols with NO row in `table`.

    Paginated on purpose: `fundamentals` holds ~12 quarter rows per symbol,
    and PostgREST caps a response at 1000 rows, so a single SELECT saw only
    ~80 of 437 symbols and reported the other ~350 "missing" every day
    (2026-09-12 diagnosis; see SyncLogs/ and UserData/quarterlysync.log)."""
    from plutus.adapters.supabase_client import fetch_all, get_client
    cli = supabase_client if supabase_client is not None else get_client()
    rows = fetch_all(lambda: cli.table(table).select("symbol")
                     .in_("symbol", list(symbols)).order("symbol"))
    have = {r.get("symbol") for r in rows}
    return [s for s in symbols if s not in have]


def _screener_credentials_present() -> bool:
    from plutus.fundamentals.screener_client import get_credentials
    email, password = get_credentials()
    return bool(email and password)


def enrich_missing_fundamentals(
    symbols: Sequence[str],
    *,
    supabase_client: Any = None,
    quarterly_worker: Any = None,
    ratios_worker: Any = None,
    find_missing: Any = None,
    context: Any = None,
    have_credentials: Any = None,
) -> dict:
    """Best-effort: never raises, never changes the daily sync's exit code.

    `failed_symbols` maps "<kind> <symbol>" -> error for every symbol the
    child workers could not fetch (same shape as sync_jobs.payload_json),
    so the CLI can alert on them and a human can see WHY.

    Without Screener credentials the Screener step is SKIPPED and recorded
    in `skipped` — it used to write a 350-symbol "partial" sync_jobs row
    every single day (the daily workflow did not pass the secrets)."""
    summary: dict = {"fundamentals_fetched": 0, "ratios_fetched": 0,
                     "missing_fundamentals": [], "missing_ratios": [],
                     "failed_symbols": {}, "errors": [], "skipped": None}
    finder = find_missing or _find_missing
    try:
        missing_fund = finder(symbols, "fundamentals",
                              supabase_client=supabase_client)
        missing_ratios = finder(symbols, "screener_ratios",
                                supabase_client=supabase_client)
        summary["missing_fundamentals"] = missing_fund
        summary["missing_ratios"] = missing_ratios
        if not missing_fund and not missing_ratios:
            return summary

        # Only a LIVE worker (none injected) needs Screener credentials.
        need_live = ((missing_fund and quarterly_worker is None)
                     or (missing_ratios and ratios_worker is None))
        if have_credentials is not None:
            creds_ok = bool(have_credentials)
        else:
            creds_ok = (not need_live) or _screener_credentials_present()
        if not creds_ok:
            summary["skipped"] = (
                "SCREENER_EMAIL / SCREENER_PASSWORD not configured — "
                f"{len(missing_fund)} symbols without fundamentals and "
                f"{len(missing_ratios)} without ratios were NOT fetched")
            logger.warning("fetch-on-miss skipped: %s", summary["skipped"])
            return summary

        if missing_fund:
            from plutus.sync.quarterly import QuarterlySyncWorker
            qw = quarterly_worker or QuarterlySyncWorker(
                job_type=ON_MISS_QUARTERLY_JOB_TYPE,
                run_context=dict(context) if context else None)
            qrep = qw.run_all(missing_fund)
            summary["fundamentals_fetched"] = qrep.symbols_ok
            for s in qrep.per_symbol:
                if not s.ok:
                    summary["failed_symbols"][f"fundamentals {s.symbol}"] = s.error
                    summary["errors"].append(f"fundamentals {s.symbol}: {s.error}")

        if missing_ratios:
            from plutus.sync.weekly_ratios import WeeklyRatiosWorker
            rw = ratios_worker or WeeklyRatiosWorker(
                job_type=ON_MISS_RATIOS_JOB_TYPE,
                run_context=dict(context) if context else None)
            rrep = rw.run_all(missing_ratios)
            summary["ratios_fetched"] = rrep.symbols_ok
            for s in rrep.per_symbol:
                if not s.ok:
                    summary["failed_symbols"][f"ratios {s.symbol}"] = s.error
                    summary["errors"].append(f"ratios {s.symbol}: {s.error}")
    except Exception as exc:  # noqa: BLE001 — enrichment must not break the sync
        summary["errors"].append(f"{type(exc).__name__}: {exc}")
    return summary


def enrichment_alert_report(enrichment: dict, as_of: date) -> Optional[dict]:
    """Shape the enrichment summary like a RunReport JSON so the standard
    silence-on-green hook can announce fetch-on-miss failures. They never
    change the exit code, so this alert is the ONLY signal. None = green.
    A credentials skip is reported too — silently never fetching is worse
    than one warning."""
    failed = dict(enrichment.get("failed_symbols") or {})
    generic = [e for e in (enrichment.get("errors") or [])
               if not (e.startswith("fundamentals ") or e.startswith("ratios "))]
    if enrichment.get("skipped"):
        generic.append(str(enrichment["skipped"]))
    if not failed and not generic:
        return None
    per_symbol = [{"symbol": k, "ok": False, "error": v}
                  for k, v in failed.items()]
    per_symbol += [{"symbol": "enrichment", "ok": False, "error": e}
                   for e in generic]
    ok = int(enrichment.get("fundamentals_fetched") or 0) + \
        int(enrichment.get("ratios_fetched") or 0)
    attempted = (len(enrichment.get("missing_fundamentals") or [])
                 + len(enrichment.get("missing_ratios") or []))
    return {
        "job_type": "daily_sync fetch-on-miss",
        "as_of_date": as_of.isoformat(),
        "symbols_total": max(attempted, len(per_symbol)),
        "symbols_ok": ok,
        "symbols_failed": len(per_symbol),
        "rows_written": ok,
        "duration_ms": None,
        "per_symbol": per_symbol,
        "upsert_errors": [],
    }


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

    # Fetch-on-miss (legacy cache contract): symbols with no fundamentals /
    # screener ratios yet are fetched from Screener BEFORE the price sync,
    # so the snapshot written below is stamped with fresh PE/PB/MCap and
    # the scan that follows can score them. Best-effort — never changes
    # the exit code.
    # Trigger/pool/scope context — recorded into sync_jobs.payload_json so
    # the app's Sync page can show WHO ran WHAT. Fetch-on-miss children are
    # tagged `via` so their sync_jobs rows say the daily sync spawned them.
    run_ctx = build_run_context(
        pool=args.pool,
        symbols=symbols if args.symbols else None,
    )

    enrichment: Optional[dict] = None
    if not args.dry_run and not args.no_enrich:
        enrichment = enrich_missing_fundamentals(
            symbols, context={**run_ctx, "via": "daily_sync fetch-on-miss"})
        if enrichment["errors"]:
            logger.warning("enrichment errors: %s", enrichment["errors"][:5])

    w = worker or DailySyncWorker(run_context=run_ctx)
    if worker is not None and getattr(worker, "run_context", False) is None:
        worker.run_context = run_ctx  # injected worker without a context
    report = w.run_all(symbols, as_of=as_of, dry_run=args.dry_run)

    # One-shot summary to stdout for humans + machines.
    report_json = report.as_json()
    if enrichment is not None:
        report_json["enrichment"] = enrichment

    print(json.dumps(report_json, indent=2, default=str))

    # Silence-on-green alerting. Never raises — returns None if disabled.
    # Fetch-on-miss failures never touch the exit code, so they get their
    # own alert here — otherwise they are invisible outside the Sync page.
    try:
        maybe_alert_on_run_report(report_json)
        if enrichment is not None:
            enrich_rep = enrichment_alert_report(enrichment, as_of)
            if enrich_rep is not None:
                maybe_alert_on_run_report(enrich_rep)
    except Exception as exc:  # noqa: BLE001 — alerting NEVER breaks the CLI
        logger.warning("alert dispatch skipped: %s", exc)

    if report.symbols_failed or report.upsert_errors:
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
