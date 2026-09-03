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

Migrations are SQL files that create the tables, views, indexes, and security
policies required by Plutus. They must be run against the **new Supabase
project**, not against a local Supabase project. Always run them in the order
shown below because later files depend on objects created by earlier files.

#### Recommended for beginners — Supabase SQL Editor

You do not need to install PostgreSQL or use a command prompt for this method.

1. Open the Supabase dashboard and select the `plutus` project you created.
2. In the left sidebar, select **SQL Editor**.
3. Select **New query**. Leave this query open so you can reuse it.
4. In this repository, open the `plutus/migrations` folder in VS Code.
5. Open `001_stocks.sql`, press `Ctrl+A` to select the complete file, and
   press `Ctrl+C` to copy it.
6. Return to the Supabase SQL Editor, click inside the query, press `Ctrl+A`
   to remove any old text, and press `Ctrl+V`.
7. Click **Run** (or press `Ctrl+Enter`). Wait for the success message before
   continuing. Do not close the tab if Supabase reports an error.
8. Repeat steps 5–7 for each file below, in exactly this order:

   1. `001_stocks.sql`
   2. `002_pools.sql`
   3. `003_daily_snapshots.sql`
   4. `004_fundamentals.sql`
   5. `005_strategy_configs.sql`
   6. `006_scans_and_results.sql`
   7. `007_trades.sql`
   8. `008_sync_jobs.sql`
   9. `009_views.sql`
   10. `010_rls.sql`
   11. `011_canary_checks.sql`
   12. `012_screener_ratios.sql`
   13. `013_journal.sql`

9. After the final file succeeds, open **Table Editor** in the sidebar. You
   should see tables including `stocks`, `pools`, `daily_snapshots`,
   `fundamentals`, `scans`, `scan_results`, `sync_jobs`,
   `journal_settings`, `journal_opportunities`, and `journal_trades`.
10. In **SQL Editor → New query**, run this verification query:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'stocks', 'pools', 'daily_snapshots', 'fundamentals', 'scans',
    'scan_results', 'sync_jobs', 'journal_settings',
    'journal_opportunities', 'journal_trades'
  )
order by table_name;
```

The result should contain 10 rows. Seeing the tables in Table Editor is useful
for a quick visual check, but the query is the authoritative check. Empty
tables are expected at this stage; the stock rows are added in §1.4.

#### Optional — run all files from Windows PowerShell

Use this only if you already have the PostgreSQL `psql` command installed.
In Supabase, select **Connect → Session pooler**, copy the connection string,
and replace the placeholders below. The session pooler is preferred because
it works on networks where a direct database connection is unavailable.

From the repository root (`d:\Tools\Plutus\BuddyTrader`), run:

```powershell
$env:PGPASSWORD = '<your Supabase database password>'
$connection = 'postgresql://postgres.<project-ref>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'

Get-ChildItem .\plutus\migrations\0*.sql | Sort-Object Name | ForEach-Object {
    Write-Host "Applying $($_.Name)..."
    psql $connection --set=ON_ERROR_STOP=1 --file $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($_.Name)" }
}

Remove-Item Env:\PGPASSWORD
```

Use the exact host, port, username, and database shown by Supabase’s
**Connect** dialog if they differ from the example. If your database password
contains characters such as `@`, `:`, `/`, or `#`, use the SQL Editor method
or URL-encode the password before putting it in a connection URL. Never paste
the connection string or database password into Git or a frontend `.env` file.

#### If a migration reports an error

- **“relation already exists”**: check whether the file was already run. Do
  not blindly continue to the next file; rerun the same file only if the
  message is explicitly harmless and the query completed successfully.
- **“relation does not exist”**: an earlier migration was skipped or failed.
  Find the first file that did not succeed and run the files again from that
  point in numeric order.
- **Permission or connection errors**: confirm that you selected the correct
  Supabase project and that you are using the database connection details,
  not the `anon` or `service_role` API key.
- If the SQL Editor shows an error, copy the error text before changing
  anything. It identifies the migration and line that needs attention.

> `013_journal.sql` creates the Trading Journal tables
> (`journal_settings`, `journal_opportunities`, `journal_trades`) with RLS
> locked to `service_role` — the anon key cannot touch them. Do not test these
> tables from the browser until the backend security setup is complete.
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
> (PlayArea "Fetch now"); in prod, new symbols fill on the nightly sync
> — or instantly via the on-demand trigger below.
> The journal endpoints stay active — they are the point of hosting this.

### 2.2b On-demand sync triggers (Sync tab buttons)

The Sync tab has **Run** buttons (Technical / Fundamentals, scoped by pool
incl. PlayArea) that dispatch the scheduled GitHub Actions workflows on
demand. To enable them, add three more env vars to the API service:

```
PLUTUS_GITHUB_TOKEN=<fine-grained PAT>
PLUTUS_GITHUB_REPO=sjvignesh3/BuddyTrader
PLUTUS_ADMIN_TOKEN=<any long random string you choose>
```

1. **Create the PAT:** github.com → Settings → Developer settings →
   Fine-grained tokens → Generate new token. Repository access: **only
   this repo**. Permissions: **Actions → Read and write** (nothing else).
   Copy it into `PLUTUS_GITHUB_TOKEN`.
2. **Pick an admin token:** any long random string (e.g. from a password
   generator). Set it as `PLUTUS_ADMIN_TOKEN`, then enter the same value
   once in the app: **Sync tab → Set admin token** (it is stored only in
   that browser's localStorage).
3. Redeploy/restart the API service. The Sync tab buttons go live; the
   PlayArea "Fetch now" button also uses this path in prod (it sends your
   watchlist symbols to the daily workflow).

The PAT never reaches the browser — the API dispatches the workflow
server-side and only checks the `X-Plutus-Admin-Token` header. Without
`PLUTUS_ADMIN_TOKEN` set, the trigger stays disabled in prod (503). The
cron schedules are unaffected by any of this.

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
