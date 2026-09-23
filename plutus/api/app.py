"""
FastAPI application factory — Plutus read-only API (Stage 7).

Design contract:
  * READ-ONLY for market data. There is no POST/PUT/DELETE in this file.
    The single writable area is the personal Trading Journal, mounted from
    plutus.api.journal (its tables are anon-inaccessible via RLS).
  * The Supabase client is dependency-injected via app.state.supabase_client
    so tests can swap in an in-memory fake.
  * Every response is passed through ``serializers.to_wire`` so Decimals
    never become floats on the wire.
  * Every route catches its own errors and returns a structured
    ``{"error": "..."}`` payload instead of a 500 with a stack trace.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from plutus.api import repository as repo
from plutus.api.serializers import serialize_rows, to_wire

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# FastAPI is an optional dependency at test time. Import lazily so the
# unit tests can exercise `repository` + `serializers` without pulling in
# starlette / pydantic on the CI runner.
# ---------------------------------------------------------------------------

def create_app(*, supabase_client: Optional[Any] = None) -> Any:
    """
    Build a FastAPI app instance.

    Args:
        supabase_client: optional client injected into ``app.state``.
                         When ``None``, routes lazily call
                         ``sb.get_client()`` per request.
    """
    from fastapi import FastAPI, HTTPException, Query  # noqa: WPS433 lazy
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(
        title="Plutus API",
        version="0.7.0",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.state.supabase_client = supabase_client

    def cli() -> Any:
        return app.state.supabase_client

    # -- Auth gate (personal tools) -----------------------------------------
    # Registered BEFORE the CORS middleware on purpose: Starlette runs the
    # most recently added middleware outermost, so CORS must be added last
    # to wrap the gate — otherwise its 401/403 reaches the browser without
    # CORS headers and shows up as an opaque network error instead of a
    # readable "sign in" / "view-only" message.
    from plutus.api.auth import register_auth_routes
    register_auth_routes(app, cli)

    # CORS — frontend v2 lives on a different origin; allow read-only.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],       # narrowed via env in prod (Stage 9).
        allow_credentials=False,
        # Write methods exist ONLY under /api/journal/* (personal journal).
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    # Error envelope parity with the Edge Function: {"error": "..."} —
    # FastAPI's default HTTPException body is {"detail": "..."}.
    from fastapi.responses import JSONResponse

    @app.exception_handler(HTTPException)
    async def _error_envelope(request: Any, exc: HTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code,
                            content={"error": str(exc.detail)})

    # -- Health ------------------------------------------------------------
    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "service": "plutus-api", "version": "0.7.0"}

    # -- Pools -------------------------------------------------------------
    @app.get("/api/pools")
    def get_pools() -> dict:
        try:
            rows = repo.list_pools(client=cli())
        except Exception as exc:  # noqa: BLE001
            logger.exception("pools_failed")
            raise HTTPException(status_code=502, detail=str(exc))
        return {"pools": serialize_rows(rows)}

    # -- Stocks ------------------------------------------------------------
    @app.get("/api/stocks")
    def get_stocks(
        pool: Optional[str] = Query(None, description="Filter by pool code"),
        active_only: bool = Query(True),
        limit: int = Query(500, ge=1, le=2000),
    ) -> dict:
        try:
            rows = repo.list_stocks(
                pool_code=pool, active_only=active_only,
                limit=limit, client=cli(),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("stocks_failed")
            raise HTTPException(status_code=502, detail=str(exc))
        return {"stocks": serialize_rows(rows), "count": len(rows)}

    @app.get("/api/stocks/{symbol}")
    def get_one_stock(symbol: str) -> dict:
        row = repo.get_stock(symbol, client=cli())
        if row is None:
            raise HTTPException(status_code=404, detail=f"unknown symbol: {symbol}")
        return {"stock": to_wire(row)}

    # -- Snapshots ---------------------------------------------------------
    @app.get("/api/snapshots/latest")
    def get_latest_snapshots(
        pool: Optional[str] = Query(None, description="Pool code (F40 / E40 / S200)"),
        symbols: Optional[str] = Query(None, description="Comma-separated symbols "
                                       "(PlayArea watchlist mode — alternative to pool)"),
        snapshot_date: Optional[str] = Query(None, description="ISO date (YYYY-MM-DD)"),
        limit: int = Query(500, ge=1, le=2000),
    ) -> dict:
        if not pool and not symbols:
            raise HTTPException(status_code=400,
                                detail="either pool or symbols is required")
        try:
            if symbols:
                sym_list = [s.strip() for s in symbols.split(",") if s.strip()]
                rows = repo.snapshots_for_symbols(
                    sym_list, snapshot_date=snapshot_date,
                    client=cli(), limit=limit,
                )
            else:
                rows = repo.snapshots_for_pool(
                    pool_code=pool, snapshot_date=snapshot_date,
                    client=cli(), limit=limit,
                )
        except Exception as exc:  # noqa: BLE001
            logger.exception("snapshots_failed")
            raise HTTPException(status_code=502, detail=str(exc))
        return {
            "pool": pool,
            "snapshot_date": snapshot_date or (rows[0]["snapshot_date"] if rows else None),
            "snapshots": serialize_rows(rows),
            "count": len(rows),
        }

    @app.get("/api/snapshots/{symbol}/history")
    def get_history(symbol: str, days: int = Query(60, ge=1, le=1000)) -> dict:
        rows = repo.snapshot_history(symbol=symbol, days=days, client=cli())
        return {"symbol": symbol, "days": days, "bars": serialize_rows(rows)}

    # -- Scans -------------------------------------------------------------
    @app.get("/api/scans/latest")
    def get_latest_scan(pool: str = Query(...)) -> dict:
        row = repo.latest_scan(pool_code=pool, client=cli())
        return {"scan": to_wire(row)}

    @app.get("/api/scan_results")
    def get_scan_results(
        scan_id: Optional[str] = Query(None),
        symbols: Optional[str] = Query(None, description="Comma-separated symbols — "
                                       "returns each symbol's LATEST result per "
                                       "strategy across any pool scan (PlayArea)"),
        strategy_id: Optional[str] = Query(None),
        status: Optional[str] = Query(None, description="Comma-separated list"),
    ) -> dict:
        if not scan_id and not symbols:
            raise HTTPException(status_code=400,
                                detail="either scan_id or symbols is required")
        if symbols:
            sym_list = [s.strip() for s in symbols.split(",") if s.strip()]
            rows = repo.latest_scan_results_for_symbols(sym_list, client=cli())
            if strategy_id:
                rows = [r for r in rows if r.get("strategy_id") == strategy_id]
            return {"scan_id": None, "results": serialize_rows(rows),
                    "count": len(rows)}
        status_in = [s.strip() for s in status.split(",")] if status else None
        rows = repo.scan_results(
            scan_id=scan_id, strategy_id=strategy_id,
            status_in=status_in, client=cli(),
        )
        return {"scan_id": scan_id, "results": serialize_rows(rows), "count": len(rows)}

    # -- Sync jobs ---------------------------------------------------------
    @app.get("/api/sync_jobs/latest")
    def get_latest_sync_jobs(
        job_type: Optional[str] = Query(None),
        limit: int = Query(10, ge=1, le=100),
    ) -> dict:
        rows = repo.latest_sync_jobs(job_type=job_type, limit=limit, client=cli())
        return {"jobs": serialize_rows(rows), "count": len(rows)}

    # -- Fundamentals ------------------------------------------------------
    @app.get("/api/fundamentals/{symbol}/latest")
    def get_latest_fund(symbol: str) -> dict:
        row = repo.latest_fundamentals(symbol=symbol, client=cli())
        if row is None:
            raise HTTPException(status_code=404, detail=f"no fundamentals for {symbol}")
        return {"fundamentals": to_wire(row)}

    # -- LOCAL-DEV on-demand fetch (PlayArea "Fetch now") --------------------
    # Deliberately NOT ported to the Edge Function: production stays
    # read-only; there, new symbols fill on the nightly sync. Locally this
    # runs the daily sync + fetch-on-miss enrichment + the pool scans for
    # the requested symbols in a background thread. Available only when
    # PLUTUS_ENV != prod.
    _sync_in_progress: set = set()

    def _run_on_demand(symbols: list) -> None:
        import logging as _logging
        log = _logging.getLogger("plutus.api.on_demand")
        try:
            from plutus.scripts.run_daily_sync import (
                _resolve_as_of,
                enrich_missing_fundamentals,
            )
            from plutus.sync.context import TRIGGER_ON_DEMAND, build_run_context
            from plutus.sync.worker import DailySyncWorker

            as_of = _resolve_as_of(None)
            run_ctx = build_run_context(
                pool="PlayArea", symbols=symbols, trigger=TRIGGER_ON_DEMAND)
            # Screener enrichment FIRST so the daily sync can stamp the
            # fresh PE/PB/MCap into the snapshot it is about to write.
            enrich_missing_fundamentals(
                symbols, context={**run_ctx, "via": "on-demand fetch-on-miss"})
            DailySyncWorker(run_context=run_ctx).run_all(symbols, as_of=as_of)

            # Re-score: run the scan for each pool the symbols belong to.
            from plutus.adapters import supabase_client as _sb
            from plutus.scan.engine import ScanEngine
            client = cli() or _sb.get_client()
            pools: set = set()
            try:
                res = (client.table("stocks").select("symbol,pools")
                       .in_("symbol", symbols).execute())
                for r in getattr(res, "data", None) or []:
                    pools.update(r.get("pools") or [])
            except Exception as exc:  # noqa: BLE001
                log.warning("pool lookup failed: %s", exc)
            eng = ScanEngine(supabase_client=client)
            # Rows are labelled by session date — scan the one just written.
            scan_date = eng.resolve_snapshot_date(as_of) or as_of
            for pool in sorted(pools):
                eng.run(pool_code=pool, snapshot_date=scan_date,
                        triggered_by="api")
            log.info("on-demand sync done: %s (pools %s)", symbols, sorted(pools))
        except Exception as exc:  # noqa: BLE001
            log.exception("on-demand sync failed: %s", exc)
        finally:
            for s in symbols:
                _sync_in_progress.discard(s)

    @app.get("/api/admin/sync")
    def on_demand_sync(symbols: str = Query(..., description="Comma-separated")) -> dict:
        from plutus.config import get_settings
        try:
            env = get_settings().environment
        except Exception:  # noqa: BLE001
            env = "dev"
        if env == "prod":
            raise HTTPException(status_code=404, detail="not available in prod")

        req = [s.strip().upper() for s in symbols.split(",") if s.strip()]
        todo = [s for s in req if s not in _sync_in_progress]
        for s in todo:
            _sync_in_progress.add(s)
        if todo:
            import threading
            threading.Thread(target=_run_on_demand, args=(todo,),
                             daemon=True).start()
        return {"started": todo,
                "already_running": [s for s in req if s not in todo],
                "note": "sync + screener fetch + scan running in background; "
                        "poll the snapshots endpoint"}

    # -- Trading Journal (writable; personal tool) ---------------------------
    from plutus.api.journal import register_journal_routes
    register_journal_routes(app, cli)

    # -- Expense Tracker (writable; personal tool) ----------------------------
    from plutus.api.expenses import register_expense_routes
    register_expense_routes(app, cli)

    # -- Position Sizer (writable; saved plans) -------------------------------
    from plutus.api.sizing import register_sizing_routes
    register_sizing_routes(app, cli)

    # -- Net Worth dashboard (writable; assets, liabilities, snapshots) -------
    from plutus.api.networth import register_networth_routes
    register_networth_routes(app, cli)

    # -- Universe (writable; pool membership = single source of truth) --------
    from plutus.api.universe import register_universe_routes
    register_universe_routes(app, cli)

    # -- On-demand GitHub Actions trigger (no DB writes; PAT stays server-
    # side; gated by PLUTUS_ADMIN_TOKEN) -------------------------------------
    from plutus.api.admin_trigger import register_admin_trigger_routes
    register_admin_trigger_routes(app)

    return app
