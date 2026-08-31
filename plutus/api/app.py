"""
FastAPI application factory — Plutus read-only API (Stage 7).

Design contract:
  * READ-ONLY. There is no POST/PUT/DELETE anywhere in this file.
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

    # CORS — frontend v2 lives on a different origin; allow read-only.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],       # narrowed via env in prod (Stage 9).
        allow_credentials=False,
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    def cli() -> Any:
        return app.state.supabase_client

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
        pool: str = Query(..., description="Pool code (F40 / E40 / S200 / PlayArea)"),
        snapshot_date: Optional[str] = Query(None, description="ISO date (YYYY-MM-DD)"),
        limit: int = Query(500, ge=1, le=2000),
    ) -> dict:
        try:
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
        scan_id: str = Query(...),
        strategy_id: Optional[str] = Query(None),
        status: Optional[str] = Query(None, description="Comma-separated list"),
    ) -> dict:
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

    return app
