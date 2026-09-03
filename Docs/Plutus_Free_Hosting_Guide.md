# Plutus — Free Hosting Guide (DB · Backend · Frontend)

> **Goal:** take the Plutus stack you run locally and host every piece on a free tier:
>
> | Piece | Platform | Free tier |
> |---|---|---|
> | **Database** | Supabase Cloud | 1 project · 500 MB DB · 1 GB storage |
> | **Backend (FastAPI)** | Render Web Service | 750 h/month · sleeps when idle |
> | **Frontend (React/Vite)** | Vercel | 100 GB bandwidth · unlimited deploys |
> | **Daily/quarterly syncs** | GitHub Actions | 2,000 min/month (free repos: unlimited for public) |
>
> **Why the FastAPI backend is now hosted (new since the Trading Journal):**
> the original plan used the read-only Supabase Edge Function as the prod API.
> The Trading Journal writes (add/edit/delete/import trades), and those write
> endpoints exist only in the Python FastAPI app (`plutus/api/app.py` +
> `plutus/api/journal.py`). Hosting FastAPI on Render gives prod both the
> read endpoints and the journal in one service. The Edge Function can stay
> deployed as a read-only fallback, but the frontend below points at Render.
>
> Deep-dive topics (backups, canary, alerting, rollback) live in
> `Docs/Plutus_Local_and_Live_Runbook.md`. This guide is the fast path.

---

## 0. Prerequisites

- GitHub account with this repo pushed (Render and Vercel deploy from GitHub).
- Local repo working (venv, `plutus/.env`) — you already have this.
- Accounts (all free, no card needed): [supabase.com](https://supabase.com),
  [render.com](https://render.com), [vercel.com](https://vercel.com).

---

## 1. Database — Supabase Cloud

### 1.1 Create the project

1. supabase.com → **New project**.
2. Name: `plutus` · Region: **Mumbai (ap-south-1)** (closest to NSE data users)
   · set a strong **database password** and save it.
3. Wait ~2 minutes for provisioning.

### 1.2 Capture the keys

**Project Settings → API**. Copy three values:

| Value | Used by | Env var name |
|---|---|---|
| Project URL (`https://<ref>.supabase.co`) | backend + frontend | `PLUTUS_SUPABASE_URL` / `VITE_SUPABASE_URL` |
| `anon` public key | frontend (Realtime pill only) | `VITE_SUPABASE_ANON_KEY` |
| `service_role` secret key | backend + GitHub Actions **only** | `PLUTUS_SUPABASE_SERVICE_KEY` |

> ⚠️ The `service_role` key bypasses RLS. It goes into Render and GitHub
> **secrets** only — never into the frontend or any `VITE_*` variable.

### 1.3 Apply all 13 migrations (in order)

Option A — SQL Editor (no tools needed): open **SQL Editor → New query**,
paste each file from `plutus/migrations/` **in numeric order** and Run:

```
001_stocks.sql … 012_screener_ratios.sql, 013_journal.sql
```

Option B — psql in one shot (get the **Session pooler** connection string
from the dashboard **Connect** button):

```bash
for f in plutus/migrations/0*.sql; do
  psql "postgresql://postgres.<ref>:<DB_PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres" \
    -v ON_ERROR_STOP=1 -f "$f" || break
done
```

> `013_journal.sql` creates the Trading Journal tables
> (`journal_settings`, `journal_opportunities`, `journal_trades`) with
> RLS locked to `service_role` — the anon key cannot touch them.

### 1.4 Seed the stock universe

From your local machine, pointed at the **cloud** project (temporarily set the
two env vars, or edit `plutus/.env`):

```bash
PLUTUS_SUPABASE_URL=https://<ref>.supabase.co \
PLUTUS_SUPABASE_SERVICE_KEY=<service_role key> \
.venv/Scripts/python.exe -m plutus.scripts.seed_universe --csv "UserData/Vicky - Master Template - Master.csv"
```

Then run one full sync against the cloud DB the same way (or skip and let the
first GitHub Actions run do it — step 4):

```bash
PLUTUS_SUPABASE_URL=... PLUTUS_SUPABASE_SERVICE_KEY=... \
.venv/Scripts/python.exe -m plutus.scripts.run_daily_sync
```

### 1.5 Import your journal (once the frontend is live)

Open the hosted app → Journal → **Import CSV** and load your three sheets
(Opportunities / Open Trades / Closed Trades), exactly as you did locally.
Set your capital with the Capital chip. Done — the cloud DB now holds your
journal.

---

## 2. Backend — FastAPI on Render

### 2.1 Create the service

1. render.com → **New → Web Service** → connect your GitHub repo.
2. Settings:

| Setting | Value |
|---|---|
| Name | `plutus-api` |
| Region | Singapore (closest free region to India) |
| Branch | `main` |
| Root Directory | *(leave blank — repo root)* |
| Runtime | Python 3 |
| Build Command | `pip install -r plutus/requirements.txt` |
| Start Command | `uvicorn --factory plutus.api.app:create_app --host 0.0.0.0 --port $PORT` |
| Instance Type | **Free** |

### 2.2 Environment variables (Render → Environment)

```
PLUTUS_SUPABASE_URL=https://<ref>.supabase.co
PLUTUS_SUPABASE_SERVICE_KEY=<service_role key>
PLUTUS_ENV=prod
PYTHON_VERSION=3.11.9
```

> `PLUTUS_ENV=prod` disables the local-only `/api/admin/sync` endpoint
> (PlayArea "Fetch now"); in prod, new symbols fill on the nightly sync.
> The journal endpoints stay active — they are the point of hosting this.

3. **Create Web Service** → wait for the first deploy → note your URL,
   e.g. `https://plutus-api.onrender.com`.

### 2.3 Verify

```bash
curl https://plutus-api.onrender.com/api/health
curl https://plutus-api.onrender.com/api/journal/settings
curl "https://plutus-api.onrender.com/api/pools"
```

All three should return JSON (the first request after idle takes ~30–60 s —
see §5 Free-tier gotchas).

---

## 3. Frontend — Vercel

### 3.1 Create the project

1. vercel.com → **Add New → Project** → import your GitHub repo.
2. Settings:

| Setting | Value |
|---|---|
| Framework Preset | Vite |
| Root Directory | `frontend_v2` |
| Build Command | `npm run build` *(default)* |
| Output Directory | `dist` *(default)* |

`frontend_v2/vercel.json` (already in the repo) rewrites every path to
`index.html` so React Router URLs like `/journal` and `/pools/F40` work on
refresh.

### 3.2 Environment variables (Vercel → Settings → Environment Variables)

```
VITE_PLUTUS_API_URL=https://plutus-api.onrender.com
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

(anon key only — the sync-status Realtime pill reads `sync_jobs`; RLS keeps
everything else out of reach.)

3. **Deploy** → you get `https://<project>.vercel.app`.

### 3.3 Verify

- `/` → landing page with tool cards.
- `/pools/F40` → table renders after the Render cold start.
- `/journal` → your capital + tabs; add and delete a test opportunity.
- Expand a stock you hold → **My positions** tab shows your lots.

---

## 4. Scheduled syncs — GitHub Actions (already wired)

The workflows in `.github/workflows/` run the daily/quarterly syncs, weekly
ratios, canary, and backups against whatever DB the secrets point at.

**Repo → Settings → Secrets and variables → Actions → New repository secret:**

```
PLUTUS_SUPABASE_URL          https://<ref>.supabase.co
PLUTUS_SUPABASE_SERVICE_KEY  <service_role key>
PLUTUS_ALERT_WEBHOOK         (optional — Slack/Discord webhook for failures)
```

First run: **Actions → plutus-daily-sync → Run workflow** (manual trigger).
After it finishes, `/api/snapshots/latest?pool=F40` on Render returns fresh
rows and the frontend fills in. From then on it runs Mon–Fri 12:30 UTC
(18:00 IST) automatically.

---

## 5. Free-tier gotchas (read once)

| Platform | Gotcha | What to do |
|---|---|---|
| **Render free** | Service **sleeps after 15 min idle**; next request waits ~30–60 s | Fine for a personal tool. Optional: a free uptime pinger (e.g. cron-job.org hitting `/api/health` every 10 min during market hours) keeps it warm. |
| **Supabase free** | Project **pauses after 7 days with zero activity** | The weekday GitHub Actions sync counts as activity — you're safe as long as the workflow runs. If paused, un-pause from the dashboard (data is kept). |
| **Supabase free** | 500 MB DB cap | Plutus with ~250 symbols × years of snapshots stays well under 100 MB. Check Settings → Usage occasionally. |
| **Vercel free** | Fair-use bandwidth | A personal dashboard never gets close. |
| **GitHub Actions** | Private-repo minutes capped at 2,000/month | The daily sync uses ~5 min/day ≈ 110 min/month. Plenty. |
| **CORS** | `plutus/api/app.py` currently allows `*` origins | Optional hardening: change `allow_origins` to your Vercel URL and redeploy. |

---

## 6. Redeploying after changes

- **Backend:** `git push` → Render auto-deploys `main`.
- **Frontend:** `git push` → Vercel auto-deploys `main`.
- **New migration:** add `plutus/migrations/0XX_*.sql` → run it against the
  cloud DB (SQL Editor or psql, §1.3) — migrations do NOT auto-apply.

---

## 7. One-page cheat sheet

```
Supabase  : DB + keys           → migrations 001–013, seed, secrets
Render    : plutus-api          → uvicorn --factory plutus.api.app:create_app
Vercel    : frontend_v2         → VITE_PLUTUS_API_URL = Render URL
GitHub    : Actions secrets     → PLUTUS_SUPABASE_URL / _SERVICE_KEY
Order     : DB → seed → backend → frontend → Actions first run → import journal
```
