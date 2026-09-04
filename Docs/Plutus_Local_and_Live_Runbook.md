# Plutus — Local Setup, Testing & Live Deployment Runbook

> **Audience:** Anyone starting from a blank laptop.  
> **Goal:** Run a fully working Plutus stack locally, verify it end-to-end, then promote it to a live Supabase + Cloudflare/Vercel deployment.  
> **Scope:** Stages 1–8 as defined in `Docs/Plutus_Phased_Development.MD`.  
> **Last verified:** 391 pytest tests pass · Stage 8 complete.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites — Local Machine](#2-prerequisites--local-machine)
3. [Prerequisites — Accounts & Credentials](#3-prerequisites--accounts--credentials)
4. [One-Time Local Setup](#4-one-time-local-setup)
   - 4.1 [Clone the repository](#41-clone-the-repository)
   - 4.2 [Python environment (plutus backend)](#42-python-environment-plutus-backend)
   - 4.3 [Start the local Supabase stack](#43-start-the-local-supabase-stack)
   - 4.4 [Apply all 11 migrations](#44-apply-all-11-migrations)
   - 4.5 [Configure plutus environment variables](#45-configure-plutus-environment-variables)
   - 4.6 [Configure backend (screener.in)](#46-configure-backend-screenerin)
   - 4.7 [Frontend v2 — Node environment](#47-frontend-v2--node-environment)
5. [Local Testing — Full End-to-End Drill](#5-local-testing--full-end-to-end-drill)
   - 5.1 [Run the unit test suite (391 tests)](#51-run-the-unit-test-suite-391-tests)
   - 5.2 [Seed the stock universe](#52-seed-the-stock-universe)
   - 5.3 [Pilot fetch — yfinance smoke test](#53-pilot-fetch--yfinance-smoke-test)
   - 5.4 [Run the daily sync (dry-run then live)](#54-run-the-daily-sync-dry-run-then-live)
   - 5.5 [Run the scan engine](#55-run-the-scan-engine)
   - 5.6 [Run the API server and curl every endpoint](#56-run-the-api-server-and-curl-every-endpoint)
   - 5.7 [Start the frontend v2 dev server](#57-start-the-frontend-v2-dev-server)
   - 5.8 [Run the canary drift check](#58-run-the-canary-drift-check)
   - 5.9 [Test alerting locally](#59-test-alerting-locally)
   - 5.10 [Serve the Edge Function locally](#510-serve-the-edge-function-locally)
   - 5.11 [Run the quarterly sync](#511-run-the-quarterly-sync)
6. [What to Validate Before Going Live](#6-what-to-validate-before-going-live)
7. [Live Deployment — Step-by-Step](#7-live-deployment--step-by-step)
   - 7.1 [Create a Supabase project](#71-create-a-supabase-project)
   - 7.2 [Capture the three Supabase keys](#72-capture-the-three-supabase-keys)
   - 7.3 [Apply all migrations to the live DB](#73-apply-all-migrations-to-the-live-db)
   - 7.4 [Create the plutus-backups Storage bucket](#74-create-the-plutus-backups-storage-bucket)
   - 7.5 [Seed the live stock universe](#75-seed-the-live-stock-universe)
   - 7.6 [Seed canary fixtures](#76-seed-canary-fixtures)
   - 7.7 [Deploy the Edge Function](#77-deploy-the-edge-function)
   - 7.8 [Configure GitHub repository secrets](#78-configure-github-repository-secrets)
   - 7.9 [Manually trigger the daily sync workflow (first live run)](#79-manually-trigger-the-daily-sync-workflow-first-live-run)
   - 7.10 [Verify the backup workflow](#710-verify-the-backup-workflow)
   - 7.11 [Deploy the frontend v2](#711-deploy-the-frontend-v2)
   - 7.12 [Post-deploy smoke test](#712-post-deploy-smoke-test)
8. [Ongoing Operations & Cron Schedule](#8-ongoing-operations--cron-schedule)
9. [Alerting — Setup & Response Playbook](#9-alerting--setup--response-playbook)
10. [Backup & Restore Procedure](#10-backup--restore-procedure)
11. [Rollback Procedures](#11-rollback-procedures)
12. [Troubleshooting Matrix](#12-troubleshooting-matrix)
13. [Appendix A — Full Environment Variable Reference](#appendix-a--full-environment-variable-reference)
14. [Appendix B — All API Endpoints with Sample curl](#appendix-b--all-api-endpoints-with-sample-curl)
15. [Appendix C — Migration Order Reference](#appendix-c--migration-order-reference)
16. [Appendix D — Free-Tier Cost Reference](#appendix-d--free-tier-cost-reference)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GitHub Actions                              │
│  plutus-tests.yml       – CI on every push (391 pytest tests)       │
│  plutus-daily-sync.yml  – Mon–Fri 12:30 UTC (18:00 IST)            │
│  plutus-quarterly-sync.yml – Sunday 02:00 UTC                      │
│  plutus-weekly-backup.yml  – Sunday 20:00 UTC                      │
└───────────────┬─────────────────────────┬───────────────────────────┘
                │                         │
                ▼                         ▼
┌──────────────────────┐    ┌─────────────────────────────────────────┐
│  Python plutus/      │    │  Supabase (free tier)                   │
│  ├─ sync/worker.py   │───▶│  ├─ Postgres DB (11 migrations)         │
│  ├─ sync/quarterly.py│    │  ├─ Edge Function  plutus-api/index.ts  │
│  ├─ scan/engine.py   │    │  ├─ Storage bucket plutus-backups/      │
│  ├─ canary/runner.py │    │  └─ Realtime channels (sync_jobs)       │
│  ├─ scripts/ CLIs    │    └─────────────────┬───────────────────────┘
│  └─ api/app.py (dev) │                      │ HTTPS / Realtime WS
└──────────────────────┘                      ▼
                              ┌───────────────────────────────────┐
                              │  frontend_v2/  (React + Vite)     │
                              │  Hosted on Cloudflare Pages       │
                              │  or Vercel (free tier)            │
                              └───────────────────────────────────┘
```

**Key design constraints (never violated):**
- All money/ratio fields are `NUMERIC` in Postgres, `Decimal` in Python, `string` over the wire, formatted-only at render time. `float()` is banned in `plutus/metrics/`, `plutus/sync/`, `plutus/fundamentals/`, and `plutus/api/`.
- The Edge Function is the production data gateway. The Python FastAPI server (`plutus/api/app.py`) is local-dev only.
- RLS is live: `anon` key = read-only. `service_role` key = full write. Never expose the service-role key to the browser.

---

## 2. Prerequisites — Local Machine

Install the following before touching the repo. Version floors are the minimum tested versions.

### 2.1 Python

```bash
python3 --version   # need 3.10+
```

Install via [pyenv](https://github.com/pyenv/pyenv) (recommended) or your OS package manager. Python 3.11 is used in all GitHub Actions workflows.

```bash
# pyenv install (if using pyenv)
pyenv install 3.11.9
pyenv local 3.11.9
```

### 2.2 Node.js

```bash
node --version   # need 18+
npm --version    # need 9+
```

Install via [nvm](https://github.com/nvm-sh/nvm) or [volta](https://volta.sh/).

```bash
# nvm install (if using nvm)
nvm install 18
nvm use 18
```

### 2.3 Supabase CLI

The CLI powers the local stack (Postgres on port 54322, API on 54321, Studio on 54323).

```bash
# macOS
brew install supabase/tap/supabase

# Linux (replace VERSION with latest from https://github.com/supabase/cli/releases)
curl -Lo /tmp/supabase.tar.gz \
  https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz
tar -xzf /tmp/supabase.tar.gz -C /usr/local/bin
supabase --version   # should print e.g. 1.183.5
```

### 2.4 Docker

The Supabase local stack runs in Docker containers.

```bash
docker --version     # need 20+
docker compose version  # need v2 (not legacy docker-compose)
```

Install [Docker Desktop](https://docs.docker.com/get-docker/) or Docker Engine (Linux). Ensure the Docker daemon is **running** before `supabase start`.

### 2.5 Git

```bash
git --version   # need 2.30+
```

### 2.6 PostgreSQL client tools (optional, needed for backup/restore)

```bash
# Ubuntu / Debian
sudo apt-get install -y postgresql-client

# macOS
brew install libpq
echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc

pg_dump --version   # should print 14+
```

---

## 3. Prerequisites — Accounts & Credentials

| Account | Required for | Free tier |
|---------|-------------|-----------|
| **GitHub** | Repository, Actions CI/CD, secrets | ✅ Unlimited public repo minutes |
| **Supabase** | Database, Edge Function, Storage, Realtime | ✅ 1 project, 500 MB DB, 1 GB Storage |
| **Cloudflare Pages** _or_ **Vercel** | Frontend hosting | ✅ Unlimited requests / 100 GB bandwidth |
| **webhook.site** | Alert testing (temporary) | ✅ Free, no signup needed |

### Screener.in (optional, quarterly fundamentals)

Register at [screener.in/register](https://www.screener.in/register/). Free account works. Credentials go in `backend/.env` (used by `backend/app/services/screener_data_fetcher.py`). If you skip this, quarterly fundamentals will be fetched from yfinance only.

---

## 4. One-Time Local Setup

### 4.1 Clone the repository

```bash
git clone https://github.com/<your-org>/Buddy.git
cd Buddy
```

> **Tip:** All paths in this runbook are relative to the repo root (`Buddy/`).

---

### 4.2 Python environment (plutus backend)

Create an isolated virtual environment and install pinned dependencies.

```bash
# From repo root
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install --upgrade pip
pip install -r plutus/requirements.txt
```

**What gets installed** (`plutus/requirements.txt`):

| Package | Purpose | Version floor |
|---------|---------|--------------|
| `yfinance` | OHLCV + info fetch from Yahoo Finance | 0.2.40 |
| `pandas` | DataFrame manipulation in sync worker | 2.0 |
| `requests` | HTTP calls from yfinance internally | 2.31 |
| `supabase` | Python Supabase client (upserts, reads) | 2.5.0 |
| `postgrest` | PostgREST query builder used by supabase-py | 0.16.0 |
| `fastapi` | Local dev API server (`run_api.py`) | 0.100 |
| `uvicorn` | ASGI server for fastapi | 0.23 |
| `httpx` | Required by fastapi.testclient | 0.24 |
| `python-dotenv` | `.env` file loading in `plutus/config.py` | 1.0 |
| `pytest` | Test runner | 8.0 |

Verify:

```bash
python -c "import yfinance, supabase, fastapi; print('OK')"
python -m pytest plutus/ --collect-only -q 2>/dev/null | tail -1
# Expected output:  391 tests collected
```

---

### 4.3 Start the local Supabase stack

The `supabase/` directory at repo root is initialised (`supabase/config.toml`,
project id `plutus`). You **do not** need to run `supabase init`.

> ⚠️ **Port remap:** this repo's local stack runs on **56321–56329**
> (API 56321, DB 56322, Studio 56323, Mailpit 56324) instead of the CLI
> defaults 54321–54324, so it can coexist with other Supabase projects on
> the same machine. Wherever this runbook or the Supabase docs mention a
> `54xxx` port, substitute the matching `56xxx` port. The `plutus/.env`
> and `frontend_v2/.env.local` examples below already use the remapped ports.
>
> (History: the stack originally used 55321–55329, but on 2026-09-04 Windows'
> Hyper-V dynamic port exclusions swallowed the whole 55266–55365 range after
> a reboot — `netsh interface ipv4 show excludedportrange protocol=tcp` shows
> the reservations — so `supabase/config.toml` was remapped to 563xx, which
> sits outside every excluded range.)

```bash
supabase start
```

This pulls Docker images on first run (~2 min). Subsequent starts are faster (~15 s). When it completes it prints:

```
Started supabase local development setup.

         API URL: http://localhost:54321
     GraphQL URL: http://localhost:54321/graphql/v1
          DB URL: postgresql://postgres:postgres@localhost:54322/postgres
      Studio URL: http://localhost:54323
    Inbucket URL: http://localhost:54324
        anon key: eyJ...   <-- copy this
service_role key: eyJ...   <-- copy this
```

**Save those two keys.** You need them in the next step.

> **Supabase Studio** at `http://localhost:54323` is a full Postgres GUI — use it to inspect tables, run ad-hoc SQL, and verify migration results.

To stop the stack cleanly (preserves data across restarts by default):

```bash
supabase stop
```

To wipe all local data and start fresh:

```bash
supabase stop --no-backup
supabase start
```

---

### 4.4 Apply all 11 migrations

The `supabase start` command only applies migrations under `supabase/migrations/`. The Plutus SQL files live in `plutus/migrations/` and must be applied manually once.

> **Why manually?** The Python plutus package is intentionally decoupled from the Supabase CLI project so it can run against any Postgres — local, staging, or production — by simply pointing env vars at a different URL.

Apply in strict ascending order (the filename prefix IS the order):

```bash
# Ensure you are in the repo root with the venv active
DB="postgresql://postgres:postgres@localhost:54322/postgres"

for f in $(ls plutus/migrations/*.sql | sort); do
  echo "── Applying $f"
  psql "$DB" -f "$f"
done
```

**Expected output per file** (no errors):

```
── Applying plutus/migrations/001_stocks.sql
CREATE TABLE
CREATE INDEX
...
── Applying plutus/migrations/011_canary_checks.sql
CREATE TABLE
CREATE INDEX
...
```

**What each migration creates:**

| File | Creates |
|------|---------|
| `001_stocks.sql` | `stocks` table + `plutus_touch_updated_at()` trigger function |
| `002_pools.sql` | `pools` table |
| `003_daily_snapshots.sql` | `daily_snapshots` table (NUMERIC columns only) |
| `004_fundamentals.sql` | `fundamentals` table |
| `005_strategy_configs.sql` | `strategy_configs` table |
| `006_scans_and_results.sql` | `scans` + `scan_results` tables |
| `007_trades.sql` | `trades` table (schema only; writes gated to V2) |
| `008_sync_jobs.sql` | `sync_jobs` audit table |
| `009_views.sql` | `v_stocks_latest` + `v_fundamentals_latest` views |
| `010_rls.sql` | Row Level Security — anon read, service_role write |
| `011_canary_checks.sql` | `canary_checks` table (Stage 8 drift fixtures) |

Verify in Studio or psql:

```bash
psql "$DB" -c "\dt" | grep -E "stocks|pools|daily_snapshots|sync_jobs|canary"
```

---

### 4.5 Configure plutus environment variables

```bash
cd plutus
cp .env.example .env
```

Open `plutus/.env` and fill in:

```dotenv
# ---- Supabase (required) ----
PLUTUS_SUPABASE_URL=http://localhost:54321
PLUTUS_SUPABASE_SERVICE_KEY=<service_role key from supabase start output>
PLUTUS_SUPABASE_ANON_KEY=<anon key from supabase start output>

# ---- yfinance tuning (optional — defaults are fine for dev) ----
PLUTUS_YF_TIMEOUT_SECONDS=30
PLUTUS_YF_MAX_RETRIES=3
PLUTUS_YF_BATCH_SIZE=50

# ---- Sync worker (optional) ----
PLUTUS_SYNC_BATCH_SIZE=50
PLUTUS_SYNC_HISTORY_YEARS=5

# ---- Runtime ----
PLUTUS_ENV=dev
PLUTUS_LOG_LEVEL=INFO
```

> **Security:** `plutus/.env` is listed in `plutus/.gitignore`. It will never be committed.

Verify config loads correctly:

```bash
cd ..   # back to repo root
python -c "
import os, sys
os.chdir('plutus')
from dotenv import load_dotenv
load_dotenv('.env')
from plutus.config import get_settings
s = get_settings()
print('URL:', s.supabase_url)
print('ENV:', s.environment)
print('OK')
"
```

Expected output:

```
URL: http://localhost:54321
ENV: dev
OK
```

---

### 4.6 Configure Screener.in credentials (REQUIRED for the quarterly sync)

**Tier B (quarterly fundamentals) is sourced from Screener.in** — the same
authenticated front-page fetch proven in legacy Buddy (quarterly results
table, top ratios, quick ratios, shareholding pattern). Screener renders
data only for logged-in users, so credentials are required; the quarterly
worker aborts fast without them.

Add to `plutus/.env` (NOT backend/.env — that belongs to legacy Buddy):

```dotenv
SCREENER_EMAIL=your@email.com
SCREENER_PASSWORD=yourpassword
PLUTUS_SCREENER_COOLDOWN_S=15    # pause between symbols (rate-limit etiquette)
```

Notes:
- One login per run; HTTP 429 on login gets a 65 s back-off + one retry.
- The cooldown activates when more than 5 symbols are synced (legacy
  Buddy used 20 s; 15 s is fine at quarterly cadence). Full 440-symbol
  run ≈ 2 hours — the GitHub Actions workflow timeout is set to 240 min.
- Custom "quick ratios" on your Screener account (5Yrs PE, 5Yrs PBV,
  Net Debt to Equity, Pledged percentage) are fetched via the same Ajax
  call the browser makes and stored when present; the public chart API
  fills 5Y PE/PBV averages when the quick ratios are absent.

---

### 4.7 Frontend v2 — Node environment

```bash
cd frontend_v2
npm install
```

This installs all dependencies from `package.json`, including:

| Package | Purpose |
|---------|---------|
| `react` + `react-dom` | UI framework |
| `react-router-dom` | Client-side routing (pools, pool detail, sync status) |
| `@tanstack/react-query` | Server-state caching, polling, cache invalidation |
| `@supabase/supabase-js` | Realtime channel subscription for the sync-jobs pill |
| `tailwindcss` | Utility-first styling |
| `vite` | Dev server + build tool |
| `typescript` | Type safety |

Configure the frontend environment:

```bash
cp .env.example .env.local
```

Open `frontend_v2/.env.local` and set:

```dotenv
# Points to the local Supabase Edge Function (served via supabase functions serve)
VITE_PLUTUS_API_URL=http://localhost:54321/functions/v1/plutus-api

# OR point directly at the FastAPI dev server (both have identical routes)
# VITE_PLUTUS_API_URL=http://localhost:8000

# For Realtime (sync-jobs pill) — use local Supabase keys
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<anon key from supabase start output>
```

Return to repo root:

```bash
cd ..
```

---

## 5. Local Testing — Full End-to-End Drill

Run these steps **in order**. Each step depends on the previous one having succeeded.

---

### 5.1 Run the unit test suite (391 tests)

```bash
# From repo root, venv active
python -m pytest plutus/ -v
```

Expected summary line:

```
391 passed in X.XXs
```

**What the test suite covers:**

| Test file | What it tests |
|-----------|--------------|
| `test_config.py` | Config loader, ConfigError on missing keys |
| `test_validators.py` | Symbol validation, sanity checks |
| `test_yf_client.py` | yfinance adapter, retry logic, Result type |
| `test_supabase_client.py` | bulk_upsert chunking, retry, UpsertReport |
| `test_metrics_*.py` (7 files) | ATH, cap_bucket, 200DMA, PE/PB, pipeline, rally, week52 — all Decimal, zero float |
| `test_sync_worker.py` | DailySyncWorker run_symbol + run_all |
| `test_history_builder.py` | DataFrame → bars normalisation |
| `test_quarterly_sync_worker.py` | QuarterlySyncWorker |
| `test_fundamentals_quarterly.py` | Fundamental data model |
| `test_scan_engine.py` | ScanEngine orchestration |
| `test_strategy_*.py` (4 files) | Each scan strategy |
| `test_api_app.py` | FastAPI routes, CORS, 404/502 handling |
| `test_api_repository.py` | Repository functions |
| `test_api_serializers.py` | Decimal-to-string wire serialisation |
| `test_seed_universe.py` | CSV parsing, pool tag detection |
| `test_alerts_notifier.py` | Webhook dispatch, retry loop, backoff |
| `test_alerts_sync_hook.py` | Silence-on-green, severity mapping |
| `test_canary_runner.py` | Drift evaluation, Decimal math, alert dispatch |
| `test_canary_migration.py` | `canary_checks` schema integrity |
| `test_run_canary_cli.py` | CLI exit codes |
| `test_deployment_config.py` | Money-safety gate, workflow artifact existence |
| `test_rls_migration.py` | Policy set integrity |
| `test_run_daily_sync_cli.py` | CLI arguments, exit codes |
| `test_run_quarterly_sync_cli.py` | CLI arguments |
| `test_run_scan_cli.py` | Scan CLI |
| `test_fields.py` + `test_types.py` | Registry field definitions |

If any test fails, **stop here** and fix it before proceeding to live data. The tests are the contract; live runs amplify problems.

---

### 5.2 Seed the stock universe

This populates the `stocks` table from the master CSV. It is idempotent — re-running it is safe.

```bash
# Dry-run first (no DB writes)
python -m plutus.scripts.seed_universe \
  --csv "UserData/Vicky - Master Template - Master.csv" \
  --dry-run

# Live run
python -m plutus.scripts.seed_universe \
  --csv "UserData/Vicky - Master Template - Master.csv"
```

**Expected output (live run):**

```json
{
  "dry_run": false,
  "row_count": 442,
  "succeeded": 442,
  "failed": 0,
  "errors": [],
  "latency_ms": 312
}
```

`row_count` will match the number of valid tickers in your CSV. Zero `failed` is mandatory.

**What the seeder does:**
- Reads `Ticker`, `Cap Type`, `Flagship 40 (F40)`, `Emerging 40 (E40)`, `Smartpick 200 (S200)`, `All listed` columns.
- Appends `.NS` to tickers without an exchange suffix.
- Assigns `pools: ["F40", "E40", ...]` based on which pool columns are marked.
- Upserts on `symbol` conflict — existing rows are updated, not duplicated.

Verify in Studio:

```sql
SELECT symbol, pools, active FROM stocks ORDER BY symbol LIMIT 10;
```

---

### 5.3 Pilot fetch — yfinance smoke test

Fetches 5 pilot symbols live from Yahoo Finance and writes fixtures to `plutus/tests/fixtures/pilot/`.

```bash
python -m plutus.scripts.pilot_fetch
```

**Expected output:**

```json
{
  "pilot_results": [
    { "symbol": "RELIANCE.NS", "info_ok": true, "history_ok": true, ... },
    { "symbol": "TCS.NS",      "info_ok": true, "history_ok": true, ... },
    ...
  ]
}
```

`info_ok` and `history_ok` must both be `true` for all five symbols. If either is `false`:
- Check your internet connection.
- Yahoo Finance rate-limits aggressively from IPs that send many requests quickly. Wait 30 seconds and retry.
- If `history_ok` fails for a specific symbol, the ticker may have been delisted or renamed; verify on [finance.yahoo.com](https://finance.yahoo.com).

---

### 5.4 Run the daily sync (dry-run then live)

**Step 1 — Dry-run (no DB writes, validates the pipeline):**

```bash
python -m plutus.scripts.run_daily_sync \
  --symbols RELIANCE.NS,TCS.NS,INFY.NS \
  --dry-run
```

**Expected output:**

```json
{
  "job_type": "daily_sync",
  "dry_run": true,
  "symbols_total": 3,
  "symbols_ok": 3,
  "symbols_failed": 0,
  "snapshots_written": 0,
  ...
}
```

**Step 2 — Live run with a small subset:**

```bash
python -m plutus.scripts.run_daily_sync \
  --symbols RELIANCE.NS,TCS.NS,INFY.NS,ITC.NS,PAGEIND.NS \
  --limit 5
```

Expected:

```json
{
  "symbols_total": 5,
  "symbols_ok": 5,
  "symbols_failed": 0,
  "snapshots_written": 5,
  ...
}
```

**Step 3 — Full universe run (one pool):**

```bash
python -m plutus.scripts.run_daily_sync --pool F40
```

This syncs all Flagship 40 stocks. Takes ~2–5 minutes on a typical internet connection.

**Step 4 — All pools:**

```bash
python -m plutus.scripts.run_daily_sync
```

Verify in Studio:

```sql
SELECT symbol, snapshot_date, close, dma_200, cap_bucket
FROM daily_snapshots
ORDER BY snapshot_date DESC
LIMIT 20;
```

> **What the sync worker does internally:**
> 1. `yf_client.fetch_info(symbol)` — gets market cap, P/E, P/B, sector, etc.
> 2. `yf_client.fetch_history(symbol)` — gets 5 years of daily OHLCV bars.
> 3. `history_builder.bars_from_df()` — normalises the DataFrame to `List[Bar]`.
> 4. `metrics/pipeline.compute_snapshot()` — computes all 20+ metrics using `Decimal`.
> 5. `supabase_client.bulk_upsert()` — writes to `daily_snapshots` via PostgREST.
> 6. `sync_jobs` row is upserted with the run summary.

---

### 5.5 Run the scan engine

The scan engine evaluates all registered strategies against the latest daily snapshots.

```bash
TODAY=$(date -u +%Y-%m-%d)

# Run all 4 strategies on F40
python -m plutus.scripts.run_scan \
  --pool F40 \
  --as-of "$TODAY" \
  --triggered-by manual

# Dry-run to see output without DB writes
python -m plutus.scripts.run_scan \
  --pool F40 \
  --as-of "$TODAY" \
  --triggered-by manual \
  --dry-run
```

**Expected output:**

```json
{
  "pool_code": "F40",
  "snapshot_date": "2025-01-15",
  "total_stocks": 40,
  "upsert_errors": [],
  ...
}
```

Exit code 0 = success. Exit code 1 = partial errors. Exit code 2 = no snapshots found (run sync first).

**Registered strategies** (from `plutus/scan/registry.py`):
- `envelope_200dma` — buy zone when price is between 200-DMA and envelope
- `week52_high_low` — breakout/breakdown relative to 52-week range
- `rally_20_percent` — validates a ≥20% rally with pullback structure
- `fundamental_screener` — ROCE / ROE / pledging screen

Run all four pools sequentially:

```bash
for POOL in F40 E40 S200 PlayArea; do
  python -m plutus.scripts.run_scan \
    --pool "$POOL" \
    --as-of "$TODAY" \
    --triggered-by manual
done
```

---

### 5.6 Run the API server and curl every endpoint

**Start the server:**

```bash
python -m plutus.scripts.run_api
```

The FastAPI server starts on `http://localhost:8000`. Keep this terminal open and open a second terminal for the curl commands below.

**Swagger UI:** [http://localhost:8000/api/docs](http://localhost:8000/api/docs)

**Test all 10 endpoints:**

```bash
BASE="http://localhost:8000"

# 1. Health
curl -s "$BASE/api/health" | python3 -m json.tool
# → {"status":"ok","service":"plutus-api","version":"0.7.0"}

# 2. Pools
curl -s "$BASE/api/pools" | python3 -m json.tool

# 3. Stocks (all)
curl -s "$BASE/api/stocks" | python3 -m json.tool

# 4. Stocks filtered by pool
curl -s "$BASE/api/stocks?pool=F40" | python3 -m json.tool

# 5. Single stock
curl -s "$BASE/api/stocks/RELIANCE.NS" | python3 -m json.tool

# 6. Latest snapshots for a pool
curl -s "$BASE/api/snapshots/latest?pool=F40" | python3 -m json.tool

# 7. Historical bars for a symbol
curl -s "$BASE/api/snapshots/RELIANCE.NS/history?days=30" | python3 -m json.tool

# 8. Latest scan for a pool
curl -s "$BASE/api/scans/latest?pool=F40" | python3 -m json.tool

# 9. Sync jobs
curl -s "$BASE/api/sync_jobs/latest?limit=5" | python3 -m json.tool

# 10. Fundamentals
curl -s "$BASE/api/fundamentals/RELIANCE.NS/latest" | python3 -m json.tool
```

**What to verify in every response:**
- HTTP 200 (no 500 or 502).
- Money fields (`close`, `dma_200`, `pe`, `pb`, etc.) are **strings**, not numbers. Example: `"close": "2547.35"`, NOT `"close": 2547.35`. This is the money-safety wire contract enforced by `plutus/api/serializers.py`.

Stop the server with `Ctrl+C` when done.

---

### 5.7 Start the frontend v2 dev server

Open a new terminal:

```bash
cd frontend_v2
npm run dev
```

Output:

```
  VITE v5.x ready in 350 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: ...
```

Open [http://localhost:5173](http://localhost:5173) in a browser.

**What to verify:**

| Page | URL | Expected |
|------|-----|----------|
| Pools list | `/pools` | Cards for F40, E40, S200, PlayArea |
| Pool detail | `/pools/F40` | Table of stocks with snapshot metrics |
| Sync status | `/status` | Table of recent sync_jobs rows with status pills |

**Realtime pill test:** Open the Sync Status page. In a separate terminal run a sync:

```bash
python -m plutus.scripts.run_daily_sync --symbols INFY.NS
```

If `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are configured in `.env.local`, the sync-jobs table updates within 1–2 seconds without a page refresh (Realtime channel). If the env vars are missing, the table updates after the 60-second polling interval.

**TypeScript type-check:**

```bash
cd frontend_v2
npm run typecheck
# Should exit 0 with no errors
```

**Lint:**

```bash
npm run lint
```

---

### 5.8 Run the canary drift check

The canary verifies that known-good historical closes haven't drifted.

**First, seed at least one fixture:**

```bash
DB="postgresql://postgres:postgres@localhost:54322/postgres"
psql "$DB" <<'SQL'
INSERT INTO canary_checks (symbol, check_date, expected_close, tolerance_pct, notes)
VALUES
  ('RELIANCE.NS', '2024-01-02', 2500.00, 0.005, 'Stage 8 seed fixture'),
  ('TCS.NS',      '2024-01-02', 3800.00, 0.005, 'Stage 8 seed fixture')
ON CONFLICT (symbol, check_date) DO NOTHING;
SQL
```

> **Note:** The `expected_close` values above are illustrative. Look up the actual closing price for those dates from your `daily_snapshots` table after the sync has run, or from Yahoo Finance directly.

**Run the canary:**

```bash
python -m plutus.scripts.run_canary
```

**Expected output (fixture match):**

```json
{
  "checked": 2,
  "ok": 2,
  "drift": 0,
  "missing": 0,
  "error": 0,
  "outcomes": [
    { "symbol": "RELIANCE.NS", "status": "ok", "drift_pct": "0.000123", ... },
    { "symbol": "TCS.NS",      "status": "ok", "drift_pct": "-0.000045", ... }
  ]
}
```

Exit code 0 = all ok. Exit code 1 = drift/missing/error. Exit code 2 = orchestration failure.

**Force a drift to test alerting path:**

```bash
# Temporarily set an obviously wrong expected value
psql "$DB" -c "UPDATE canary_checks SET expected_close = 1.00 WHERE symbol = 'RELIANCE.NS';"
python -m plutus.scripts.run_canary --no-alert    # drift shown, no webhook call
python -m plutus.scripts.run_canary               # drift shown + alert if webhook configured
# Restore
psql "$DB" -c "UPDATE canary_checks SET expected_close = 2500.00 WHERE symbol = 'RELIANCE.NS';"
```

---

### 5.9 Test alerting locally

**Get a free webhook test URL:**

1. Open [https://webhook.site](https://webhook.site) in a browser.
2. Copy the unique URL shown (e.g. `https://webhook.site/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).

**Set the webhook in your shell:**

```bash
export PLUTUS_ALERT_WEBHOOK="https://webhook.site/your-unique-id"
```

**Trigger an alert from the sync hook:**

```bash
# Run a sync that will partially fail (use a deliberately bad ticker)
python -m plutus.scripts.run_daily_sync \
  --symbols BADTICKER_DOESNOTEXIST.NS,RELIANCE.NS
```

Because `BADTICKER_DOESNOTEXIST.NS` will fail to fetch, the run report has `symbols_failed: 1`. The `maybe_alert_on_run_report()` call maps this to `severity: "warning"` and dispatches the payload.

Check webhook.site — you should see a POST with body:

```json
{
  "text": "⚠️ *Plutus daily_sync degraded — 2025-01-15*\njob_type: daily_sync\n...",
  "severity": "warning",
  ...
}
```

**Test canary alert:**

```bash
python -m plutus.scripts.run_canary   # with bad expected_close from step 5.8
```

**Clear the env var after testing:**

```bash
unset PLUTUS_ALERT_WEBHOOK
```

---

### 5.10 Serve the Edge Function locally

For full production-parity testing, serve the Deno Edge Function through the local Supabase stack.

Open a new terminal:

```bash
supabase functions serve plutus-api \
  --env-file plutus/.env \
  --no-verify-jwt
```

The function is now available at `http://localhost:54321/functions/v1/plutus-api`.

Update `frontend_v2/.env.local` if needed:

```dotenv
VITE_PLUTUS_API_URL=http://localhost:54321/functions/v1/plutus-api
```

Test it:

```bash
curl -s "http://localhost:54321/functions/v1/plutus-api/api/health"
# → {"status":"ok","service":"plutus-api","version":"0.7.0"}
```

All 10 API endpoints work identically through the Edge Function and the Python FastAPI server — same routes, same wire format.

---

### 5.11 Run the quarterly sync

```bash
python -m plutus.scripts.run_quarterly_sync \
  --symbols RELIANCE.NS,TCS.NS \
  --dry-run

# Live run
python -m plutus.scripts.run_quarterly_sync \
  --symbols RELIANCE.NS,TCS.NS
```

The quarterly sync fetches everything from **Screener.in's authenticated
company page** (see §4.6): quarterly Sales/OPM/PBT/Net Profit (all quarters
shown), ROCE, ROE, Net Debt to Equity, pledging, 5Y PE/PBV, and the
shareholding pattern (Promoters / FIIs+DIIs / Public). Money lands in the
DB as absolute rupees (Screener prints ₹ Cr; converted once at extraction).
It is slower than the daily sync by design — a 15 s cooldown separates
symbols to respect Screener's rate limits.

**Manual overrides (CSV upload for ROCE / ROE / pledging corrections):**

The overrides CSV is NOT the master template — it must carry `symbol` and
`quarter_end_date` columns plus any of `roce`, `roe`,
`promoter_pledging_pct`, `promoter_holding_pct`. Example
`UserData/fundamental_overrides.csv`:

```csv
symbol,quarter_end_date,roce,roe,promoter_pledging_pct
RELIANCE.NS,2026-06-30,9.8,8.5,0.0
TCS.NS,2026-06-30,64.6,52.4,0.0
```

```bash
python -m plutus.scripts.run_quarterly_sync \
  --overrides-csv "UserData/fundamental_overrides.csv"
```

---

## 6. What to Validate Before Going Live

Run this checklist. All items must be green before deploying to production.

```
[ ] 391 pytest tests pass with no failures
[ ] seed_universe runs with 0 failures
[ ] pilot_fetch returns info_ok=true and history_ok=true for all 5 symbols
[ ] run_daily_sync with --dry-run exits 0
[ ] run_daily_sync (live, 5 symbols) exits 0, snapshots_written=5
[ ] run_scan exits 0 for at least one pool
[ ] All 10 API endpoints return HTTP 200 with money fields as strings
[ ] Frontend loads /pools, /pools/F40, /status without JS errors (check browser console)
[ ] run_canary exits 0 (after seeding at least one correct fixture)
[ ] Alert webhook fires when run_daily_sync has a failing symbol
[ ] npm run typecheck exits 0
[ ] npm run lint exits 0 (or 0 warnings you accept)
```

---

## 7. Live Deployment — Step-by-Step

### 7.1 Create a Supabase project

1. Sign in at [supabase.com](https://supabase.com).
2. Click **New project**.
3. Choose a name (e.g. `plutus-prod`), a strong database password, and the **ap-south-1 (Mumbai)** region for lowest latency to NSE.
4. Wait ~2 minutes for provisioning.

---

### 7.2 Capture the three Supabase keys

In your project dashboard → **Settings** → **API**:

| Key | Location | Used by |
|-----|----------|---------|
| **Project URL** | `https://<ref>.supabase.co` | All consumers |
| **anon / public** | API Keys section | Frontend (read-only via RLS) |
| **service_role** | API Keys section | Python workers, GitHub Actions |

Also from **Settings** → **Database** → **Connection string** → **URI mode**:

```
postgresql://postgres:<your-password>@db.<ref>.supabase.co:5432/postgres?sslmode=require
```

This is `PLUTUS_SUPABASE_DB_URL` (used only by the weekly backup workflow).

> ⚠️ **Never commit these keys.** Never expose `service_role` in the browser or in any public log.

---

### 7.3 Apply all migrations to the live DB

**Option A — Supabase SQL Editor (recommended for first setup)**

1. Open your project → **SQL Editor**.
2. Paste the contents of each migration file in order (001 through 011).
3. Click **Run** after each one. Confirm no error messages.

**Option B — psql via the connection URI**

```bash
LIVE_DB="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres?sslmode=require"

for f in $(ls plutus/migrations/*.sql | sort); do
  echo "── Applying $f"
  psql "$LIVE_DB" -f "$f"
done
```

Verify:

```bash
psql "$LIVE_DB" -c "\dt" | grep -c "stocks\|pools\|snapshots\|canary"
# Should return 5 or more
```

---

### 7.4 Create the plutus-backups Storage bucket

1. In Supabase dashboard → **Storage** → **New bucket**.
2. Name: `plutus-backups`.
3. Toggle **Public**: **OFF** (private — service role only).
4. Click **Create bucket**.

**Set a 30-day lifecycle rule (cost control):**

Currently Supabase doesn't expose lifecycle rules in the dashboard UI. You have two options:

- **Option A:** Add a cleanup step in the backup workflow to delete backups older than 30 days (see `plutus-weekly-backup.yml` comments).
- **Option B:** Manually delete old backups monthly via the Storage UI.
- **Option C:** Use the Supabase Management API to set lifecycle policies once available.

The free tier includes 1 GB Storage. A gzipped weekly dump of 300 stocks × 5 years of daily snapshots is approximately 20–40 MB, so you get 25–50 weeks before you hit the limit.

---

### 7.5 Seed the live stock universe

With `PLUTUS_SUPABASE_URL` and `PLUTUS_SUPABASE_SERVICE_KEY` pointing at the live project:

```bash
# Set live credentials in your shell (do NOT commit these)
export PLUTUS_SUPABASE_URL="https://<ref>.supabase.co"
export PLUTUS_SUPABASE_SERVICE_KEY="<service-role-key>"

python -m plutus.scripts.seed_universe \
  --csv "UserData/Vicky - Master Template - Master.csv"
```

Verify in the Supabase Table Editor:

```sql
SELECT COUNT(*), COUNT(DISTINCT unnest(pools)) FROM stocks WHERE active = true;
```

---

### 7.6 Seed canary fixtures

Canary fixtures must match real historical closes. The safest approach: run the daily sync first for at least one day, then pin the observed close.

```sql
-- Replace values with actual closes from your daily_snapshots table
INSERT INTO canary_checks (symbol, check_date, expected_close, tolerance_pct, notes)
VALUES
  ('RELIANCE.NS', '2024-01-02', 2547.35, 0.005, 'Live prod fixture — Stage 8'),
  ('TCS.NS',      '2024-01-02', 3987.10, 0.005, 'Live prod fixture — Stage 8'),
  ('INFY.NS',     '2024-01-02', 1567.20, 0.005, 'Live prod fixture — Stage 8')
ON CONFLICT (symbol, check_date) DO NOTHING;
```

> **Best practice:** Use one fixture per pool (F40, E40, S200, PlayArea) so a data-source issue with any pool is caught.

---

### 7.7 Deploy the Edge Function

Install the Supabase CLI and link it to your live project:

```bash
supabase login
supabase link --project-ref <ref>
```

Deploy:

```bash
supabase functions deploy plutus-api --no-verify-jwt
```

`--no-verify-jwt` is required because this is a public read-only API (RLS enforces access — no user JWT needed).

The function is deployed to:

```
https://<ref>.functions.supabase.co/plutus-api
```

Smoke test immediately:

```bash
curl -s "https://<ref>.functions.supabase.co/plutus-api/api/health"
# → {"status":"ok","service":"plutus-api","version":"0.7.0"}
```

**Environment variables the Edge Function reads automatically:**

The Supabase runtime injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` automatically into every deployed function. You do not need to set these manually.

---

### 7.8 Configure GitHub repository secrets

Go to your GitHub repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

Add each secret exactly as named:

| Secret name | Value | Used in workflow |
|-------------|-------|-----------------|
| `PLUTUS_SUPABASE_URL` | `https://<ref>.supabase.co` | Daily, Quarterly, Backup |
| `PLUTUS_SUPABASE_SERVICE_KEY` | service-role JWT | Daily, Quarterly, Backup |
| `PLUTUS_SUPABASE_DB_URL` | `postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres?sslmode=require` | Backup only |
| `PLUTUS_ALERT_WEBHOOK` | Slack/Discord/webhook.site URL | Daily, Quarterly, Backup (optional) |

> **Why 4 secrets?** The DB URL contains the raw password — it is kept separate from the API key (`service_role`) and only injected into the backup workflow that needs `pg_dump` access.

---

### 7.9 Manually trigger the daily sync workflow (first live run)

**Always trigger manually before relying on the cron.** This verifies secrets, DB connectivity, and yfinance access from GitHub's infrastructure.

1. Go to your repository → **Actions** tab.
2. Select **plutus-daily-sync** in the left sidebar.
3. Click **Run workflow** (top-right).
4. Fill in:
   - **Pool code:** `F40` (start with one pool)
   - **Symbol cap:** `10` (limit for first run)
   - **Dry run:** `false`
5. Click **Run workflow**.

Watch the run. All three steps must be green:
- `Run daily sync` — exit 0
- `Run scan` — exit 0
- `Verify canary fixtures` — exit 0 or canary step passes

If any step fails:
- Click the step to expand logs.
- Common issue: `ConfigError` = a secret is missing or misspelled.
- Common issue: `supabase.exceptions.APIError` = wrong URL or key.

Once F40 manual run is green, run without limits:

```
Pool code: (leave blank = ALL)
Symbol cap: (leave blank)
Dry run: false
```

After this succeeds, **enable the cron** by confirming `.github/workflows/plutus-daily-sync.yml` has `schedule: - cron: "30 12 * * 1-5"` (it already does). The cron activates automatically once the workflow exists in the `main` branch.

---

### 7.10 Verify the backup workflow

1. Go to **Actions** → **plutus-weekly-backup**.
2. Click **Run workflow** manually.

Expected steps:
1. `Install Postgres client` — apt-get installs `postgresql-client`.
2. `Compute filename` — generates `plutus-YYYYMMDD-HHMMSS.sql.gz`.
3. `pg_dump | gzip` — connects to live DB via `PLUTUS_SUPABASE_DB_URL`, dumps, compresses.
4. `Upload to Supabase Storage` — uploads to the `plutus-backups` bucket.

Verify the upload in **Supabase Storage** → `plutus-backups`. You should see a `.sql.gz` file.

The workflow runs automatically every Sunday at 20:00 UTC. It does not interfere with the quarterly sync (Sunday 02:00 UTC — 18 hours earlier).

---

### 7.11 Deploy the frontend v2

**Cloudflare Pages (recommended):**

1. Push your repo to GitHub (if not already).
2. In Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Select your repo.
4. Build settings:
   - **Build command:** `npm install && npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** `frontend_v2`
5. In **Environment variables** (add for both Production and Preview):

   | Variable | Value |
   |----------|-------|
   | `VITE_PLUTUS_API_URL` | `https://<ref>.functions.supabase.co/plutus-api` |
   | `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | your anon/public key |

6. Click **Save and Deploy**.

**Vercel (alternative):**

1. Import repo at [vercel.com](https://vercel.com/new).
2. Set **Root Directory** to `frontend_v2`.
3. Framework auto-detects Vite.
4. Add the same three env vars under **Settings** → **Environment Variables**.
5. Deploy.

Both hosts auto-deploy on every push to `main`. SPA routing is handled by `frontend_v2/public/_redirects` (already in the repo).

---

### 7.12 Post-deploy smoke test

Run this checklist after every deployment:

```bash
API="https://<ref>.functions.supabase.co/plutus-api"
FRONTEND="https://your-app.pages.dev"   # or .vercel.app

# 1. Edge Function health
curl -s "$API/api/health"
# → {"status":"ok","service":"plutus-api","version":"0.7.0"}

# 2. Pools populated
curl -s "$API/api/pools" | python3 -m json.tool | grep '"code"'

# 3. Stocks in F40
curl -s "$API/api/stocks?pool=F40" | python3 -m json.tool | grep '"count"'

# 4. Latest snapshots
curl -s "$API/api/snapshots/latest?pool=F40" | python3 -m json.tool | grep '"count"'

# 5. Frontend loads (HTTP 200)
curl -s -o /dev/null -w "%{http_code}" "$FRONTEND"
# → 200

# 6. Canary (via Actions manual trigger)
# Go to Actions → plutus-daily-sync → Run workflow → watch Verify canary step
```

**Browser checks:**
1. Open the deployed frontend URL.
2. `/pools` — all 4 pool cards visible.
3. `/pools/F40` — stocks table with metric columns populated.
4. `/status` — sync_jobs table with at least one row, status pill green.

---

## 8. Ongoing Operations & Cron Schedule

| Workflow | Cron | UTC Time | IST Time | Purpose |
|----------|------|----------|----------|---------|
| `plutus-daily-sync` | `30 12 * * 1-5` | 12:30 Mon–Fri | 18:00 Mon–Fri | yfinance OHLCV (AdjClose) sync + scan + canary |
| `plutus-weekly-ratios` | `30 23 * * 5` | 23:30 Friday | **05:00 Saturday** | Screener PE / PB / Market Cap → `screener_ratios` |
| `plutus-quarterly-sync` | `0 2 * * 0` | 02:00 Sunday | 07:30 Sunday | Screener fundamentals refresh |
| `plutus-weekly-backup` | `0 20 * * 0` | 20:00 Sunday | 01:30 Monday | DB backup to Storage |
| `plutus-tests` | on push/PR | — | — | CI unit tests |

**Source separation (locked):** prices & price-derived metrics (OHLC, AdjClose,
200-DMA, ATH, 52W, rally, trend) = **yfinance daily**, exactly as BuddyTrader.
Valuation (PE / PB / Market Cap) = **Screener.in weekly** (Saturday 05:00 IST);
the daily sync stamps the stored values into each day's snapshot. Quarterly
fundamentals (results table, ROCE/ROE, holdings, pledging, 5Y PE/PBV, net D/E)
= **Screener.in quarterly**. Retired fields (no longer populated):
`forward_pe`, `debt_to_equity_pct`, `ebitda_ttm`.

**Concurrency:** All workflows have `cancel-in-progress: false`. A mid-run job is never killed by a subsequent trigger.

**Timeouts:**
- Daily sync: 20 minutes
- Quarterly sync: 30 minutes
- Backup: 20 minutes

**Monitoring:**
- Check the Actions tab weekly.
- If `PLUTUS_ALERT_WEBHOOK` is set, failures post immediately to your chosen channel.
- The `sync_jobs` table is the ground truth audit trail — query it anytime.

```sql
-- Last 10 runs
SELECT job_type, as_of_date, status, symbols_ok, symbols_failed, finished_at
FROM sync_jobs
ORDER BY started_at DESC
LIMIT 10;

-- Any failures in the last 7 days
SELECT * FROM sync_jobs
WHERE status IN ('partial', 'failed')
  AND started_at > NOW() - INTERVAL '7 days';
```

---

## 9. Alerting — Setup & Response Playbook

### 9.1 Supported webhook targets

The alert payload uses `{"text": "...", "severity": "...", ...}`. This envelope works natively with:

| Target | How to get a URL |
|--------|-----------------|
| **Slack** | Slack app → Incoming Webhooks → Add → Copy URL |
| **Discord** | Server Settings → Integrations → Webhooks → New → Copy URL |
| **Telegram** | BotFather → create bot → get token → `https://api.telegram.org/bot<TOKEN>/sendMessage` (requires extra adapter) |
| **Generic JSON** | Any HTTP endpoint that accepts `POST application/json` |
| **webhook.site** | Free test target — [webhook.site](https://webhook.site) |

### 9.2 Alert severity levels

| Severity | Trigger | Icon | Action required |
|----------|---------|------|----------------|
| `info` | Canary all-ok summary | ℹ️ | None |
| `warning` | Partial sync failure (some symbols failed) | ⚠️ | Investigate failed symbols, re-run if needed |
| `error` | Total sync failure (all symbols failed) | 🚨 | Check yfinance connectivity, Supabase status, rerun |

### 9.3 Silence-on-green contract

- A **fully successful** sync does **NOT** fire any alert. Your webhook will only receive noise when something needs attention.
- Dry-run mode **never** fires an alert, even on failure.

### 9.4 Alert response playbook

**`warning` — partial sync failure:**

```bash
# 1. Find which symbols failed
psql "$LIVE_DB" -c "
  SELECT payload_json->'failed_symbols' as failed
  FROM sync_jobs
  ORDER BY started_at DESC LIMIT 1;"

# 2. Re-run just the failed symbols
python -m plutus.scripts.run_daily_sync \
  --symbols SYMBOL1.NS,SYMBOL2.NS

# 3. If persistent, check yfinance
python -c "import yfinance as yf; t = yf.Ticker('SYMBOL1.NS'); print(t.history(period='5d'))"
```

**`error` — total sync failure:**

```bash
# 1. Check GitHub Actions logs for the root cause
# 2. Most common causes:
#    a. Supabase project paused (free tier auto-pauses after 7 days of inactivity)
#    b. yfinance rate limit (wait 10 minutes, retry)
#    c. GitHub Actions network issue (rare — retry the workflow)

# 3. Un-pause Supabase (if paused)
# Go to supabase.com → your project → click "Restore project"
# Or run:
curl -X POST "https://api.supabase.com/v1/projects/<ref>/restore" \
  -H "Authorization: Bearer <supabase-management-api-token>"

# 4. Manual retry via workflow_dispatch
# Go to Actions → plutus-daily-sync → Run workflow
```

**Canary drift alert:**

```bash
# 1. Check which fixture drifted
python -m plutus.scripts.run_canary --verbose

# 2. If drift is legitimate (data source changed):
psql "$LIVE_DB" -c "
  UPDATE canary_checks
  SET expected_close = <new_value>
  WHERE symbol = 'RELIANCE.NS' AND check_date = '2024-01-02';"

# 3. If drift is an error in our data:
# Investigate the specific snapshot row and the yfinance raw response
```

---

## 10. Backup & Restore Procedure

### 10.1 Verify a backup exists

In Supabase dashboard → **Storage** → `plutus-backups`. You should see weekly `.sql.gz` files.

Or via API:

```bash
curl -s \
  -H "apikey: $PLUTUS_SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $PLUTUS_SUPABASE_SERVICE_KEY" \
  "$PLUTUS_SUPABASE_URL/storage/v1/object/list/plutus-backups"
```

### 10.2 Download a backup

```bash
FILE="plutus-20250115-200012.sql.gz"   # replace with actual filename

curl -s \
  -H "apikey: $PLUTUS_SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $PLUTUS_SUPABASE_SERVICE_KEY" \
  "$PLUTUS_SUPABASE_URL/storage/v1/object/plutus-backups/$FILE" \
  -o "$FILE"
```

### 10.3 Restore a backup

> ⚠️ **This drops and recreates tables.** Only do this in a disaster recovery scenario or a fresh project.

```bash
# Decompress
gunzip -c "$FILE" > restore.sql

# Apply to a target DB (use a fresh Supabase project or local)
TARGET_DB="postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres?sslmode=require"
psql "$TARGET_DB" -f restore.sql

# Verify
psql "$TARGET_DB" -c "SELECT COUNT(*) FROM daily_snapshots;"
```

### 10.4 Backup retention

The free Storage tier gives 1 GB. Each gzipped dump is ~20–40 MB. That is ~25–50 backups before you hit the limit. **Manually delete old backups from the Storage UI monthly**, or add a cleanup step to the workflow.

---

## 11. Rollback Procedures

### 11.1 Rollback the Edge Function

Every `supabase functions deploy` creates a new version. To roll back:

```bash
# List deployed versions
supabase functions list

# Re-deploy from a specific git commit
git checkout <previous-commit-sha>
supabase functions deploy plutus-api --no-verify-jwt
git checkout main
```

### 11.2 Rollback the frontend

**Cloudflare Pages:** Dashboard → your Pages project → **Deployments** → find the previous deployment → **Rollback to this deployment**.

**Vercel:** Dashboard → your project → **Deployments** → find the previous build → three-dot menu → **Promote to Production**.

Both roll back in < 30 seconds with zero downtime.

### 11.3 Disable workflows without deleting

If you need to stop automated runs immediately (e.g. yfinance is broken and hammering is making it worse):

1. Go to Actions → select the workflow.
2. Three-dot menu → **Disable workflow**.

Re-enable the same way. The cron schedule resumes automatically.

### 11.4 Emergency DB restore

See [Section 10.3](#103-restore-a-backup). Prefer restoring to a new Supabase project first, verifying data, then switching DNS/env vars.

---

## 12. Troubleshooting Matrix

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `ConfigError: Missing required environment variable: PLUTUS_SUPABASE_URL` | `.env` not loaded or wrong key name | Check `plutus/.env` exists, key is exactly `PLUTUS_SUPABASE_URL` |
| `supabase.exceptions.APIError: Invalid API key` | Wrong service key | Re-copy the `service_role` key from Supabase dashboard |
| `pg_dump: command not found` (in backup workflow) | `postgresql-client` not installed | The workflow's `Install Postgres client` step handles this — check if step was skipped |
| `pilot_fetch: history_ok: false` | yfinance rate limited | Wait 2–5 minutes, retry. Use `--log-level DEBUG` to see raw HTTP errors |
| `run_daily_sync exits 1, symbols_failed > 0` | Individual ticker delisted or renamed | Check [finance.yahoo.com](https://finance.yahoo.com) for the ticker, update CSV if needed |
| `snapshots_written: 0` after successful run | Symbol not in `stocks` table | Run `seed_universe` first |
| `run_scan exits 2: no snapshots found` | Sync hasn't run today | Run `run_daily_sync` before `run_scan` |
| `API returns 502` | Supabase project paused | Restore project at supabase.com |
| `close field is a number, not a string` | Wrong client — reading directly from PostgREST | Use the Edge Function, not raw Supabase REST. Edge Function encodes via `toWire()` |
| Frontend pools page empty | Edge Function not deployed or env var wrong | Check `VITE_PLUTUS_API_URL`, curl the Edge Function health endpoint |
| Realtime pill stays in polling mode | `VITE_SUPABASE_ANON_KEY` not set | Add to `.env.local` (local) or Pages env vars (prod) |
| Canary exits 1, `missing` count > 0 | Snapshot not in `daily_snapshots` for the canary date | Run sync for the check_date, or remove the fixture if date is too old |
| Canary exits 1, `drift` > 0.5% | Data source changed historical data | Check yfinance for that ticker/date, update `expected_close` in `canary_checks` |
| `pytest` shows 0 tests collected | Wrong working directory | Run from repo root: `python -m pytest plutus/` |
| `npm run build` fails with type error | TypeScript mismatch | Run `npm run typecheck` for detailed errors; check `tsconfig.json` |
| Supabase auto-paused (free tier) | No activity for 7+ days | Visit supabase.com and click **Restore project**; schedule a keep-alive if needed |
| Weekly backup `curl` upload fails with 403 | Bucket doesn't exist or wrong name | Create `plutus-backups` bucket in Storage dashboard (private) |

---

## Appendix A — Full Environment Variable Reference

### `plutus/.env` (Python backend)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PLUTUS_SUPABASE_URL` | ✅ Yes | — | `http://localhost:54321` (local) or `https://<ref>.supabase.co` (prod) |
| `PLUTUS_SUPABASE_SERVICE_KEY` | ✅ Yes | — | Service-role JWT. Full DB access. Never expose to browser |
| `PLUTUS_SUPABASE_ANON_KEY` | ❌ No | `None` | Anon key. Optional in backend; required in frontend |
| `PLUTUS_YF_TIMEOUT_SECONDS` | ❌ No | `30` | Seconds before yfinance HTTP call times out |
| `PLUTUS_YF_MAX_RETRIES` | ❌ No | `3` | Retry attempts per symbol on yfinance failure |
| `PLUTUS_YF_BATCH_SIZE` | ❌ No | `50` | Symbols per yfinance batch call |
| `PLUTUS_SYNC_BATCH_SIZE` | ❌ No | `50` | Symbols per Supabase upsert chunk |
| `PLUTUS_SYNC_HISTORY_YEARS` | ❌ No | `5` | Years of OHLCV history to fetch for ATH/DMA calculation |
| `PLUTUS_ENV` | ❌ No | `dev` | `dev` / `staging` / `prod` — controls log verbosity |
| `PLUTUS_LOG_LEVEL` | ❌ No | `INFO` | Python logging level (`DEBUG`, `INFO`, `WARNING`, `ERROR`) |
| `PLUTUS_ALERT_WEBHOOK` | ❌ No | `None` | Webhook URL. Omit to disable alerting entirely |
| `PLUTUS_ALERT_TIMEOUT_S` | ❌ No | `10` | Seconds before alert HTTP call times out |
| `PLUTUS_ALERT_MAX_RETRIES` | ❌ No | `3` | Alert retry attempts with exponential backoff (1s, 2s, 4s) |

### `backend/.env` (screener.in)

| Variable | Required | Description |
|----------|----------|-------------|
| `SCREENER_EMAIL` | ❌ Optional | Email for screener.in login |
| `SCREENER_PASSWORD` | ❌ Optional | Password for screener.in login |

### `frontend_v2/.env.local` (frontend)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_PLUTUS_API_URL` | ✅ Yes | Base URL for all API calls. Local: `http://localhost:54321/functions/v1/plutus-api`. Prod: `https://<ref>.functions.supabase.co/plutus-api` |
| `VITE_SUPABASE_URL` | ❌ No | Enables Realtime. Omit → 60 s polling fallback |
| `VITE_SUPABASE_ANON_KEY` | ❌ No | Enables Realtime. Omit → 60 s polling fallback |

### GitHub Actions secrets

| Secret | Required | Workflows |
|--------|----------|-----------|
| `PLUTUS_SUPABASE_URL` | ✅ Yes | Daily, Quarterly, Backup |
| `PLUTUS_SUPABASE_SERVICE_KEY` | ✅ Yes | Daily, Quarterly, Backup |
| `PLUTUS_SUPABASE_DB_URL` | ✅ Yes (Backup only) | Backup |
| `PLUTUS_ALERT_WEBHOOK` | ❌ Optional | Daily, Quarterly, Backup |

---

## Appendix B — All API Endpoints with Sample curl

All examples use `$BASE` = your API URL (local or prod).

```bash
# Set once
BASE="http://localhost:8000"   # local FastAPI
# BASE="http://localhost:54321/functions/v1/plutus-api"   # local Edge Function
# BASE="https://<ref>.functions.supabase.co/plutus-api"   # prod

# ──────────────────────────────────────────────
# 1. Health check
curl -s "$BASE/api/health"
# Response: {"status":"ok","service":"plutus-api","version":"0.7.0"}

# ──────────────────────────────────────────────
# 2. List all pools
curl -s "$BASE/api/pools"
# Response: {"pools": [{"code":"F40","name":"Flagship 40",...}, ...]}

# ──────────────────────────────────────────────
# 3. List all active stocks
curl -s "$BASE/api/stocks"
# Response: {"stocks":[...],"count":442}

# 4. Filter stocks by pool
curl -s "$BASE/api/stocks?pool=F40"

# 5. Filter and increase limit
curl -s "$BASE/api/stocks?pool=S200&limit=200"

# ──────────────────────────────────────────────
# 6. Single stock detail
curl -s "$BASE/api/stocks/RELIANCE.NS"
# Response: {"stock": {"symbol":"RELIANCE.NS","sector":"Energy",...}}

# ──────────────────────────────────────────────
# 7. Latest snapshots for a pool (uses most recent snapshot date automatically)
curl -s "$BASE/api/snapshots/latest?pool=F40"
# Response: {"pool":"F40","snapshot_date":"2025-01-15","snapshots":[...],"count":40}

# 8. Latest snapshots for a specific date
curl -s "$BASE/api/snapshots/latest?pool=F40&snapshot_date=2025-01-10"

# ──────────────────────────────────────────────
# 9. Historical OHLCV for a symbol
curl -s "$BASE/api/snapshots/RELIANCE.NS/history?days=60"
# Response: {"symbol":"RELIANCE.NS","days":60,"bars":[...]}

# ──────────────────────────────────────────────
# 10. Latest scan for a pool
curl -s "$BASE/api/scans/latest?pool=F40"
# Response: {"scan":{"id":"...","pool_code":"F40","status":"ok",...}}

# ──────────────────────────────────────────────
# 11. Scan results for a specific scan
SCAN_ID="<uuid from /api/scans/latest>"
curl -s "$BASE/api/scan_results?scan_id=$SCAN_ID"

# 12. Scan results filtered by strategy
curl -s "$BASE/api/scan_results?scan_id=$SCAN_ID&strategy_id=envelope_200dma"

# 13. Scan results filtered by status
curl -s "$BASE/api/scan_results?scan_id=$SCAN_ID&status=BUY_ZONE,OPPORTUNITY"

# ──────────────────────────────────────────────
# 14. Latest sync jobs
curl -s "$BASE/api/sync_jobs/latest"
# Response: {"jobs":[{"job_type":"daily_sync","status":"ok",...}],"count":10}

# 15. Filter sync jobs by type
curl -s "$BASE/api/sync_jobs/latest?job_type=daily_sync&limit=5"

# ──────────────────────────────────────────────
# 16. Latest fundamentals for a symbol
curl -s "$BASE/api/fundamentals/RELIANCE.NS/latest"
# Response: {"fundamentals":{"symbol":"RELIANCE.NS","roce":"18.45","roe":"15.20",...}}
```

**Money field wire format verification:**

```bash
# All these should be strings, not numbers
curl -s "$BASE/api/snapshots/latest?pool=F40" | python3 -c "
import json, sys
data = json.load(sys.stdin)
snap = data['snapshots'][0]
money_keys = ['close','open','high','low','dma_200','pe','pb']
for k in money_keys:
    v = snap.get(k)
    if v is not None:
        assert isinstance(v, str), f'{k} should be string, got {type(v).__name__}: {v}'
        print(f'  {k}: \"{v}\" ✓')
print('All money fields are strings — wire contract OK')
"
```

---

## Appendix C — Migration Order Reference

| Order | File | Key objects | Depends on |
|-------|------|-------------|-----------|
| 001 | `001_stocks.sql` | `stocks` table, `plutus_touch_updated_at()` trigger | — |
| 002 | `002_pools.sql` | `pools` table | — |
| 003 | `003_daily_snapshots.sql` | `daily_snapshots` table | 001 (FK to stocks) |
| 004 | `004_fundamentals.sql` | `fundamentals` table | 001 |
| 005 | `005_strategy_configs.sql` | `strategy_configs` table | 002 |
| 006 | `006_scans_and_results.sql` | `scans`, `scan_results` tables | 002, 003 |
| 007 | `007_trades.sql` | `trades` table | 001 |
| 008 | `008_sync_jobs.sql` | `sync_jobs` table | — |
| 009 | `009_views.sql` | `v_stocks_latest`, `v_fundamentals_latest` views | 001–007 |
| 010 | `010_rls.sql` | RLS policies — anon read, service_role write | 001–008 |
| 011 | `011_canary_checks.sql` | `canary_checks` table + RLS | 001 (uses `plutus_touch_updated_at`) |

**Idempotency guarantee:** Every migration uses `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE VIEW`, and `DROP POLICY IF EXISTS` before `CREATE POLICY`. You can re-run the full migration set against an existing database without errors or data loss.

---

## Appendix D — Free-Tier Cost Reference

The entire Plutus stack runs within Supabase, GitHub, and Cloudflare/Vercel free tiers with comfortable headroom.

### Supabase free tier

| Resource | Free limit | Expected Plutus usage | Headroom |
|----------|-----------|----------------------|----------|
| Database size | 500 MB | ~50–100 MB (300 stocks × 5y snapshots) | ~80% free |
| Storage | 1 GB | ~20–40 MB/week backups | ~97% free (rotate monthly) |
| Edge Function invocations | 500,000/month | ~1,000–5,000/month (dashboard use) | ~99% free |
| Realtime messages | 2 million/month | ~50–200/day (sync job events) | ~99.7% free |
| Bandwidth | 5 GB/month | ~500 MB/month (API responses) | ~90% free |
| Project auto-pause | After 7 days inactivity | Daily sync keeps it active Mon–Fri | Active |

> **Auto-pause note:** The free tier pauses projects after 7 days without activity. The daily sync workflow (Mon–Fri) prevents this. Over weekends (Sat–Sun), Supabase may pause if there are no requests. The Sunday quarterly sync and backup workflows will prevent pause during most weekends. If it pauses, restore manually at supabase.com — takes ~30 seconds.

### GitHub Actions free tier

| Resource | Free limit | Expected usage |
|----------|-----------|----------------|
| Actions minutes (public repo) | Unlimited | — |
| Actions minutes (private repo) | 2,000 min/month | Daily sync ~5 min × 21 days = ~105 min/month |
| Artifact storage | 500 MB | Not used by Plutus |

### Cloudflare Pages free tier

| Resource | Free limit | Expected usage |
|----------|-----------|----------------|
| Requests | Unlimited | — |
| Bandwidth | Unlimited | — |
| Builds/month | 500 | ~20–30/month |

### Vercel free tier (Hobby)

| Resource | Free limit | Expected usage |
|----------|-----------|----------------|
| Bandwidth | 100 GB/month | ~0.5 GB/month |
| Deployments | Unlimited | — |
| Serverless functions | Not used (static only) | — |
