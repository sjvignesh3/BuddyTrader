# Plutus SQL Migrations

Ordered, idempotent Supabase / PostgreSQL migration files.

## Rules
1. **Ordering matters.** File name prefix (`001_`, `002_`, ...) IS the order.
   Never rename or renumber a file that has already been applied to any
   environment.
2. **Idempotent DDL only.** Every file uses `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`, etc., so re-running the whole folder is
   safe on any environment.
3. **Column names MUST match `plutus/registry/fields.py`.** If a column is
   here and not in the registry (or vice versa), Stage 1 is broken.
4. **`NUMERIC(p,s)` for every money/ratio field.** `FLOAT` / `REAL` /
   `DOUBLE PRECISION` are banned.
5. **Every table has a `UNIQUE` natural key** so writes can be
   `INSERT ... ON CONFLICT DO UPDATE`.

## Apply order (dev)

Every file in ascending order — the simplest correct way is:

```bash
for f in $(ls plutus/migrations/*.sql | sort); do
  psql "$PLUTUS_SUPABASE_DB_URL" -f "$f"
done
```

Or one-by-one:

```
001_stocks.sql           -- tables + shared plutus_touch_updated_at()
002_pools.sql
003_daily_snapshots.sql
004_fundamentals.sql
005_strategy_configs.sql
006_scans_and_results.sql
007_trades.sql           -- schema only; writes gated to V2
008_sync_jobs.sql
009_views.sql
010_rls.sql              -- anon read, service write (Stage 7)
011_canary_checks.sql    -- pinned drift fixtures (Stage 8)
```

Row-Level Security policies live in `010_rls.sql` and `011_canary_checks.sql`.
The service_role key bypasses RLS; the anon key is read-only on every table
except `trades` (denied entirely until V2).
