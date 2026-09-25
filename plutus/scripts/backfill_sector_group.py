"""
Backfill `stocks.sector_group` for rows the Universe page still shows as
"unset" — the criteria group the fundamental score branches on
(Banks / NBFC list vs the Normal list, decision 2026-09-25).

Usage:
    python -m plutus.scripts.backfill_sector_group [--dry-run] [--fetch]
        [--symbols HDFCBANK.NS,BAJFINANCE.NS] [--overwrite]

Rules (same classifier the paste / add flows use — api/universe.py):
  * industry contains "bank"                      -> Banks
  * industry in credit services / mortgage finance /
    specialty finance / consumer finance / conglomerates -> NBFC
  * any other known sector / industry             -> Normal
  * nothing known                                 -> left NULL (set it on
    the Universe page), unless --fetch pulls yfinance `.info` first.

Idempotent: only NULL groups are touched unless --overwrite is given, in
which case the classifier's answer replaces whatever is stored (manual
choices on the Universe page are lost — use it deliberately).
"""
from __future__ import annotations

import argparse
import logging
import sys
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger("plutus.backfill_sector_group")


def plan_updates(
    stocks: Sequence[Dict[str, Any]],
    *,
    overwrite: bool = False,
    fetch_info: Optional[Any] = None,
) -> List[Dict[str, Any]]:
    """Pure planner: which rows change and to what.

    Returns [{symbol, from, to, sector, industry, source}] — only rows whose
    group actually changes. `fetch_info(symbol) -> Result[dict]` fills
    sector / industry from yfinance when the stored ones are blank."""
    from plutus.api.universe import classify_sector_group, fields_from_info

    out: List[Dict[str, Any]] = []
    for s in stocks:
        symbol = s.get("symbol")
        if not symbol:
            continue
        current = s.get("sector_group")
        if current and not overwrite:
            continue
        sector, industry = s.get("sector"), s.get("industry")
        source = "stored"
        extra: Dict[str, Any] = {}
        if (not sector and not industry) and fetch_info is not None:
            try:
                res = fetch_info(symbol)
                info = (res.value or {}) if getattr(res, "ok", False) else {}
            except Exception as exc:  # noqa: BLE001 — one bad ticker must not stop the run
                logger.warning("%s: yfinance info failed: %s", symbol, exc)
                info = {}
            fetched = fields_from_info(info)
            sector = fetched.get("sector") or sector
            industry = fetched.get("industry") or industry
            for k in ("name", "sector", "industry", "cap_type_manual"):
                if fetched.get(k) and not s.get(k):
                    extra[k] = fetched[k]
            source = "yfinance"
        grp = classify_sector_group(sector, industry)
        if grp is None or grp == current:
            continue
        out.append({
            "symbol": symbol, "from": current, "to": grp,
            "sector": sector, "industry": industry, "source": source,
            **extra,
        })
    return out


def _parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="backfill_sector_group",
        description="Set stocks.sector_group (Banks | NBFC | Normal) from sector/industry.")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, write nothing")
    ap.add_argument("--fetch", action="store_true",
                    help="pull yfinance .info for rows with no stored sector/industry")
    ap.add_argument("--overwrite", action="store_true",
                    help="re-classify rows that already have a group (manual choices are replaced)")
    ap.add_argument("--symbols", default="",
                    help="comma-separated subset (canonical form, e.g. HDFCBANK.NS)")
    ap.add_argument("--verbose", "-v", action="store_true")
    return ap.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from plutus.adapters import supabase_client as sb

    cli = sb.get_client()
    rows = sb.fetch_all(
        lambda: cli.table("stocks")
                   .select("id,symbol,name,sector,industry,cap_type_manual,sector_group,active")
                   .order("symbol")
    )
    wanted = {s.strip().upper() for s in args.symbols.split(",") if s.strip()}
    if wanted:
        rows = [r for r in rows if str(r.get("symbol", "")).upper() in wanted]

    fetch = None
    if args.fetch:
        from plutus.adapters.yf_client import fetch_info as fetch
    plan = plan_updates(rows, overwrite=args.overwrite, fetch_info=fetch)

    unset_before = sum(1 for r in rows if not r.get("sector_group"))
    print(f"{len(rows)} stocks read · {unset_before} without a group · {len(plan)} to update")
    for u in plan:
        print(f"  {u['symbol']:<18} {str(u['from'] or '-'):<7} -> {u['to']:<7} "
              f"[{u['source']}] {u.get('industry') or u.get('sector') or ''}")
    if args.dry_run or not plan:
        return 0

    written = 0
    for u in plan:
        payload = {"sector_group": u["to"]}
        for k in ("name", "sector", "industry", "cap_type_manual"):
            if u.get(k):
                payload[k] = u[k]
        try:
            cli.table("stocks").update(payload).eq("symbol", u["symbol"]).execute()
            written += 1
        except Exception as exc:  # noqa: BLE001
            logger.error("%s: update failed: %s", u["symbol"], exc)
    still_unset = unset_before - sum(1 for u in plan if u["from"] is None and u["symbol"])
    print(f"updated {written}/{len(plan)} · still without a group: {max(0, still_unset)} "
          f"(set those on Market Analysis -> Universe)")
    return 0 if written == len(plan) else 1


if __name__ == "__main__":
    sys.exit(main())
