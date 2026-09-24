# Plutus — NSE Swing-Trading Toolkit

Plutus is a personal, scheduled end-of-day toolkit for NSE equities. It syncs
prices and fundamentals into Supabase, runs strategy scans over a curated
universe, and serves a React dashboard with a Trading Journal, Expense
Tracker, Position Sizer and Net Worth tracker on top.

Plutus is the successor to the earlier "Buddy" scanner. The legacy Buddy code
was removed from the tree on 2026-09-16 and lives only in git history.

---

## Repository layout

```
.
├── plutus/                 Python backend (money-safe, Decimal-only)
│   ├── adapters/           yfinance + Supabase clients, validators
│   ├── metrics/            Pure metric functions (52w, ATH, DMA, rally, cap bucket)
│   ├── fundamentals/       Screener.in client + page parsers, quarterly data
│   ├── sync/               Daily / quarterly / weekly-ratio sync workers
│   ├── scan/               Strategy engine + strategies (envelope, week52, rally, fundamental)
│   ├── api/                FastAPI app: read endpoints + journal / expenses / sizing / net worth / universe
│   ├── alerts/             Webhook alerting hooked into the sync workers
│   ├── canary/             Drift checks against known-good fixtures
│   ├── migrations/         Ordered SQL (001..019), idempotent, applied with psql
│   ├── scripts/            CLI entry points (run_daily_sync, run_scan, run_api, seed_universe, ...)
│   ├── registry/           Field catalog + Decimal primitives (single source of column names)
│   └── tests/              Deterministic pytest suite — no network, no DB
├── frontend_v2/            Vite + React 18 + TypeScript dashboard (see frontend_v2/README.md)
├── supabase/               Local Supabase stack config + read-only Edge Function fallback
├── extension/              Plutus Companion — Chrome extension for TradingView + Screener.in (see extension/README.md)
├── .github/workflows/      Scheduled syncs, weekly ratios, weekly backup, CI tests
├── UserData/               Master universe CSV (one-time seed input) + personal notes
└── Docs/                   Plutus plan, phased development log, runbook, hosting guide, issue log
```

## Guardrails (enforced by tests and CI)

1. **No `float` for money/ratio fields.** Use `plutus.registry.types.to_decimal`.
   CI greps `plutus/metrics`, `sync`, `fundamentals` and `api` for `float(`.
2. **No hardcoded column-name strings** outside `plutus/registry/fields.py`.
3. **Every DB write is idempotent** (UNIQUE natural key + `ON CONFLICT`).
4. **Every metric has a hand-computed unit test** before it goes live.
5. **Config errors crash at import**, never mid-sync (`plutus/config.py`).

## Quick start (local)

Full step-by-step instructions, including the local Supabase stack and every
CLI, are in `Docs/Plutus_Local_and_Live_Runbook.md`. The short version:

```bash
# 1. Python env + deps (repo root)
python -m venv .venv
.venv/Scripts/activate            # Windows  |  source .venv/bin/activate on macOS/Linux
pip install -r plutus/requirements.txt

# 2. Local Supabase, then migrations
supabase start
for f in plutus/migrations/0*.sql; do psql "$PLUTUS_SUPABASE_DB_URL" -f "$f"; done

# 3. Env vars
cp plutus/.env.example plutus/.env   # then fill in Supabase + Screener values

# 4. Seed the universe ONCE (first install only), sync, scan
#    Afterwards the `stocks` table is the single source of truth: manage pool
#    members on Market Analysis -> Universe (add / edit / import / export).
#    Re-running the seed would overwrite pool membership edited in the app.
python -m plutus.scripts.seed_universe --csv "UserData/Vicky - Master Template - Master.csv"
python -m plutus.scripts.run_daily_sync
python -m plutus.scripts.run_scan

# 5. API + frontend
python -m plutus.scripts.run_api     # http://127.0.0.1:8000 (PLUTUS_API_PORT to override)
cd frontend_v2 && cp .env.example .env.local && npm install && npm run dev
```

## Tests

```bash
python -m pytest plutus/ -q          # backend (pure unit tests)
cd frontend_v2 && npm run test       # Vitest — domain math in src/lib
```

## Scheduled jobs (GitHub Actions)

| Workflow | Schedule | Runs |
|----------|----------|------|
| `plutus-daily-sync.yml` | 12:30 UTC, Mon–Fri | daily sync → scan → canary |
| `plutus-quarterly-sync.yml` | Sundays 02:00 UTC | Screener quarterly fundamentals |
| `plutus-weekly-ratios.yml` | Fridays 23:30 UTC | Screener ratios refresh |
| `plutus-weekly-backup.yml` | Sundays 20:00 UTC | `pg_dump` → Supabase Storage |
| `plutus-tests.yml` | on push / PR | pytest + no-float gate |

## Hosting

Database on Supabase, FastAPI on Render, frontend on Vercel, cron on GitHub
Actions. See `Docs/Plutus_Free_Hosting_Guide.md`.

## Docs

| File | Purpose |
|------|---------|
| `Docs/Plutus_Plan.MD` | Architecture and product plan |
| `Docs/Plutus_Phased_Development.MD` | Stage-by-stage build log and guardrails (binding Prompt Note at top) |
| `Docs/Plutus_Local_and_Live_Runbook.md` | Local setup, testing, live deployment, rollback |
| `Docs/Plutus_Free_Hosting_Guide.md` | Fast path to hosting every piece on free tiers |
| `Docs/Plutus_Issue_Log.MD` | Bugs found and fixed, with root causes |
| `Docs/Plutus_Validation_Report.MD` | Data-source validation (yfinance / NSE / BSE) |
| `Docs/20_Percent_Rally_PineScript` | Original V20 Pine Script that `plutus/metrics/rally.py` ports |
