"""
Personal-data backup & restore — the tables you typed in by hand.

Market data (daily_snapshots, fundamentals, scan_results, screener_ratios)
re-syncs from yfinance / Screener and is NOT exported here; the weekly
pg_dump workflow covers it. This module is for the data that cannot be
regenerated: the Trading Journal, Expense Tracker, Position Sizer plans,
Net Worth (assets, liabilities, snapshots, income, milestones, settings),
watchlists and the hand-curated universe (pools + stocks).

Export (``export_tables``): one JSON file per table under a dated folder
    <out_root>/<YYYY-MM-DD_HHMMSS>/<table>.json  +  manifest.json
Rows are stored exactly as PostgREST returns them (ids included), so a
restore reproduces foreign keys between journal trades and opportunities,
expenses and categories, and so on.

Restore (``restore_tables``): idempotent upserts in foreign-key order,
through the same ``bulk_upsert`` helper the sync workers use. Because rows
come back WITH their ids, the BIGSERIAL sequences lag behind afterwards;
``reset_sequences`` calls the ``plutus_reset_sequences()`` RPC (migration
023) so the next insert from the app does not collide.

No psql / pg_dump needed — only the Supabase REST API with the service key,
which is what the rest of Plutus already uses. Pure functions take an
injected client / upsert so the tests run offline.
"""
from __future__ import annotations

import json
import logging
import shutil
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from plutus.adapters import supabase_client as sb

logger = logging.getLogger(__name__)

MANIFEST = "manifest.json"
FORMAT_VERSION = 1


@dataclass(frozen=True)
class TableSpec:
    name: str
    group: str
    conflict_cols: Tuple[str, ...] = ("id",)
    order_by: str = "id"
    # Columns stripped before restore (e.g. stocks.id — the natural key is
    # the symbol and market tables re-sync their stock_id anyway).
    drop_cols: Tuple[str, ...] = ()
    # Self-referencing FK: rows whose value in this column is NULL are
    # restored first, then the rest (expense_categories.parent_id).
    self_ref_col: Optional[str] = None


# Foreign-key order — restore walks this list top to bottom.
TABLES: Tuple[TableSpec, ...] = (
    # universe (hand-curated membership, groups, cap overrides)
    TableSpec("pools", "universe", conflict_cols=("code",), order_by="code"),
    TableSpec("stocks", "universe", conflict_cols=("symbol",), order_by="symbol",
              drop_cols=("id",)),
    # journal
    TableSpec("journal_settings", "journal"),
    TableSpec("journal_opportunities", "journal"),
    TableSpec("journal_trades", "journal"),              # -> opportunities
    TableSpec("journal_stock_notes", "journal"),
    TableSpec("sizing_plans", "journal"),                # -> opportunities
    # expenses
    TableSpec("expense_categories", "expenses", self_ref_col="parent_id"),
    TableSpec("expense_recurring", "expenses"),          # -> categories
    TableSpec("expenses", "expenses"),                   # -> categories, recurring
    TableSpec("expense_items", "expenses"),              # -> categories
    TableSpec("expense_budgets", "expenses"),            # -> categories
    # net worth
    TableSpec("networth_assets", "networth"),
    TableSpec("networth_liabilities", "networth"),
    TableSpec("networth_snapshots", "networth"),
    TableSpec("networth_income", "networth"),
    TableSpec("networth_milestones", "networth"),
    TableSpec("networth_settings", "networth"),
    # watchlists
    TableSpec("watchlists", "watchlists"),
)

GROUPS: Tuple[str, ...] = tuple(dict.fromkeys(t.group for t in TABLES))
_BY_NAME: Dict[str, TableSpec] = {t.name: t for t in TABLES}


def select_tables(names: Optional[Iterable[str]] = None) -> List[TableSpec]:
    """Resolve ``--tables`` input: table names or group names, FK order kept.
    Unknown names raise so a typo cannot silently skip a table."""
    if not names:
        return list(TABLES)
    wanted = {n.strip() for n in names if n and n.strip()}
    unknown = wanted - set(_BY_NAME) - set(GROUPS)
    if unknown:
        raise ValueError(f"unknown table/group: {', '.join(sorted(unknown))} "
                         f"(tables: {', '.join(_BY_NAME)}; groups: {', '.join(GROUPS)})")
    return [t for t in TABLES if t.name in wanted or t.group in wanted]


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
def _json_default(v: Any) -> Any:
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    raise TypeError(f"not JSON serialisable: {type(v).__name__}")


def _default_fetch(client: Any, spec: TableSpec) -> List[Dict[str, Any]]:
    return sb.fetch_all(
        lambda: client.table(spec.name).select("*").order(spec.order_by)
    )


def backup_dir_name(now: Optional[datetime] = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%d_%H%M%S")


def export_tables(
    client: Any,
    out_root: Path,
    *,
    tables: Optional[Sequence[TableSpec]] = None,
    fetch: Callable[[Any, TableSpec], List[Dict[str, Any]]] = _default_fetch,
    source: str = "",
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Write <out_root>/<stamp>/<table>.json for every table + manifest.json.
    Returns the manifest. A table that fails to read is recorded under
    manifest['errors'] and the others still land — a partial backup beats
    none, and the caller decides the exit code."""
    specs = list(tables) if tables is not None else list(TABLES)
    out_root = Path(out_root)
    stamp = backup_dir_name(now)
    out_dir = out_root / stamp
    out_dir.mkdir(parents=True, exist_ok=False)

    manifest: Dict[str, Any] = {
        "format": FORMAT_VERSION,
        "created_at": (now or datetime.now(timezone.utc)).isoformat(),
        "source": source,
        "tables": {},
        "errors": {},
    }
    for spec in specs:
        try:
            rows = fetch(client, spec)
        except Exception as exc:  # noqa: BLE001 — keep going, report at the end
            logger.error("%s: export failed: %s", spec.name, exc)
            manifest["errors"][spec.name] = f"{type(exc).__name__}: {exc}"
            continue
        path = out_dir / f"{spec.name}.json"
        path.write_text(json.dumps(rows, default=_json_default, indent=1,
                                   ensure_ascii=False), encoding="utf-8")
        manifest["tables"][spec.name] = {
            "rows": len(rows), "group": spec.group, "file": path.name,
            "conflict_cols": list(spec.conflict_cols),
        }
    (out_dir / MANIFEST).write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    manifest["dir"] = str(out_dir)
    return manifest


def prune_backups(out_root: Path, keep: int) -> List[Path]:
    """Delete the oldest dated backup folders beyond `keep`. Only folders
    that carry a manifest are candidates — anything else in out_root is
    left alone. Returns the removed paths."""
    out_root = Path(out_root)
    if keep < 1 or not out_root.exists():
        return []
    dirs = sorted(p for p in out_root.iterdir()
                  if p.is_dir() and (p / MANIFEST).exists())
    doomed = dirs[:-keep] if len(dirs) > keep else []
    for p in doomed:
        shutil.rmtree(p)
    return doomed


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------
def load_backup(in_dir: Path) -> Tuple[Dict[str, Any], Dict[str, List[Dict[str, Any]]]]:
    """Read manifest + every table file present. Missing table files are
    simply absent from the result (a group-only backup restores fine)."""
    in_dir = Path(in_dir)
    mpath = in_dir / MANIFEST
    if not mpath.exists():
        raise FileNotFoundError(f"{mpath} not found — not a Plutus backup folder")
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    data: Dict[str, List[Dict[str, Any]]] = {}
    for spec in TABLES:
        f = in_dir / f"{spec.name}.json"
        if f.exists():
            rows = json.loads(f.read_text(encoding="utf-8"))
            if not isinstance(rows, list):
                raise ValueError(f"{f.name}: expected a JSON array")
            data[spec.name] = rows
    return manifest, data


def rows_for_restore(spec: TableSpec, rows: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """Apply the spec: drop columns, split self-referencing tables into
    waves (parents first). Returns a list of batches to upsert in order."""
    cleaned = [{k: v for k, v in r.items() if k not in spec.drop_cols} for r in rows]
    if spec.self_ref_col:
        roots = [r for r in cleaned if r.get(spec.self_ref_col) is None]
        children = [r for r in cleaned if r.get(spec.self_ref_col) is not None]
        return [b for b in (roots, children) if b]
    return [cleaned] if cleaned else []


def restore_tables(
    client: Any,
    in_dir: Path,
    *,
    tables: Optional[Sequence[TableSpec]] = None,
    dry_run: bool = False,
    upsert: Callable[..., Any] = sb.bulk_upsert,
) -> Dict[str, Any]:
    """Upsert every table file in FK order. Returns a per-table report
    {table: {rows, succeeded, failed, errors}} plus 'ok'."""
    manifest, data = load_backup(in_dir)
    specs = list(tables) if tables is not None else list(TABLES)
    report: Dict[str, Any] = {"dir": str(in_dir), "dry_run": dry_run,
                              "manifest_created_at": manifest.get("created_at"),
                              "tables": {}, "ok": True}
    for spec in specs:
        rows = data.get(spec.name)
        if rows is None:
            continue
        entry = {"rows": len(rows), "succeeded": 0, "failed": 0, "errors": []}
        report["tables"][spec.name] = entry
        for batch in rows_for_restore(spec, rows):
            if dry_run:
                entry["succeeded"] += len(batch)
                continue
            rep = upsert(spec.name, batch, conflict_cols=spec.conflict_cols, client=client)
            entry["succeeded"] += getattr(rep, "succeeded", 0)
            entry["failed"] += getattr(rep, "failed", 0)
            entry["errors"].extend(getattr(rep, "errors", []) or [])
        if entry["failed"] or entry["errors"]:
            report["ok"] = False
    return report


RESET_SEQUENCES_RPC = "plutus_reset_sequences"


def reset_sequences(client: Any) -> Tuple[bool, Any]:
    """Bump every BIGSERIAL sequence to max(id) after a restore. Returns
    (ok, payload). ok=False means the RPC is missing (migration 023 not
    applied) or failed — the caller prints the manual SQL."""
    try:
        res = client.rpc(RESET_SEQUENCES_RPC, {}).execute()
        return True, getattr(res, "data", None)
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


def manual_reset_sql() -> str:
    """The SQL the owner pastes into the Supabase SQL editor when the
    plutus_reset_sequences() RPC (migration 023) is not available."""
    lines = ["-- Run once after a restore: bump each id sequence past the restored rows."]
    for t in TABLES:
        if "id" in t.conflict_cols and t.name not in ("journal_settings", "networth_settings"):
            lines.append(
                f"SELECT setval(pg_get_serial_sequence('{t.name}', 'id'), "
                f"COALESCE((SELECT MAX(id) FROM {t.name}), 1));")
    return "\n".join(lines) + "\n"
