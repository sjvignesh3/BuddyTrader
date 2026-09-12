"""
Scan Engine — Plutus Stage 6 orchestrator.

Reads daily_snapshots (already computed by Stage 4), applies one or more
strategies to each snapshot in a pool, and writes:

  * one row to `scans`         (audit trail — one per pool+date+trigger)
  * many rows to `scan_results` (one per (symbol, strategy_id))

Contract:
  * `run(pool, snapshot_date, strategy_ids, triggered_by)` — never raises.
  * Dry-run mode: computes everything, writes nothing.
  * Idempotent same-day rerun: (pool_code, snapshot_date, triggered_by)
    conflict cols on `scans`; scan_results are re-inserted after old ones
    are deleted (cascade via scan_id).
  * All numeric values fed to strategies are Decimal — no float in flight.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass, field as dc_field
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

from plutus.adapters import supabase_client as sb
from plutus.registry.fields import fields_for
from plutus.registry.types import to_decimal
from plutus.scan.base import (
    STATUS_BUY_ZONE,
    STATUS_OPPORTUNITY,
    STATUS_PASS,
    STATUS_VALID,
    ScanContext,
    Strategy,
    StrategyResult,
)
from plutus.scan.registry import get_strategy, list_strategy_ids

logger = logging.getLogger(__name__)

# --- Tables and conflict cols -------------------------------------------------
SCANS_TABLE = "scans"
SCANS_CONFLICT = ("pool_code", "snapshot_date", "triggered_by")
SCAN_RESULTS_TABLE = "scan_results"

OPPORTUNITY_STATUSES = frozenset({
    STATUS_BUY_ZONE, STATUS_OPPORTUNITY, STATUS_VALID, STATUS_PASS,
})

# Known fundamentals-tier columns that engine merges into the snapshot row
# so the FundamentalScreenerStrategy can read them without extra joins.
FUNDAMENTAL_MERGE_COLS = (
    "roce", "roe", "net_debt_to_equity", "promoter_pledging_pct",
    "pe_5y_avg", "pb_5y_avg", "promoter_holding_pct",
)

# Quarter-history aggregates computed by _default_fetch_fundamentals and
# merged alongside FUNDAMENTAL_MERGE_COLS — inputs to the 11-check score's
# ATH rules and the YoY same-quarter (cyclicality-aware) rule.
FUNDAMENTAL_AGG_COLS = (
    "latest_q_sales", "latest_q_pbt", "latest_q_net_profit",
    "ath_q_sales", "ath_q_pbt", "ath_q_net_profit",
    "yoy_q_net_profit", "prev_q_net_profit", "yoy_quarter_label",
)


def _quarter_month_year(q: Any) -> "Optional[tuple]":
    """quarter_end_date arrives as datetime.date locally but as an ISO
    string from PostgREST — normalise to (year, month)."""
    if q is None:
        return None
    if hasattr(q, "year") and hasattr(q, "month"):
        return (q.year, q.month)
    s = str(q)
    try:
        return (int(s[0:4]), int(s[5:7]))
    except (ValueError, IndexError):
        return None


def _quarter_aggregates(rows_newest_first: "List[Dict[str, Any]]") -> "Dict[str, Any]":
    """Latest + all-time-high quarterly figures across every stored quarter,
    plus the SAME QUARTER LAST YEAR's net profit (YoY comparison — a
    seasonally-low latest quarter must not sink a cyclic business)."""
    def _series(key: str) -> "List[Decimal]":
        return [r[key] for r in rows_newest_first
                if isinstance(r.get(key), Decimal)]

    sales = _series("sales")
    pbt = _series("pbt")
    np_ = _series("net_profit")

    # YoY: the quarter with the same month, one year before the latest.
    yoy_np: Optional[Decimal] = None
    yoy_label: Optional[str] = None
    prev_np: Optional[Decimal] = None
    latest_ym = _quarter_month_year(
        rows_newest_first[0].get("quarter_end_date")) if rows_newest_first else None
    if latest_ym is not None:
        target = (latest_ym[0] - 1, latest_ym[1])
        for r in rows_newest_first[1:]:
            if _quarter_month_year(r.get("quarter_end_date")) == target \
               and isinstance(r.get("net_profit"), Decimal):
                yoy_np = r["net_profit"]
                yoy_label = r.get("quarter_label") or f"{target[1]:02d}/{target[0]}"
                break
    if len(rows_newest_first) > 1 and isinstance(
            rows_newest_first[1].get("net_profit"), Decimal):
        prev_np = rows_newest_first[1]["net_profit"]

    return {
        "latest_q_sales": sales[0] if sales else None,
        "latest_q_pbt": pbt[0] if pbt else None,
        "latest_q_net_profit": np_[0] if np_ else None,
        "ath_q_sales": max(sales) if sales else None,
        "ath_q_pbt": max(pbt) if pbt else None,
        "ath_q_net_profit": max(np_) if np_ else None,
        "yoy_q_net_profit": yoy_np,
        "prev_q_net_profit": prev_np,
        "yoy_quarter_label": yoy_label,
    }


# ---------------------------------------------------------------------------
# Report types
# ---------------------------------------------------------------------------
@dataclass
class SymbolStrategyReport:
    symbol: str
    strategy_id: str
    status: str
    score: int
    opportunity: bool
    error: Optional[str] = None

    def as_json(self) -> Dict[str, Any]:
        return {
            "symbol": self.symbol,
            "strategy_id": self.strategy_id,
            "status": self.status,
            "score": self.score,
            "opportunity": self.opportunity,
            "error": self.error,
        }


@dataclass
class ScanReport:
    scan_id: Optional[str]
    pool_code: str
    snapshot_date: date
    triggered_by: str
    dry_run: bool
    started_at: datetime
    finished_at: datetime
    strategy_ids: List[str]
    total_stocks: int
    opportunities_count: int
    result_rows_written: int
    per_result: List[SymbolStrategyReport] = dc_field(default_factory=list)
    upsert_errors: List[str] = dc_field(default_factory=list)

    @property
    def duration_seconds(self) -> Decimal:
        secs = (self.finished_at - self.started_at).total_seconds()
        return Decimal(str(round(secs, 2)))

    def as_json(self) -> Dict[str, Any]:
        return {
            "scan_id": self.scan_id,
            "pool_code": self.pool_code,
            "snapshot_date": self.snapshot_date.isoformat(),
            "triggered_by": self.triggered_by,
            "dry_run": self.dry_run,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat(),
            "duration_seconds": str(self.duration_seconds),
            "strategy_ids": list(self.strategy_ids),
            "total_stocks": self.total_stocks,
            "opportunities_count": self.opportunities_count,
            "result_rows_written": self.result_rows_written,
            "upsert_errors": list(self.upsert_errors),
            "per_result": [r.as_json() for r in self.per_result],
        }


# ---------------------------------------------------------------------------
# Registry-driven projection helpers
# ---------------------------------------------------------------------------
def _registry_cols(table: str) -> tuple[str, ...]:
    """Return the tuple of column names declared for `table`."""
    return tuple(f.name for f in fields_for(table))


def _project(row: Dict[str, Any], known_cols: Sequence[str]) -> Dict[str, Any]:
    """Drop any keys not present in the registry-declared column list."""
    return {k: v for k, v in row.items() if k in known_cols}


def _json_safe(value: Any) -> Any:
    """Recursively coerce Decimals -> str for JSONB payload safety."""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
@dataclass
class ScanEngine:
    """Orchestrates one scan run for one (pool, date, trigger) tuple."""

    supabase_client: Any = None                          # injected supabase.Client
    fetch_snapshots: Optional[Callable[..., List[Dict[str, Any]]]] = None
    fetch_fundamentals: Optional[Callable[..., Dict[str, Dict[str, Any]]]] = None
    upsert: Callable[..., Any] = sb.bulk_upsert
    insert_scan: Optional[Callable[..., Optional[str]]] = None

    # ---- Snapshot loader (dep-injected for tests) -------------------------
    def _default_fetch_snapshots(
        self, pool_code: str, snapshot_date: date
    ) -> List[Dict[str, Any]]:
        """
        Read active symbols from `stocks` tagged with `pool_code`, join to
        their `daily_snapshots` row for `snapshot_date`. Returns a list of
        dicts already normalised to Decimals.

        Tests inject a stub via `fetch_snapshots=...` on construction.
        """
        cli = self.supabase_client or sb.get_client()

        # Fetch the pool universe first.
        stocks_res = (
            cli.table("stocks")
               .select("id,symbol,pools,active,sector")
               .eq("active", True)
               .execute()
        )
        stock_rows = getattr(stocks_res, "data", None) or []
        pool_symbols = [
            r["symbol"] for r in stock_rows
            if pool_code in (r.get("pools") or [])
        ]
        symbol_to_stock_id = {
            r["symbol"]: r.get("id") for r in stock_rows
        }
        if not pool_symbols:
            return []

        snap_res = (
            cli.table("daily_snapshots")
               .select("*")
               .in_("symbol", pool_symbols)
               .eq("snapshot_date", snapshot_date.isoformat())
               .execute()
        )
        snap_rows = getattr(snap_res, "data", None) or []
        # Attach stock_id (used for scan_results FK).
        for r in snap_rows:
            r.setdefault("stock_id", symbol_to_stock_id.get(r.get("symbol")))
            # Normalise numeric strings back to Decimal (Supabase returns str for NUMERIC).
            self._normalise_decimals(r)
        return snap_rows

    def _default_fetch_fundamentals(
        self, symbols: Sequence[str]
    ) -> Dict[str, Dict[str, Any]]:
        """Per-symbol fundamentals for the screener strategy.

        Returns the LATEST row's quality metrics PLUS quarter-history
        aggregates (latest / all-time-high quarterly Sales, PBT, Net Profit
        and latest / average OPM) that power the BuddyTrader 11-check
        fundamental score's ATH rules."""
        if not symbols:
            return {}
        cli = self.supabase_client or sb.get_client()
        cols = ",".join(("symbol",) + FUNDAMENTAL_MERGE_COLS
                        + ("quarter_end_date", "quarter_label",
                           "sales", "pbt", "net_profit"))
        # Paginated: ~12 quarter rows x 400 symbols blows through the
        # PostgREST 1000-row cap. A single .execute() used to return only
        # the newest 2-3 quarters per symbol (and dropped ~26 symbols
        # outright), so the ATH-quarter rules scored on truncated history.
        # Secondary order on symbol makes the page boundaries deterministic.
        rows = sb.fetch_all(
            lambda: cli.table("fundamentals")
                       .select(cols)
                       .in_("symbol", list(symbols))
                       .order("quarter_end_date", desc=True)
                       .order("symbol")
        )
        by_symbol: Dict[str, List[Dict[str, Any]]] = {}
        for r in rows:
            sym = r.get("symbol")
            if not sym:
                continue
            self._normalise_decimals(r)
            by_symbol.setdefault(sym, []).append(r)  # newest first

        out: Dict[str, Dict[str, Any]] = {}
        for sym, srows in by_symbol.items():
            merged = dict(srows[0])  # latest row carries the quality metrics
            merged.update(_quarter_aggregates(srows))
            out[sym] = merged
        return out

    @staticmethod
    def _normalise_decimals(row: Dict[str, Any]) -> None:
        """Coerce numeric-ish fields to Decimal in place.

        Money-safety boundary: PostgREST serialises NUMERIC as a JSON
        number, which the supabase client parses into FLOAT (older
        stacks returned str — handle both). Floats are converted via
        Decimal(str(x)) — the shortest-repr round-trip is exact for
        every NUMERIC(p<=15) value we store. Strategies refuse raw
        floats, so this is the one sanctioned conversion point.
        """
        for k, v in list(row.items()):
            if v is None or isinstance(v, (Decimal, bool)):
                continue
            if isinstance(v, float):
                dec = to_decimal(v)
                if dec is not None:
                    row[k] = dec
                else:
                    row[k] = None  # NaN/Inf from the wire — treat as missing
            elif isinstance(v, str) and _looks_numeric(v):
                dec = to_decimal(v)
                if dec is not None:
                    row[k] = dec

    # ---- Main entry -------------------------------------------------------
    def run(
        self,
        *,
        pool_code: str,
        snapshot_date: date,
        strategy_ids: Optional[Sequence[str]] = None,
        triggered_by: str = "manual",
        strategy_configs: Optional[Dict[str, Dict[str, Any]]] = None,
        dry_run: bool = False,
    ) -> ScanReport:
        started = datetime.now(timezone.utc)
        strategy_ids = list(strategy_ids or list_strategy_ids())
        strategy_configs = dict(strategy_configs or {})

        # 1. Load snapshots (already decimal-normalised).
        fetch = self.fetch_snapshots or self._default_fetch_snapshots
        snapshots = list(fetch(pool_code, snapshot_date))

        # 2. Merge fundamentals if any strategy needs them.
        needs_fundamentals = any(
            sid == "fundamental_screener" for sid in strategy_ids
        )
        if needs_fundamentals and snapshots:
            ffetch = self.fetch_fundamentals or self._default_fetch_fundamentals
            fund_map = ffetch([s.get("symbol") for s in snapshots if s.get("symbol")])
            for s in snapshots:
                f = fund_map.get(s.get("symbol"))
                if not f:
                    continue
                for col in FUNDAMENTAL_MERGE_COLS + FUNDAMENTAL_AGG_COLS:
                    if col in f and col not in s:
                        s[col] = f[col]

        ctx = ScanContext(
            pool_code=pool_code,
            snapshot_date=snapshot_date,
            triggered_by=triggered_by,
            strategy_configs=strategy_configs,
        )

        # 3. Evaluate every (symbol, strategy) pair.
        per_result: List[SymbolStrategyReport] = []
        result_rows: List[Dict[str, Any]] = []
        opportunities = 0

        for snap in snapshots:
            for sid in strategy_ids:
                try:
                    strat = get_strategy(sid)
                except KeyError as exc:
                    per_result.append(SymbolStrategyReport(
                        symbol=snap.get("symbol", "?"),
                        strategy_id=sid,
                        status="ERROR",
                        score=0,
                        opportunity=False,
                        error=str(exc),
                    ))
                    continue

                cfg = ctx.strategy_configs.get(sid, {})
                result = _safe_evaluate(strat, snap, cfg)
                is_opp = result.status in OPPORTUNITY_STATUSES
                if is_opp:
                    opportunities += 1
                per_result.append(SymbolStrategyReport(
                    symbol=result.symbol,
                    strategy_id=sid,
                    status=result.status,
                    score=result.score,
                    opportunity=is_opp,
                    error=None if not result.errors else "; ".join(result.errors),
                ))
                if not dry_run:
                    result_rows.append(_build_scan_result_row(
                        result=result,
                        stock_id=snap.get("stock_id"),
                    ))

        finished = datetime.now(timezone.utc)

        # 4. Write scans + scan_results (unless dry-run).
        upsert_errors: List[str] = []
        result_rows_written = 0
        scan_id: Optional[str] = None

        if not dry_run:
            scan_row = _build_scan_row(
                pool_code=pool_code,
                snapshot_date=snapshot_date,
                triggered_by=triggered_by,
                strategy_ids=strategy_ids,
                total_stocks=len(snapshots),
                opportunities_count=opportunities,
                started_at=started,
                finished_at=finished,
                duration_seconds=Decimal(str(round(
                    (finished - started).total_seconds(), 2
                ))),
            )
            insert_scan = self.insert_scan or self._default_insert_scan
            try:
                scan_id = insert_scan(scan_row)
            except Exception as exc:  # noqa: BLE001
                upsert_errors.append(f"scan insert: {type(exc).__name__}: {exc}")

            if scan_id is None and result_rows:
                # A missing scan id means every scan_result row would be
                # dropped — that is silent total data loss, surface it.
                upsert_errors.append(
                    "scan id lookup returned no row — "
                    f"{len(result_rows)} scan_results NOT written")
            if scan_id is not None and result_rows:
                for r in result_rows:
                    r["scan_id"] = scan_id
                rep = self.upsert(
                    SCAN_RESULTS_TABLE, result_rows,
                    conflict_cols=["scan_id", "symbol", "strategy_id"],
                    client=self.supabase_client,
                )
                result_rows_written = rep.succeeded
                upsert_errors.extend(rep.errors)

        report = ScanReport(
            scan_id=scan_id,
            pool_code=pool_code,
            snapshot_date=snapshot_date,
            triggered_by=triggered_by,
            dry_run=dry_run,
            started_at=started,
            finished_at=finished,
            strategy_ids=strategy_ids,
            total_stocks=len(snapshots),
            opportunities_count=opportunities,
            result_rows_written=result_rows_written,
            per_result=per_result,
            upsert_errors=upsert_errors,
        )
        _log("scan.done", **{
            k: v for k, v in report.as_json().items()
            if k not in ("per_result",)
        })
        return report

    # ---- scans insert -----------------------------------------------------
    def _default_insert_scan(self, row: Dict[str, Any]) -> Optional[str]:
        """
        Idempotent insert into `scans`. Returns the scan_id (BIGINT as str).
        We upsert on the conflict tuple, then fetch the row to read its id.
        """
        cli = self.supabase_client or sb.get_client()
        cli.table(SCANS_TABLE).upsert(
            row, on_conflict=",".join(SCANS_CONFLICT)
        ).execute()
        res = (
            cli.table(SCANS_TABLE)
               .select("id")
               .eq("pool_code", row["pool_code"])
               .eq("snapshot_date", row["snapshot_date"])
               .eq("triggered_by", row["triggered_by"])
               .limit(1)
               .execute()
        )
        rows = getattr(res, "data", None) or []
        if not rows:
            return None
        return str(rows[0].get("id"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _safe_evaluate(
    strat: Strategy, snapshot: Dict[str, Any], config: Dict[str, Any]
) -> StrategyResult:
    """Wrap strategy.evaluate — any raised exception becomes an ERROR result."""
    try:
        return strat.evaluate(snapshot, config)
    except Exception as exc:  # noqa: BLE001
        return StrategyResult(
            strategy_id=strat.strategy_id,
            strategy_name=strat.strategy_name,
            symbol=snapshot.get("symbol", "?"),
            status="ERROR",
            score=0,
            reasons=[f"{type(exc).__name__}: {exc}"],
            errors=[f"{type(exc).__name__}: {exc}"],
        )


def _build_scan_row(
    *,
    pool_code: str,
    snapshot_date: date,
    triggered_by: str,
    strategy_ids: Sequence[str],
    total_stocks: int,
    opportunities_count: int,
    started_at: datetime,
    finished_at: datetime,
    duration_seconds: Decimal,
) -> Dict[str, Any]:
    """Build a dict shaped for the `scans` table."""
    return {
        "pool_code": pool_code,
        "snapshot_date": snapshot_date.isoformat(),
        "triggered_by": triggered_by,
        "strategy_ids": list(strategy_ids),
        "total_stocks": total_stocks,
        "opportunities_count": opportunities_count,
        "duration_seconds": str(duration_seconds),
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
    }


def _build_scan_result_row(
    *,
    result: StrategyResult,
    stock_id: Optional[int],
) -> Dict[str, Any]:
    """Project a StrategyResult into a `scan_results` row (JSONB safe)."""
    return {
        "stock_id": stock_id,
        "symbol": result.symbol,
        "strategy_id": result.strategy_id,
        "status": result.status,
        "score": result.score,
        "best_score": result.score,
        "reasons": _json_safe(result.reasons),
        "metrics_snapshot": _json_safe(result.metrics_snapshot),
        "fundamentals_check": {},   # Stage 7 hook — decoupled from strategy output
    }


def _looks_numeric(s: str) -> bool:
    """Cheap check that ``s`` might parse as a Decimal."""
    if not s:
        return False
    c = s.lstrip("-").replace(".", "", 1)
    return c.isdigit()


def _log(event: str, **fields: Any) -> None:
    try:
        logger.info(json.dumps({"event": event, **fields}, default=str))
    except Exception:  # noqa: BLE001
        logger.info("event=%s %s", event, fields)
