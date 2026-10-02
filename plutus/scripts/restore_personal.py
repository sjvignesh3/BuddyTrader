"""
Restore a personal-data backup (made by backup_personal) into whichever
Supabase project PLUTUS_SUPABASE_URL points at — a fresh project after a
provider disaster, or the local stack to inspect an old copy.

Usage:
    python -m plutus.scripts.restore_personal <backup_dir> [--dry-run]
        [--tables journal,expenses,...] [--yes] [--skip-sequences]

Prerequisites on the TARGET:
  1. Migrations applied (001..023) — this restores rows, not schema.
  2. PLUTUS_SUPABASE_URL / PLUTUS_SUPABASE_SERVICE_KEY in plutus/.env point
     at the target. The script prints the host and refuses to write
     without --yes, so a stale .env cannot overwrite the wrong project.

Behaviour:
  * Idempotent upserts in foreign-key order (pools, stocks, journal,
    expenses, net worth, watchlists). Re-running is safe.
  * Rows keep their ids, so journal trades still point at their
    opportunities and expenses at their categories.
  * Afterwards the BIGSERIAL sequences are bumped via the
    plutus_reset_sequences() RPC (migration 023). Without it the next
    insert from the app would collide with a restored id; if the RPC is
    missing the script prints the SQL to run by hand.
Exit code 0 when every table restored cleanly, 1 otherwise.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import Optional, Sequence
from urllib.parse import urlparse


def _parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="restore_personal",
                                 description="Restore Plutus personal tables from a backup folder.")
    ap.add_argument("backup_dir", help="folder containing manifest.json (from backup_personal)")
    ap.add_argument("--dry-run", action="store_true", help="read and validate, write nothing")
    ap.add_argument("--tables", default="", help="comma-separated tables / groups")
    ap.add_argument("--yes", action="store_true", help="confirm writing to the target shown")
    ap.add_argument("--skip-sequences", action="store_true",
                    help="do not call plutus_reset_sequences() afterwards")
    ap.add_argument("--verbose", "-v", action="store_true")
    return ap.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from plutus.adapters import supabase_client as sb
    from plutus.backup import personal
    from plutus.config import get_settings  # loads plutus/.env

    try:
        specs = personal.select_tables(args.tables.split(",")) if args.tables else None
        manifest, data = personal.load_backup(Path(args.backup_dir))
    except (ValueError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    target = urlparse(get_settings().supabase_url).netloc or "(unknown)"
    print(f"backup  {args.backup_dir}  (created {manifest.get('created_at')}, "
          f"source {manifest.get('source') or '?'})")
    print(f"target  {target}")
    for spec in (specs or personal.TABLES):
        if spec.name in data:
            print(f"  {spec.name:<24} {len(data[spec.name]):>6} rows")

    if not args.dry_run and not args.yes:
        print("\nrefusing to write without --yes (re-run with --dry-run to preview)")
        return 2

    client = sb.get_client()
    report = personal.restore_tables(client, Path(args.backup_dir), tables=specs,
                                     dry_run=args.dry_run)
    ok = report["ok"]
    for name, e in report["tables"].items():
        flag = "ok " if not (e["failed"] or e["errors"]) else "ERR"
        print(f"  [{flag}] {name:<24} {e['succeeded']:>6} upserted"
              + (f"  {e['failed']} failed" if e["failed"] else ""))
        for err in e["errors"][:3]:
            print(f"        {err}")
    if args.dry_run:
        print("dry run — nothing written")
        return 0

    if not args.skip_sequences:
        rpc_ok, payload = personal.reset_sequences(client)
        if rpc_ok:
            n = len(payload) if isinstance(payload, list) else "?"
            print(f"sequences reset via {personal.RESET_SEQUENCES_RPC}() ({n} sequences)")
        else:
            ok = False
            print(f"\nWARNING: could not reset id sequences ({payload}).\n"
                  f"Apply migration 023 and re-run, or paste this into the SQL editor:\n")
            print(personal.manual_reset_sql())
    print("restore complete" if ok else "restore finished WITH ERRORS")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
