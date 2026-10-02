"""
Export the personal tables (journal, expenses, sizing plans, net worth,
watchlists, universe) to dated JSON folders you own.

Usage:
    python -m plutus.scripts.backup_personal [--out DIR] [--keep N]
        [--tables journal,expenses,...] [--verbose]

  --out     Root folder for backups. Default: UserData/backups (git-ignored).
            Point it at a OneDrive / Google Drive folder for an off-machine copy.
  --keep    Delete the oldest backup folders beyond N (default 12 = ~3 months
            of weekly runs; 0 = keep everything).
  --tables  Comma-separated table or group names (groups: universe, journal,
            expenses, networth, watchlists). Default: everything.

Reads whichever Supabase project PLUTUS_SUPABASE_URL points at (plutus/.env).
Exit code 0 on a complete backup, 1 when any table failed to export.

Schedule it weekly on Windows (Task Scheduler, runs even if you forget):
    schtasks /Create /SC WEEKLY /D SUN /ST 21:00 /TN "Plutus personal backup" ^
      /TR "cmd /c cd /d D:\\Tools\\Plutus\\BuddyTrader && .venv\\Scripts\\python.exe -m plutus.scripts.backup_personal --out D:\\OneDrive\\PlutusBackups --keep 12"

Restore with plutus.scripts.restore_personal.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import Optional, Sequence

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "UserData" / "backups"


def _parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="backup_personal",
                                 description="Export Plutus personal tables to JSON.")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help=f"backup root (default {DEFAULT_OUT})")
    ap.add_argument("--keep", type=int, default=12, help="backups to keep (0 = all)")
    ap.add_argument("--tables", default="", help="comma-separated tables / groups")
    ap.add_argument("--verbose", "-v", action="store_true")
    return ap.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from plutus.adapters import supabase_client as sb
    from plutus.backup import personal
    from plutus.config import get_settings  # loads plutus/.env, validates settings

    try:
        specs = personal.select_tables(args.tables.split(",")) if args.tables else None
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    source = get_settings().supabase_url
    out_root = Path(args.out)
    print(f"source {source or '(env)'} -> {out_root}")
    manifest = personal.export_tables(sb.get_client(), out_root, tables=specs, source=source)

    total = 0
    for name, info in manifest["tables"].items():
        total += info["rows"]
        print(f"  {name:<24} {info['rows']:>6} rows")
    for name, err in manifest["errors"].items():
        print(f"  {name:<24} FAILED  {err}")
    print(f"wrote {manifest['dir']}  ({total} rows, {len(manifest['tables'])} tables)")

    removed = personal.prune_backups(out_root, args.keep) if args.keep > 0 else []
    for p in removed:
        print(f"pruned {p.name}")
    return 1 if manifest["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
