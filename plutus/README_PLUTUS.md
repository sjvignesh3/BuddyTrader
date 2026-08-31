# Plutus (Stage 1 scaffold)

Successor to `backend/` (Buddy). This directory contains **only foundation
code** — no network calls, no metrics, no frontend. Later stages fill in
the remaining folders.

> Read `Docs/Plutus_Phased_Development.MD` (root of the repo) before
> touching anything here. The Prompt Note at the top of that file is
> binding — this is a money app.

## Layout

```
plutus/
  registry/          Field catalog + Decimal-safe primitives (Stage 1)
  adapters/          yfinance + Supabase clients      (Stage 2, empty for now)
  metrics/           Pure computation functions       (Stage 3, empty for now)
  sync/              Daily + quarterly workers        (Stage 4-5, empty for now)
  scan/              Strategy scan engine             (Stage 6, empty for now)
  migrations/        Ordered SQL files (001..009)
  scripts/           One-off ops
  tests/             Deterministic pytest suite
  config.py          Fail-fast environment loader
  .env.example
```

## Guardrails (enforced by tests + code review)

1. **No `float` for money/ratio fields.** Use `plutus.registry.types.to_decimal`.
2. **No hardcoded column-name strings** outside `plutus/registry/fields.py`.
3. **Every DB write is idempotent** (UNIQUE natural key + `ON CONFLICT`).
4. **Every metric has a hand-computed unit test** before it goes live.
5. **Config errors crash at import**, never mid-sync.

## Running the tests

The tests are pure unit tests — no Supabase, no yfinance, no network.

```bash
cd plutus
python -m pytest
```

If you see any test fail, do **not** proceed to Stage 2.

## Applying migrations to a fresh Supabase project

```bash
export PLUTUS_SUPABASE_URL='postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres'
for f in migrations/0*.sql; do psql "$PLUTUS_SUPABASE_URL" -f "$f"; done
```

Re-running is safe — every DDL statement is `IF NOT EXISTS` / idempotent.

## What is done in Stage 1

- [x] Directory scaffold matches the phased plan.
- [x] `registry/fields.py` — canonical field catalog (every column named once).
- [x] `registry/types.py` — Decimal-only primitives + `to_decimal` gate.
- [x] `config.py` — fail-fast env loader with test coverage.
- [x] `migrations/001..009` — Supabase DDL for every table + views.
- [x] Unit tests prove: type contracts, config failure modes, registry
      invariants, and registry ↔ migration alignment.

## What is NOT done in Stage 1 (do NOT attempt these here)

- ✗ yfinance calls — Stage 2
- ✗ Metric functions — Stage 3
- ✗ Sync worker — Stage 4-5
- ✗ Scan engine — Stage 6
- ✗ Frontend — Stage 7
