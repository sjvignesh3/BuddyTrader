"""
One-click personal-data export — GET /api/backup/export (owner only).

Returns a single ZIP built in memory by ``plutus.backup.personal``:
  csv/<table>.csv        one sheet per personal table, for reading
  restore/<table>.json   the same rows, lossless, + manifest.json — the
                         folder ``plutus.scripts.restore_personal`` reads
  README.txt             what is inside and how to restore

Always the full history: the personal tables are small, and a backup that
is complete every time is the only kind that can rebuild a lost project.

Owner only — the archive is every personal table in one file, so it is not
handed to the shared view-only credential. Summary counts travel in
``X-Plutus-Backup-*`` response headers (exposed via CORS) so the Console
can say what was saved and warn when a table could not be read.

NOTE: no ``from __future__ import annotations`` — FastAPI must resolve the
``Request`` annotation of the route defined inside the register function.
"""
import logging
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

EXPOSED_HEADERS = (
    "Content-Disposition",
    "X-Plutus-Backup-Tables",
    "X-Plutus-Backup-Rows",
    "X-Plutus-Backup-Errors",
)


def register_backup_routes(app: Any, cli: Any) -> None:
    """Mount /api/backup/export. ``cli`` is the zero-arg callable returning
    the (injectable) supabase client."""
    from fastapi import HTTPException, Request
    from fastapi.responses import Response

    from plutus.adapters import supabase_client as sb
    from plutus.backup import personal

    def source_host() -> str:
        try:
            from plutus.config import get_settings
            return urlparse(get_settings().supabase_url).netloc
        except Exception:  # noqa: BLE001 — a label only; never block the export
            return ""

    @app.get("/api/backup/export")
    def export_backup(request: Request) -> Response:
        app.state.require_owner(request)
        try:
            payload, manifest = personal.build_export_zip(
                cli() or sb.get_client(), source=source_host())
        except Exception as exc:  # noqa: BLE001
            logger.exception("backup_export_failed")
            raise HTTPException(status_code=502, detail=str(exc))
        tables, errors = manifest["tables"], manifest["errors"]
        if not tables:
            first = next(iter(errors.values()), "no tables")
            raise HTTPException(status_code=502,
                                detail=f"nothing could be exported: {first}")
        stamp = personal.backup_dir_name()
        return Response(
            content=payload,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="plutus-backup-{stamp}.zip"',
                "Cache-Control": "no-store",
                "X-Plutus-Backup-Tables": str(len(tables)),
                "X-Plutus-Backup-Rows": str(sum(t["rows"] for t in tables.values())),
                "X-Plutus-Backup-Errors": ",".join(errors),
            },
        )
