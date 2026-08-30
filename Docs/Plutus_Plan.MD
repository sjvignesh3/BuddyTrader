# Plutus — Complete Rearchitecture Plan

> **Name:** Plutus (Greek god/personification of wealth)
> **Purpose:** Complete rewrite of Buddy Trader as a scalable, persistent, scheduled NSE swing-trading toolkit.
> **Hosting:** Frontend on Vercel, Backend + DB on Supabase.
> **Status:** ✅ All decisions finalised. Validation complete. Ready for implementation.
> **Validation Report:** See `Docs/Plutus_Validation_Report.MD`

---

## 1. Executive Summary — What Changes and What Stays

### 1.1 What is being **thrown away**

| Legacy Component | Reason for Removal |
|---|---|
| `screener_data_fetcher.py` (Screener.in HTML parsing, login, session cookies) | Fragile, rate-limited, requires credentials, brittle HTML parsing |
| `UserData/screener_cache.json` (persistent JSON cache) | Replaced by proper DB tables |
| `screener_session.pkl` | Not needed — no login |
| On-demand price fetching at scan time | Replaced by scheduled 5 PM IST sync |
| On-demand fundamental fetching | Replaced by manual "Sync Fundamentals" button (quarterly cadence) |
| SQLite / Render / local file dependencies | Migrating to Supabase PostgreSQL |
| Existing FastAPI backend deployment on Render | Replaced by Supabase Edge Functions (or a lightweight FastAPI on Render/Fly if needed — see §12 Q1) |
| Per-pool in-memory scan cache in `scanner.py` | Replaced by DB-persisted scan results |

### 1.2 What is **kept and improved**

| Kept From Buddy | Enhancement in Artha |
|---|---|
| Stock universe CSV (`Vicky - Master Template - Master.csv`) | Made **importable** — one-click seed to DB; CSV stays as canonical source-of-truth |
| Pool concept (F40, E40, S200, PlayArea) | Represented as tag arrays on `stocks` table — a single stock can belong to multiple pools |
| Filter rules & formulas (200 DMA, 52W, ATH, 20% rally, PE/PB avg, ROCE, ROE, Net Debt/Eq, pledging, ATH filters) | Same math, now evaluated against DB rows instead of on-demand fetches |
| Strategy configuration (`strategy_rules.json`) | Migrated into DB as `strategy_configs` table (versioned, editable via UI) |
| Score-based ranking model | Kept — extended with persistent `scan_results` history |
| Pool-level view (F40 tab, E40 tab, etc.) | **Kept as the primary view** — will evolve later |
| React + Vite frontend | Same stack, hosted on Vercel |
| All fundamental data fields currently shown | 100% preserved — sourced from yfinance instead of Screener.in |

### 1.3 What is **completely new**

1. **Single data source: yfinance** for both price AND fundamentals (validated on 1-2 stocks first — see §3)
2. **Market Cap classification** (Large / Mid / Small / Micro) fetched live from yfinance
3. **Two-tier fundamentals split:**
   - **Tier A — Price-Action-Dependent:** PE, PB, Market Cap, Fall From ATH → refreshed daily with the price sync
   - **Tier B — Quarterly-Only:** Quarterly financials, shareholding, pledging → synced manually via a "Sync Fundamentals" button (or scheduled quarterly)
4. **Scheduled daily sync at 5 PM IST** (post-market close) — Supabase cron / pg_cron / Edge Function scheduled trigger
5. **Trading Journal & Position tracking (Phase 2)** — filter/visualize stocks in which we already hold positions
6. **Supabase Auth** — single-user login for now, extensible later
7. **Vercel-native frontend deployment** with environment-driven Supabase client

---

## 2. Tech Stack — Final Decisions

| Layer | Technology | Rationale |
|---|---|---|
| **Frontend Framework** | React 18 + Vite 5 | Kept from Buddy — no rewrite needed |
| **Frontend Hosting** | Vercel | Generous free tier, native Vite/React support, edge network, auto-deploys from Git |
| **Backend Runtime** | Supabase Edge Functions (Deno/TypeScript) **OR** thin FastAPI on Fly.io / Render | See §12 Q1 — leaning toward Edge Functions for cost & simplicity |
| **Database** | Supabase PostgreSQL (free tier: 500 MB + unlimited API requests) | Managed, scalable, JSONB support, Row-Level Security, real-time subscriptions |
| **Auth** | Supabase Auth | Free, built-in JWT, magic-link login |
| **Scheduled Jobs** | `pg_cron` extension (built into Supabase) + Edge Function invocations | Native, no external cron service needed |
| **Data Source** | **yfinance (Python)** | Single source for prices + fundamentals + market cap. Validated on 1-2 stocks first. |
| **Sync Worker Runtime** | Python 3.11 on Fly.io / Railway / GitHub Actions | yfinance is Python-only. Runs on schedule, writes to Supabase Postgres. |
| **Frontend ↔ Supabase** | `@supabase/supabase-js` client | Direct RPC / table reads with RLS, no custom API layer needed for reads |
| **State Management** | React Context + TanStack Query (React Query) | For server-state caching, background refetch, optimistic updates |

### 2.1 Why yfinance is enough (to be validated)

**Fundamentals yfinance provides:**
- `.info` → trailing PE, forward PE, price-to-book, market cap, sector, industry, dividend yield, ROE, ROA, debt-to-equity, profit margins, revenue growth, etc.
- `.quarterly_financials` → quarterly revenue, gross profit, operating income, net income, EBITDA
- `.quarterly_balance_sheet` → quarterly assets, liabilities, equity
- `.quarterly_cashflow` → quarterly cash flow statements
- `.major_holders` → % held by insiders, institutions, promoters (limited for Indian stocks)
- `.institutional_holders` → institutional holdings
- `.history(period='max')` → full daily OHLCV for ATH computation

**Validation approach (§3):** Fetch 2 stocks (1 large cap: `RELIANCE.NS`, 1 mid cap: `PAGEIND.NS`), compare against known values from Screener.in, TradingView, and NSE. Confirm accuracy of:
- PE, PB, Market Cap, ROCE (may need derivation), ROE, Debt/Equity
- Quarterly Sales, Net Profit, PBT
- Pledging (may not be available — Indian-specific, needs verification)
- All-time high (5-year daily rolling)

**Known gaps to verify:**
- **Promoter Pledging** — yfinance may not have this (SEBI-specific disclosure). Backup plan: skip this filter OR add manual override column in DB.
- **ROCE** — yfinance provides ROA and ROE but not ROCE directly. May need to derive from `ebit / (total_assets - current_liabilities)`.
- **Latest quarterly split by "consolidated vs standalone"** — yfinance defaults to reported. Confirm which one matches Screener.

---

## 3. Validation Phase (BEFORE full rebuild)

**Deliverable:** A single Python script `backend_v2/validate_yfinance.py` that:
1. Fetches full data for `RELIANCE.NS` and `PAGEIND.NS` using yfinance
2. Prints side-by-side comparison against expected values:
   - Current Price, Market Cap → NSE / Screener
   - PE, PB → Screener top ratios
   - ROE, Debt/Equity → Screener top ratios
   - ROCE → derived; compare to Screener
   - 5yr avg PE, 5yr avg PB → computed from historical .info snapshots (may need alternate approach)
   - Quarterly Sales, PBT, Net Profit (last 4 quarters) → Screener quarters table
   - ATH → 5y daily max High × (AdjClose/Close)
   - 52W High/Low → yfinance meta
   - Promoter holding %, Pledging % → likely NOT available; document gap
3. Writes results to `Docs/Artha_Validation_Report.MD`

**Decision gate:** Only proceed to full rebuild after reviewing this report together and confirming acceptable gaps or fallback strategies for missing fields.

---

## 4. Data Domains — Fundamentals Split

### 4.1 Tier A — Price-Action-Dependent (refreshed daily at 5 PM IST)

Because these change with every closing price, they belong in the **daily sync pipeline**:

| Field | Source | Formula |
|---|---|---|
| `close` | yfinance daily close | Live from data |
| `market_cap` | `.info["marketCap"]` | Direct |
| `cap_bucket` | Derived | Large ≥ ₹50,000 Cr, Mid 15,000–50,000 Cr, Small 5,000–15,000 Cr, Micro < 5,000 Cr *(thresholds configurable — see §12 Q2)* |
| `pe_current` | `.info["trailingPE"]` | Direct |
| `pb_current` | `.info["priceToBook"]` | Direct |
| `fall_from_ath_pct` | Derived | `(ath - close) / ath × 100` |
| `dma_200` | Rolling avg | Same as Buddy |
| `below_200dma_pct` | Derived | Same as Buddy |
| `high_52w`, `low_52w` | yfinance meta | Direct |
| `distance_from_52w_low_pct` | Derived | Same as Buddy |
| `ath` | 5y daily max of adjusted High | Same formula as Buddy |
| **20% Rally metrics** | Full recompute from OHLCV | Same as Buddy |

### 4.2 Tier B — Quarterly Sync (manual button + optional scheduled quarterly)

These don't change daily and only need refreshing when new quarterly results are filed:

| Field | Source | Notes |
|---|---|---|
| Quarterly Sales, PBT, Net Profit (all history) | `.quarterly_financials` | 4-8 quarters typically available |
| Shareholding: promoter %, public %, institutional % | `.major_holders` | Indian-specific data may be limited |
| Promoter Pledging % | **NEEDS VALIDATION** | May not be in yfinance; fallback in §12 Q3 |
| ROCE, ROE | `.info` + balance sheet | Direct where available |
| Net Debt / Equity | `.info["debtToEquity"]` | Direct |
| Historical PE/PB averages (5yr) | Reconstructed from daily .history + quarterly EPS | See §12 Q4 |

### 4.3 Data flow diagram

```
    ┌─────────────────────────┐
    │  5 PM IST Daily Cron    │
    │  (pg_cron trigger)      │
    └────────────┬────────────┘
                 │
                 ▼
    ┌─────────────────────────┐        ┌─────────────────────────┐
    │  Sync Worker (Python)   │───────▶│  yfinance API           │
    │  Runs on Fly.io/Railway │        │  (batched, parallelized)│
    └────────────┬────────────┘        └─────────────────────────┘
                 │
                 │ upsert
                 ▼
    ┌─────────────────────────────────────────────────────────┐
    │           Supabase PostgreSQL                            │
    │  ┌──────────────┐  ┌────────────────┐  ┌─────────────┐  │
    │  │ stocks       │  │ daily_snapshot │  │ fundamentals│  │
    │  └──────────────┘  └────────────────┘  └─────────────┘  │
    │  ┌──────────────┐  ┌────────────────┐  ┌─────────────┐  │
    │  │ scan_results │  │ trades         │  │ config      │  │
    │  └──────────────┘  └────────────────┘  └─────────────┘  │
    └─────────────────────────┬───────────────────────────────┘
                              │  Direct table reads via
                              │  supabase-js (RLS-protected)
                              ▼
                    ┌─────────────────────┐
                    │  React + Vite       │
                    │  Frontend (Vercel)  │
                    └─────────────────────┘
```

---

## 5. Database Schema — Supabase PostgreSQL

All tables have `created_at TIMESTAMPTZ DEFAULT NOW()` and `updated_at TIMESTAMPTZ DEFAULT NOW()`.
RLS enabled on every table — policies grant read/write to authenticated user only.

### 5.1 `stocks` — Universe (importable from CSV)

```sql
CREATE TABLE stocks (
  id                    BIGSERIAL PRIMARY KEY,
  symbol                VARCHAR(20) UNIQUE NOT NULL,        -- e.g. RELIANCE
  name                  VARCHAR(255),                       -- from yfinance .info["longName"]
  sector                VARCHAR(100),                       -- from CSV or yfinance
  industry              VARCHAR(150),                       -- from yfinance
  exchange              VARCHAR(10) DEFAULT 'NSE',
  active                BOOLEAN DEFAULT TRUE,
  pools                 TEXT[] DEFAULT '{}',                -- e.g. ['F40','S200']
  cap_type_manual       VARCHAR(20),                        -- Optional CSV override
  metadata              JSONB DEFAULT '{}',                 -- Any extra CSV cols (Priority, Volatility, etc.)
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_stocks_pools     ON stocks USING GIN (pools);
CREATE INDEX idx_stocks_symbol    ON stocks (symbol);
CREATE INDEX idx_stocks_active    ON stocks (active);
```

### 5.2 `pools` — Reference table

```sql
CREATE TABLE pools (
  code           VARCHAR(20) PRIMARY KEY,
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  display_order  INT DEFAULT 0,
  strategies     TEXT[] DEFAULT '{}',        -- IDs of strategies that apply
  metadata       JSONB DEFAULT '{}'
);
-- Seed: F40, E40, S200, PlayArea
```

### 5.3 `daily_snapshots` — Tier A (price-action data, daily)

One row per (stock, date). Written every day at 5 PM IST.

```sql
CREATE TABLE daily_snapshots (
  id                          BIGSERIAL PRIMARY KEY,
  stock_id                    BIGINT REFERENCES stocks(id) ON DELETE CASCADE,
  symbol                      VARCHAR(20) NOT NULL,          -- denormalized for fast lookup
  snapshot_date               DATE NOT NULL,
  close                       NUMERIC(12,2),
  open                        NUMERIC(12,2),
  high                        NUMERIC(12,2),
  low                         NUMERIC(12,2),
  volume                      BIGINT,
  adj_close                   NUMERIC(12,2),
  -- Derived / cached metrics
  market_cap                  NUMERIC(20,2),
  cap_bucket                  VARCHAR(10),                   -- Large / Mid / Small / Micro
  pe_current                  NUMERIC(10,2),
  pb_current                  NUMERIC(10,2),
  dma_200                     NUMERIC(12,2),
  below_200dma_pct            NUMERIC(6,2),
  high_52w                    NUMERIC(12,2),
  low_52w                     NUMERIC(12,2),
  distance_from_52w_low_pct   NUMERIC(6,2),
  distance_from_52w_high_pct  NUMERIC(6,2),
  ath                         NUMERIC(12,2),
  fall_from_ath_pct           NUMERIC(6,2),
  -- 20% Rally fields
  has_valid_20pct_rally       BOOLEAN,
  last_rally_pct              NUMERIC(6,2),
  last_rally_low              NUMERIC(12,2),
  last_rally_high             NUMERIC(12,2),
  last_rally_start_date       DATE,
  last_rally_end_date         DATE,
  days_since_last_rally       INT,
  -- Trend
  price_change_nd_pct         NUMERIC(6,2),
  raw_yf_meta                 JSONB DEFAULT '{}',            -- future-proof: full meta blob
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (stock_id, snapshot_date)
);
CREATE INDEX idx_snap_date     ON daily_snapshots (snapshot_date DESC);
CREATE INDEX idx_snap_symbol   ON daily_snapshots (symbol, snapshot_date DESC);
CREATE INDEX idx_snap_cap      ON daily_snapshots (cap_bucket, snapshot_date DESC);
```

### 5.4 `fundamentals` — Tier B (quarterly, manual sync)

One row per (stock, reporting quarter). Insert-only history table.

```sql
CREATE TABLE fundamentals (
  id                      BIGSERIAL PRIMARY KEY,
  stock_id                BIGINT REFERENCES stocks(id) ON DELETE CASCADE,
  symbol                  VARCHAR(20) NOT NULL,
  quarter_end_date        DATE NOT NULL,                     -- e.g. 2024-09-30
  quarter_label           VARCHAR(20),                       -- e.g. "Sep 2024"
  -- Financials
  sales                   NUMERIC(20,2),
  pbt                     NUMERIC(20,2),
  net_profit              NUMERIC(20,2),
  operating_margin_pct    NUMERIC(6,2),
  -- Shareholding & pledging
  promoter_holding_pct    NUMERIC(6,2),
  public_holding_pct      NUMERIC(6,2),
  institutional_pct       NUMERIC(6,2),
  promoter_pledging_pct   NUMERIC(6,2),                       -- may be null if source doesn't provide
  -- Quality metrics (latest available at fetch time)
  roce                    NUMERIC(6,2),
  roe                     NUMERIC(6,2),
  net_debt_to_equity      NUMERIC(8,4),
  -- Historical averages (5yr, computed at fetch time)
  pe_5yr_avg              NUMERIC(10,2),
  pb_5yr_avg              NUMERIC(10,2),
  raw_yf_payload          JSONB DEFAULT '{}',                 -- full yfinance blob for future rules
  data_source             VARCHAR(20) DEFAULT 'yfinance',
  fetched_at              TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (stock_id, quarter_end_date)
);
CREATE INDEX idx_fund_symbol_q ON fundamentals (symbol, quarter_end_date DESC);
```

### 5.5 `strategy_configs` — Replaces `strategy_rules.json`

```sql
CREATE TABLE strategy_configs (
  id              VARCHAR(50) PRIMARY KEY,             -- e.g. "envelope_200dma"
  name            VARCHAR(100) NOT NULL,
  enabled         BOOLEAN DEFAULT TRUE,
  strategy_type   VARCHAR(30),                         -- "technical" | "technical_pattern" | "fundamental"
  applies_to_pools TEXT[] DEFAULT '{}',
  priority        INT DEFAULT 0,
  inputs          JSONB DEFAULT '{}',                  -- thresholds
  rules           JSONB DEFAULT '{}',                  -- rule tree
  score_map       JSONB DEFAULT '{}',
  version         INT DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### 5.6 `scan_results` — Persisted scan outputs

```sql
CREATE TABLE scans (
  id                    BIGSERIAL PRIMARY KEY,
  pool_code             VARCHAR(20),
  triggered_by          VARCHAR(30),                    -- 'scheduled' | 'manual' | 'trade_sync'
  snapshot_date         DATE,                           -- which daily_snapshot date the scan used
  strategy_ids          TEXT[],
  total_stocks          INT,
  opportunities_count   INT,
  duration_seconds      NUMERIC(8,2),
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ
);

CREATE TABLE scan_results (
  id                    BIGSERIAL PRIMARY KEY,
  scan_id               BIGINT REFERENCES scans(id) ON DELETE CASCADE,
  stock_id              BIGINT REFERENCES stocks(id),
  symbol                VARCHAR(20),
  strategy_id           VARCHAR(50),
  status                VARCHAR(30),                    -- BUY_ZONE / OPPORTUNITY / VALID / NO_SIGNAL / INVALID
  score                 NUMERIC(6,2),
  best_score            NUMERIC(6,2),
  reasons               JSONB,
  metrics_snapshot      JSONB,                          -- copy of daily_snapshot row used
  fundamentals_check    JSONB,                          -- pass/fail per fundamental rule
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_sr_scan     ON scan_results (scan_id);
CREATE INDEX idx_sr_symbol   ON scan_results (symbol);
```

### 5.7 `trades` — Trading log (Phase 2)

```sql
CREATE TABLE trades (
  id                 BIGSERIAL PRIMARY KEY,
  stock_id           BIGINT REFERENCES stocks(id),
  symbol             VARCHAR(20) NOT NULL,
  side               VARCHAR(4),                        -- BUY / SELL
  entry_date         DATE,
  entry_price        NUMERIC(12,2),
  quantity           INT,
  exit_date          DATE,
  exit_price         NUMERIC(12,2),
  strategy_id        VARCHAR(50),                       -- which strategy suggested it
  scan_result_id     BIGINT REFERENCES scan_results(id),
  status             VARCHAR(20) DEFAULT 'OPEN',        -- OPEN / CLOSED / CANCELLED
  pnl                NUMERIC(14,2) GENERATED ALWAYS AS (
                        CASE WHEN exit_price IS NOT NULL
                             THEN (exit_price - entry_price) * quantity * (CASE WHEN side='BUY' THEN 1 ELSE -1 END)
                        END
                     ) STORED,
  notes              TEXT,
  tags               TEXT[] DEFAULT '{}',
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_trades_symbol_status ON trades (symbol, status);
CREATE INDEX idx_trades_status        ON trades (status);
```

### 5.8 `sync_jobs` — Audit trail for scheduled syncs

```sql
CREATE TABLE sync_jobs (
  id             BIGSERIAL PRIMARY KEY,
  job_type       VARCHAR(30),                           -- 'daily_price' | 'quarterly_fundamentals' | 'universe_import'
  triggered_by   VARCHAR(30),                           -- 'cron' | 'manual'
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  status         VARCHAR(20),                           -- 'running' | 'success' | 'partial' | 'failed'
  stocks_total   INT,
  stocks_success INT,
  stocks_failed  INT,
  errors         JSONB DEFAULT '[]',
  duration_seconds NUMERIC(8,2)
);
CREATE INDEX idx_sync_jobs_type_time ON sync_jobs (job_type, started_at DESC);
```

### 5.9 Views (for common frontend queries)

```sql
-- Latest snapshot per stock (frontend consumes this for the pool view)
CREATE VIEW v_stocks_latest AS
SELECT DISTINCT ON (s.id)
  s.*,
  ds.*,
  (SELECT COUNT(*) FROM trades t WHERE t.symbol = s.symbol AND t.status = 'OPEN') AS open_positions
FROM stocks s
LEFT JOIN daily_snapshots ds ON ds.stock_id = s.id
ORDER BY s.id, ds.snapshot_date DESC;

-- Latest fundamental per stock
CREATE VIEW v_fundamentals_latest AS
SELECT DISTINCT ON (stock_id) *
FROM fundamentals
ORDER BY stock_id, quarter_end_date DESC;
```

---

## 6. Sync Worker Architecture

### 6.1 Daily Price Sync (5 PM IST, every trading day)

**Trigger:** `pg_cron` schedules an Edge Function which invokes the Python worker HTTP endpoint.

**Worker responsibilities:**
1. Load active symbols from `stocks` table
2. Fetch each symbol via yfinance (batched — yfinance supports multi-symbol download)
3. For each symbol:
   - Get last 5y daily for ATH + 200 DMA + 20% rally
   - Get `.info` for market cap, PE, PB, industry, sector
4. Compute all Tier A metrics
5. Upsert row in `daily_snapshots`
6. On success/failure log to `sync_jobs`

**Retry / partial-failure policy:**
- Symbols that fail: retried up to 3 times with exponential backoff
- Final failures logged with error message in `sync_jobs.errors`
- Sync marked "partial" if any symbol fails; frontend banner shows the count

**Efficiency:**
- Use yfinance batch download: `yf.download(tickers=['A.NS','B.NS',...], period='5y', group_by='ticker', threads=True)`
- 300 stocks in ~2-5 minutes vs current 30+ min sequential
- After download, compute all metrics in-memory using pandas vectorized operations
- Single bulk `INSERT ... ON CONFLICT DO UPDATE` per batch to Supabase

### 6.2 Quarterly Fundamentals Sync (manual button, optional pg_cron once/week)

**Trigger:** User clicks "Sync Fundamentals" in UI (or scheduled once a week).

**Worker responsibilities:**
1. Load active symbols
2. For each, fetch `.quarterly_financials`, `.info`, `.major_holders`
3. For each new quarter not yet in `fundamentals`: INSERT new row
4. Log to `sync_jobs`

**Idempotency:** unique constraint on (stock_id, quarter_end_date) prevents duplicates.

### 6.3 Where does the worker run?

**Option A — Fly.io / Railway (Python service, always-on):**
- Free tier available
- Full yfinance library access
- Can also serve any custom API endpoints frontend needs

**Option B — GitHub Actions cron:**
- Zero infra cost
- Runs every day at 5 PM IST via cron schedule
- Writes results to Supabase via REST API
- Downside: 6-hour job timeout (fine for us)

**Option C — Supabase Edge Function calls a Fly.io webhook:**
- Best of both — pg_cron in Supabase invokes the worker on demand

**Leaning toward Option B (GitHub Actions) for simplicity.** See §12 Q1.

---

## 7. Backend API — Minimal Custom Layer

Because Supabase provides a full REST/GraphQL/Realtime API out of the box, we need very few custom endpoints:

| Endpoint | Consumer | Purpose |
|---|---|---|
| Supabase direct (`from('stocks').select('*')`) | Frontend | Read universe |
| Supabase direct on `v_stocks_latest` | Frontend | Main pool view |
| Supabase direct on `scan_results` | Frontend | Scan history |
| Supabase RPC `run_scan(pool_code text)` | Frontend | Trigger a new scan (DB function reads latest snapshots, evaluates strategies, writes results) |
| Supabase RPC `import_universe(csv_text text)` | Frontend Admin | Seed universe |
| Python webhook `/sync/daily` | pg_cron trigger | Fire the daily price sync |
| Python webhook `/sync/quarterly` | Frontend button | Fire fundamental sync |

**Strategy evaluation in DB via `run_scan` PL/pgSQL function:**
Because all data lives in `daily_snapshots` + `fundamentals` + `strategy_configs`, we can evaluate strategies in pure SQL/PLPGSQL. This means scanning is instant (no fetch needed).

Example pseudo-SQL:
```sql
CREATE FUNCTION run_scan(pool text) RETURNS bigint AS $$
DECLARE new_scan_id bigint;
BEGIN
  INSERT INTO scans(pool_code, snapshot_date, triggered_by, started_at)
  VALUES (pool, CURRENT_DATE, 'manual', NOW()) RETURNING id INTO new_scan_id;

  -- Envelope
  INSERT INTO scan_results (scan_id, stock_id, symbol, strategy_id, status, score, reasons, metrics_snapshot)
  SELECT new_scan_id, s.id, s.symbol, 'envelope_200dma',
         CASE WHEN ds.below_200dma_pct >= 14 THEN 'BUY_ZONE'
              WHEN ds.below_200dma_pct >= 9  THEN 'OPPORTUNITY'
              ELSE 'NO_SIGNAL' END,
         CASE WHEN ds.below_200dma_pct >= 14 THEN 100
              WHEN ds.below_200dma_pct >= 9  THEN 70
              ELSE 0 END,
         jsonb_build_array('Below 200 DMA by ' || ds.below_200dma_pct || '%'),
         to_jsonb(ds)
    FROM stocks s
    JOIN daily_snapshots ds ON ds.stock_id = s.id AND ds.snapshot_date = (SELECT MAX(snapshot_date) FROM daily_snapshots)
   WHERE pool = ANY(s.pools);

  -- ... other strategies ...
  UPDATE scans SET finished_at = NOW() WHERE id = new_scan_id;
  RETURN new_scan_id;
END; $$ LANGUAGE plpgsql;
```

**Trade-off:** Migrating strategy logic to SQL means less flexibility than Python. Alternative: keep evaluation in the Python worker and expose it via the sync endpoint.

**See §12 Q5 for decision.**

---

## 8. Frontend Architecture

### 8.1 Directory structure

```
frontend/
  src/
    lib/
      supabase.js          — Supabase client init (reads env vars)
    hooks/
      useStocks.js         — TanStack Query hooks for stocks table
      useLatestSnapshot.js — hook for v_stocks_latest view
      useScanResults.js
      useTrades.js
    components/
      Header.jsx
      PoolTabs.jsx
      StocksTable.jsx      — main pool view
      FilterPanel.jsx
      ExpandedRow.jsx      — shows strategies + fundamentals
      SyncStatusBar.jsx    — shows last daily/quarterly sync
      TradeBadge.jsx       — shows if position is open
    pages/
      HomePage.jsx
      PoolViewPage.jsx     — main workspace (pool tabs)
      TradesPage.jsx       — Phase 2
      AdminPage.jsx        — seed universe, sync buttons, view sync_jobs
    context/
      AuthContext.jsx      — Supabase Auth
      ThemeContext.jsx
    services/
      exportUtils.js
    App.jsx
    main.jsx
  index.html
  vite.config.js
  vercel.json              — Vercel deployment config
  .env.example
    VITE_SUPABASE_URL=
    VITE_SUPABASE_ANON_KEY=
    VITE_SYNC_WEBHOOK_URL=
```

### 8.2 Pool-Level View (kept as-is, evolved)

**Main workspace = `PoolViewPage`:**
- Four tabs: F40, E40, S200, PlayArea (same as Buddy)
- On tab click: React Query fetches `v_stocks_latest WHERE pool = ANY(pools)` — instant, cached, no re-scan
- Filter panel on the side: Cap type, Sector, PE range, PB range, Below DMA, Fall from ATH, Signal type
- Results table with expandable rows
- Expanded row shows:
  - **Tier A (Price Action):** PE, PB, Market Cap, Fall from ATH, DMA, 52W
  - **Tier B (Fundamentals):** Sales, Profit, Shareholding, Pledging (from `v_fundamentals_latest`)
  - **Strategy signals:** All strategies that fired with reasons & scores
  - **Position badge:** If open trade exists in `trades`, show green "🟢 Held" badge
- Header shows "Last synced: 5:03 PM IST" + a "Sync Now" button

### 8.3 Trading Journal (Phase 2)

- `TradesPage` — add / close / edit trades
- On the main pool view: filter checkbox "Show only held" and "Hide held"
- Column showing entry price, days held, P&L (using latest close)

---

## 9. Deployment Plan

### 9.1 Frontend on Vercel

1. Push `frontend/` to a Git repo
2. Connect Vercel to the repo, root = `frontend`
3. Build cmd: `npm run build`, output: `dist`
4. Add env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SYNC_WEBHOOK_URL`
5. Auto-deploy on `main` push

### 9.2 Backend/DB on Supabase

1. Create Supabase project (free tier)
2. Run migration SQL files: `001_stocks.sql`, `002_snapshots.sql`, `003_fundamentals.sql`, ...
3. Enable `pg_cron` extension
4. Create Edge Function for `sync-daily` webhook proxy
5. Schedule cron: `SELECT cron.schedule('daily-price-sync', '30 11 * * 1-5', 'SELECT net.http_post(...);');` (5 PM IST = 11:30 UTC)

### 9.3 Sync Worker on GitHub Actions (or Fly.io)

1. Repo: `artha-sync-worker`
2. `.github/workflows/daily-sync.yml`:
   ```yaml
   on:
     schedule:
       - cron: '30 11 * * 1-5'      # Weekdays 5 PM IST
     workflow_dispatch:
   jobs:
     sync:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-python@v5
         - run: pip install -r requirements.txt
         - run: python sync_daily.py
           env:
             SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
             SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
   ```

---

## 10. Implementation Phases

### Phase 0 — Validation (1-2 days) ⬅ START HERE
- Write `validate_yfinance.py`
- Fetch 2 stocks, produce Validation Report
- **Gate:** Sign-off on data source before rebuild

### Phase 1 — Foundation (3-5 days)
- Create Supabase project + schema migrations
- Create `stocks` seed script that ingests the existing CSV
- Build sync worker skeleton: daily price sync for 5 stocks
- Verify data lands correctly in `daily_snapshots`

### Phase 2 — Full Sync Pipeline (3-5 days)
- Scale daily sync to full ~300 universe
- Implement fundamentals sync
- Set up GitHub Actions cron
- Build `sync_jobs` reporting

### Phase 3 — Frontend Rewrite (5-7 days)
- Scaffold new Vite project with Supabase client
- Build Pool View page (tabs, table, filters)
- Build expandable row with Tier A + Tier B split
- Build Sync Status header + "Sync Now" button
- Deploy to Vercel

### Phase 4 — Scan Engine (3-5 days)
- Decide SQL vs Python evaluation (see §12 Q5)
- Migrate all 3 strategies (Envelope, 52W, 20% Rally) + fundamental screener rules
- Persist scan results
- Frontend integration

### Phase 5 — Trading Journal (3-5 days)
- Trades page
- "Held" filter + badge in main view
- P&L summary

### Phase 6 — Polish
- Theme, mobile, exports, admin tools

---

## 11. Migration & Data Preservation

- **Universe CSV** → seed script → `stocks` table (with `pools` array from all pool columns)
- **Existing `screener_cache.json`** → optional import script → `fundamentals` table (as historical seed only, then never used again)
- **Existing `strategy_rules.json`** → seed script → `strategy_configs` table
- The old Buddy app remains running until Artha is fully validated

---

## 12. Open Questions — Please Confirm Before I Start

### Q1 — Sync Worker Runtime
Where should the yfinance sync worker run?
- **A.** GitHub Actions cron (free, simple, 6h max — sufficient for us)
- **B.** Fly.io always-on Python service (free tier, more flexibility for future features)
- **C.** Railway (free tier expires after $5 credit)
- **D.** Supabase Edge Function only (would require Deno port of yfinance — NOT viable)

> **My recommendation:** A (GitHub Actions) — dead simple, no infra, no cost. Falls back to B if we later need real-time features.

### Q2 — Market Cap Bucket Thresholds
Confirm the thresholds for the Cap Type bucket:
- **Large Cap:** ≥ ₹50,000 Cr
- **Mid Cap:** ₹15,000 – ₹50,000 Cr
- **Small Cap:** ₹5,000 – ₹15,000 Cr
- **Micro Cap:** < ₹5,000 Cr

*(These are approximate SEBI-style thresholds. Different from your CSV's manual `cap_type` column. Should we keep both — auto-computed and manual override?)*

### Q3 — Promoter Pledging Data
If yfinance does NOT expose promoter pledging (very likely for Indian stocks), what should we do?
- **A.** Drop the pledging filter entirely (accept the loss)
- **B.** Add a manual pledging column in DB, admin can edit quarterly
- **C.** Try a free alternate source (NSE bhavcopy has pledging disclosures — parseable)
- **D.** Keep Screener.in JUST for pledging (defeats the point of dropping it)

> **My recommendation:** B — manual override table. Pledging changes rarely, admin can update in <5 min per quarter.

### Q4 — Historical 5yr Avg PE/PB
yfinance doesn't natively give a "5yr avg PE" number. Options:
- **A.** Skip 5yr avg — only compare current PE < absolute threshold (e.g. PE < 25)
- **B.** Reconstruct from daily .history + quarterly EPS series (accurate but complex)
- **C.** Store historical PE snapshots each daily sync — after 5 years we have real data. Use current-only until then.
- **D.** Use `.info["fiveYearAvgDividendYield"]` as proxy (doesn't exist for PE/PB, this is misdirection)

> **My recommendation:** C + partial B — start storing daily PE/PB in `daily_snapshots.raw_yf_meta`, and use "since inception" avg until we have 5 years. In parallel, prototype B for a proper backfill.

### Q5 — Scan Evaluation Engine
Where should strategy evaluation live?
- **A.** In-database PL/pgSQL functions (fast, but SQL is harder for complex logic like 20% Rally streak detection)
- **B.** In the Python sync worker (has all logic already; add a "run scans and store results" step after every sync)
- **C.** In an on-demand Edge Function (TypeScript/Deno rewrite of strategies)

> **My recommendation:** B — after every daily sync, immediately run all strategies and persist to `scan_results`. Frontend just reads. No on-demand scan needed — scan results are always fresh at 5 PM IST.

### Q6 — Auth
Should the app be:
- **A.** Single-user, single Supabase Auth account (you only)
- **B.** Multi-user later (RLS per user_id, each user has their own trades but shared universe/snapshots)

> **My recommendation:** A now, design tables with a nullable `owner_id` column so B is a trivial migration later.

### Q7 — Frontend Charting / Visualization
Do we want price charts embedded (candlestick, DMA overlay)?
- **A.** No — text-only tables, users go to TradingView for charts (like Buddy today)
- **B.** Yes — lightweight sparkline per row
- **C.** Yes — dedicated chart panel on row expansion

> **My recommendation:** A initially, B in polish phase.

### Q8 — CSV as source-of-truth vs DB as source-of-truth
Once seeded, should:
- **A.** CSV remain canonical (edit CSV → re-seed)
- **B.** DB remain canonical (edit stocks via UI, ignore CSV after seed)
- **C.** Both — CSV is versioned in Git for disaster recovery, DB for daily use

> **My recommendation:** C.

### Q9 — Should we KEEP the old Buddy tool live during Artha build?
- **A.** Yes, until Artha is fully functional (safer)
- **B.** No, freeze it — commit to Artha and don't split attention

> **My recommendation:** A — no code changes to Buddy, just leave it deployed. Build Artha in `/artha` sibling folder.

### Q10 — Naming
Confirm the name **Artha**. Alternatives to consider:
- Nivesh (investment)
- Dhan (wealth)
- Lakshya (target)

---

## 13. Success Criteria

Artha is done when:
1. ✅ Daily sync runs at 5 PM IST reliably for 300 stocks in < 5 min
2. ✅ Zero on-demand fetching — every view reads from Supabase in < 500 ms
3. ✅ Persistent data — DB survives redeploys, backups working
4. ✅ Pool view (F40/E40/S200/PlayArea) works identically to Buddy
5. ✅ Every fundamental field currently shown in Buddy is preserved
6. ✅ Market Cap bucket (Large/Mid/Small/Micro) visible per stock
7. ✅ Tier A/B split visible in the expanded row
8. ✅ "Sync Fundamentals" button works
9. ✅ Trading Journal (Phase 5) — held positions visible/filterable in pool view
10. ✅ Frontend hosted on Vercel, backend on Supabase, all with free tiers

---

## 14. Immediate Next Steps

Once you approve the plan and answer §12:

1. Write `Docs/Artha_Validation_Report.MD` after running `validate_yfinance.py`
2. Create empty Supabase project + share connection details
3. Scaffold `/artha` directory with the file layout in §8.1
4. Ship Phase 1 (foundation) end-to-end for 5 stocks as proof-of-life
