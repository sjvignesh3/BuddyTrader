# Buddy Trader — Development Document

## Project Overview
Personal NSE end-of-day swing trading scanner that surfaces ranked opportunities from a configured stock universe using technical and fundamental strategies. Built for **Vicky** as a daily scanning companion.

## Architecture
```
Buddy/
├── backend/                    # Python FastAPI backend
│   ├── app/
│   │   ├── api/routes.py       # REST endpoints (scan, screener, cache, pools)
│   │   ├── core/
│   │   │   ├── config.py       # App config, paths, strategy rules loader
│   │   │   └── universe.py     # CSV parser, pool extractor
│   │   ├── services/
│   │   │   ├── data_fetcher.py           # Yahoo Finance v8 API + yfinance fallback + ATH
│   │   │   ├── metrics_engine.py         # Technical metrics (DMA, 52W, true ATH, 20% rally)
│   │   │   ├── scanner.py                # Main orchestrator with per-pool caching
│   │   │   ├── screener_data_fetcher.py  # Screener.in HTML parser + persistent JSON cache
│   │   │   └── screener_engine.py        # Data-driven fundamental screener (SOLID)
│   │   ├── strategies/                   # Pluggable strategy pattern
│   │   │   ├── base.py                   # Abstract base class (ABC)
│   │   │   ├── envelope.py               # Envelope (200 DMA) strategy
│   │   │   ├── week52_high_low.py        # 52 Week High Low strategy
│   │   │   ├── rally_20_percent.py       # 20% Rally strategy (Pine Script translation)
│   │   │   └── registry.py              # Strategy registry
│   │   ├── static/index.html             # Legacy SPA (superseded by React frontend)
│   │   └── main.py                       # FastAPI entry point + background login trigger
│   └── requirements.txt
├── frontend/                   # React + Vite frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── Header.jsx          # Sticky header with nav, theme toggle, auth badge
│   │   │   ├── PoolCards.jsx       # Home page pool status cards
│   │   │   ├── ResultsTable.jsx    # Unified sortable table with expandable rows
│   │   │   ├── ScanControls.jsx    # Scan trigger + PlayArea input
│   │   │   ├── ScanSummary.jsx     # Metric cards (scanned, buy zone, etc.)
│   │   │   └── StrategyMatrix.jsx  # Strategy × Pool matrix from Master CSV
│   │   ├── context/
│   │   │   └── ThemeContext.jsx     # Light/Dark theme with localStorage persistence
│   │   ├── pages/
│   │   │   ├── HomePage.jsx         # Landing: pool cards, motivation, journal, fundamentals
│   │   │   ├── ScannerPage.jsx      # Scanner: pool tabs, filters, scan results
│   │   │   └── ScreenerPage.jsx     # Advanced Screener: configurable fundamental screening
│   │   ├── services/
│   │   │   ├── api.js               # API client for FastAPI backend
│   │   │   └── exportUtils.js       # Export helpers
│   │   ├── App.jsx                  # Root component with page routing
│   │   └── main.jsx                 # Entry point with global styles
│   ├── index.html
│   ├── vite.config.js               # Vite config with proxy to backend
│   └── package.json
├── UserData/
│   ├── Vicky - Master Template - Master.csv   # Stock universe (F40 / E40 / S200)
│   ├── strategy_rules.json                     # Strategy config + thresholds
│   ├── screener_cache.json                     # Persistent fundamental data cache
│   └── Fundamental POinters.md                 # Trading rules reference
└── Docs/
    ├── Plan.MD                   # Original MVP plan
    ├── DevDoc.MD                 # This file
    └── 20_Percent_Rally_PineScript  # Pine Script source for 20% Rally translation
```

## Tech Stack
| Layer      | Technology                    | Purpose                                    |
|------------|------------------------------|--------------------------------------------|
| Backend    | Python 3.8 + FastAPI          | API server, strategy engine, screener      |
| Frontend   | React 18 + Vite 5             | SPA dashboard with routing                 |
| Price Data | Yahoo Finance v8 API          | Live OHLCV, meta fields, 52W high/low      |
| Fund. Data | Screener.in (HTML + chart API)| PE/PB history, ROCE, ROE, quarterly P&L   |
| Config     | JSON                          | Strategy rules, thresholds                 |
| Universe   | CSV                           | Stock pools (F40, E40, S200)               |
| Session    | Python pickle                 | Persistent screener.in session cookie      |
| Fund Cache | JSON (atomic writes)          | Persistent fundamental data across restarts|

## API Endpoints
| Method | Endpoint                          | Description                                        |
|--------|-----------------------------------|----------------------------------------------------|
| GET    | `/api/health`                     | Health check                                       |
| POST   | `/api/scan?pool=F40`              | Trigger scan for a pool                            |
| POST   | `/api/scan?pool=PlayArea&symbols=TCS,INFY` | Scan custom symbols                   |
| GET    | `/api/scan/{pool_code}`           | Get cached scan for a pool                         |
| GET    | `/api/scan/last`                  | Get most recent scan (any pool)                    |
| GET    | `/api/scans/status`               | Scan timestamps for all pools                      |
| GET    | `/api/pools`                      | List all stock pools                               |
| GET    | `/api/pools/{code}/stocks`        | Stocks in a pool                                   |
| GET    | `/api/strategies`                 | Strategy configurations                            |
| POST   | `/api/cache/clear`                | Clear price + ATH + fundamental cache              |
| GET    | `/api/screener/rules`             | Default screener rule definitions                  |
| GET    | `/api/screener/auth-status`       | Screener.in authentication mode + note             |
| GET    | `/api/screener/cache-info`        | Persistent cache contents (all cached symbols)     |
| POST   | `/api/screener/run`               | Run fundamental screener (non-streaming)           |
| POST   | `/api/screener/run-stream`        | Run fundamental screener (SSE streaming)           |

## Dashboard Features

### Home Page
- **Buddy Trader** branding with sticky header
- **Daily motivational quote** for trading discipline
- **Pool cards** with scan status, signal counts, last scan time, pool metadata (method, cap, volatility, priority)
- **Quick Links**: Trading Journal (Google Sheets) + Scanner shortcut
- **Fundamental Pointers** quick reference:
  - **Position Sizing**: Max 5% large cap, 3% mid cap, 1.5% small cap
  - **Buy Only on Fall**: 20-30% large, 35-50% mid, 50-70% small cap falls
  - **Must-Have Conditions**: PE, D/E, ROCE, ROE, Profit, OPM, Sales ATH, etc.
  - **Good to Have**: Below median PE, EV/EBITDA, asset growth
  - **Watch Out**: Interest burden, exceptional items, tax anomalies
- **Strategy × Pool Matrix**: All 11 strategies mapped to 4 pools

### Scanner Page
- **4 pool tabs**: F40, E40, S200, PlayArea — each with last scanned time indicator
- **Per-pool caching**: Switch tabs instantly without re-scanning
- **PlayArea**: Text input for custom comma-separated symbols
- **Scan summary cards**: Scanned, Data OK, Buy Zone, Opportunity, No Signal, Errors
- **Post-scan filters**:
  - Signal (All / Has Signal / Buy Zone / Opportunity / No Signal)
  - Cap Type (Large / Mid / Small)
  - Sector (dynamic from scan data)
  - % Below DMA (min/max range)
  - % From Low (min/max range)
  - % Down ATH (min/max range)
- **Unified results table**: All stocks in one table, differentiated by signal badges
- **Sortable columns**: Click any header to sort ascending/descending
- **Expandable rows**: Click for strategy-level details with reasons

### Table Columns
| Column        | Description                                       |
|--------------|---------------------------------------------------|
| Symbol       | NSE ticker                                         |
| Sector       | Industry sector from master CSV                    |
| Cap          | Large / Mid / Small with color-coded badge         |
| Close ₹      | Latest closing price                               |
| 200 DMA      | 200-day moving average                             |
| % Below DMA  | How far price is below DMA (positive = below)      |
| 52W Low      | 52-week low price                                  |
| 52W High     | 52-week high price                                 |
| % From Low   | Distance above 52-week low                         |
| ATH          | True All-Time High from max historical data        |
| % ↓ ATH      | How far price has fallen from true ATH             |
| Signal       | BUY / OPP / — (color-coded)                        |
| Score        | Composite score from best strategy                 |

### Strategy × Pool Matrix (from Master CSV)

| Strategy          | F40 | E40           | S200 | All |
|-------------------|-----|---------------|------|-----|
| Long Envelope     | ✓   |               |      |     |
| Short Envelope    | ✓   |               |      |     |
| Envelope + Knox   | ✓   |               |      |     |
| 52W High Low      | ✓   |               |      |     |
| SMA               | ✓   | Only With BCD |      |     |
| RHS               | ✓   | ✓             |      |     |
| CWH               | ✓   | ✓             |      |     |
| 10% Correction    | ✓   | ✓             |      |     |
| ABCD              | ✓   | ✓             | ✓    |     |
| 20% Rally         | ✓   | ✓             | ✓    |     |
| S&R               | ✓   | ✓             | ✓    |     |

## UI/UX Design
- **Theme**: Dark (default) + Light toggle, localStorage persisted
- **Color Palette**: Neutral-first (GitHub-inspired) with accent pops
  - Dark: `#0D1117` bg, `#58A6FF` accent, `#3FB950` success
  - Light: `#F5F6F8` bg, `#4A7FDB` accent, `#2DA44E` success
- **Typography**: Inter font family, monospace for numbers
- **Scrollbar**: Hidden globally for clean appearance
- **Animations**: Fade-in on page transitions, spin for loading states
- **Responsive**: Grid layouts with `auto-fit` for all screen sizes
- **Navigation**: Header-based with Home / Scanner / Screener

## Strategies Implemented

### 1. Envelope (200 DMA)
- **ID:** `envelope_200dma`
- **Applies to:** F40
- **Logic:** Measures how far current price is below the 200-day moving average (computed on AdjClose to match TradingView)
- **Signals:**
  - `BUY_ZONE` → Price ≥ 14% below 200 DMA (Score: 100)
  - `OPPORTUNITY` → Price ≥ 9% below 200 DMA (Score: 70)
  - `NO_SIGNAL` → Price < 9% below 200 DMA (Score: 0)

### 2. 52 Week High Low
- **ID:** `week52_high_low`
- **Applies to:** F40, E40
- **Logic:** Measures proximity of current price to the 52-week low (sourced from Yahoo meta fields for screener.in accuracy)
- **Signals:**
  - `BUY_ZONE` → Price within 0.5% of 52W low (Score: 100)
  - `OPPORTUNITY` → Price within 5% above 52W low (Score: 75)
  - `NO_SIGNAL` → Price > 5% above 52W low (Score: 0)

### 3. 20% Rally
- **ID:** `rally_20_percent`
- **Applies to:** S200
- **Pine Script Source:** `Docs/20_Percent_Rally_PineScript`
- **Logic:** Detects completed consecutive green-candle streaks (close > open) where the move from the streak's lowest Low to highest High is ≥ 20%. Streak must have ended within the last 9 months (~189 trading days). Only *completed* streaks count — an ongoing streak is excluded until it breaks.
- **Signals:**
  - `VALID`   → A qualifying 20% rally found in the window (Score: 100)
  - `INVALID` → No qualifying rally in the window (Score: 0)
- **Extra Outputs:** `next_buy_at` (streak low), `next_sell_at` (streak high), `days_since_last_rally`, `total_valid_rallies_in_window`

## Data Accuracy — Metrics Source of Truth (v5)

### What each metric uses and why:

| Metric      | Source                                          | Reason                                                                       |
|-------------|------------------------------------------------|------------------------------------------------------------------------------|
| **Close**   | Yahoo meta `regularMarketPrice`                | Live unadjusted price, avoids off-by-one on intraday candles                 |
| **200 DMA** | `rolling(200)` on **AdjClose** (1y daily)      | AdjClose is dividend-adjusted — matches TradingView. Raw Close inflates DMA  |
| **52W High**| Yahoo meta `fiftyTwoWeekHigh`                  | Pre-computed by Yahoo, matches screener.in / TV exactly                      |
| **52W Low** | Yahoo meta `fiftyTwoWeekLow`                   | Same as above                                                                |
| **ATH**     | `max(High × AdjClose/Close)` from 5y daily     | Adjusted intraday High. AdjClose captures close not the peak; raw High is not dividend-adjusted |

### Why Adjusted High for ATH (v5 fix):
ATH = highest intraday price ever reached, adjusted for dividends/splits.
- `AdjClose` only captures the closing price — the ATH candle's High is always ≥ its Close.
- `raw High` is unadjusted — does not account for historical dividends.
- **Fix:** `adjusted_high = High × (AdjClose / Close)` per row → gives a true dividend-adjusted intraday high series. ATH = max of this series over 5y daily data.

### Root Cause of Previous Wrong Numbers (TCS example):
| Field    | Old (wrong) | New (correct) | TV/Screener | Root Cause Fixed                          |
|----------|-------------|---------------|-------------|-------------------------------------------|
| Close    | 2069        | 2069          | 2069        | Already correct                           |
| 200 DMA  | 2736        | 2682          | 2694        | Switched to AdjClose rolling              |
| 52W High | 3399        | **3350**      | 3350        | Using Yahoo meta field                    |
| 52W Low  | 1976.80     | **1976.80**   | 1976.80     | Using Yahoo meta field                    |
| ATH      | 4592        | **4254**      | 4289        | Using 5y AdjClose × High (not max range monthly candles) |

## Screener — Fundamental Data Architecture

### Tier 1: Public Data (no login)
- Company ID via Screener.in search API (`/api/company/search/?q=SYMBOL`)
- PE daily history up to 10 years via chart API (`/api/company/{id}/chart/?q=Price+to+Earning`)
- PB daily history up to 10 years via chart API
- Current PE and PB from last data point in series

### Tier 2: Authenticated Data (requires `SCREENER_EMAIL` + `SCREENER_PASSWORD`)
- Quarterly Sales, PBT, Net Profit (HTML table parser on `#quarters` section)
- ROCE, ROE from `#top-ratios` section
- Net Debt to Equity from quick-ratios Ajax API (`/api/company/{warehouseId}/quick_ratios/`)
- Promoter pledging from `#analysis` cons bullet list or `<meta name="description">` (NOT the shareholding table — confirmed by HTML inspection)
- 5-year PE average from `5Yrs PE` quick-ratio label
- 5-year PB average from `5Yrs PBV` quick-ratio label

### Login Flow
1. GET `https://www.screener.in/login/` → extract CSRF token
2. POST credentials + CSRF token → receive `sessionid` cookie
3. Session persisted to `backend/screener_session.pkl` (reused up to 23 hours)
4. On expiry → automatic re-login
5. Rate limit handling: 429 response triggers 65-second backoff + single retry

### Persistent JSON Cache (`UserData/screener_cache.json`)
- Survives backend restarts — no data lost on restart
- Atomic writes (`.tmp` → rename) — crash-safe
- Slim format: raw daily PE/PB series (3650 rows each) stripped before writing to disk; only computed averages and key scalars stored
- No TTL — entries remain valid until `force_refresh=True` is explicitly requested
- Surgical updates — force refresh on N symbols only updates those N entries

### Source Consistency Rule (PE / PB)
Current PE and the 5yr average PE **must** come from the same source (both TTM-based from screener.in page). Mixing the chart API's PE with the page's 5yr average produces wrong pass/fail results because the two use different EPS calculation methodologies.

## Screener Filter Rules

| # | Category   | Rule                        | Default     | Condition                                       |
|---|------------|-----------------------------| ------------|--------------------------------------------------|
| 1 | ATH        | Sales at ATH                | ✅ On, 2%   | Latest Q Sales ≥ Q-ATH × (1 - tol%)             |
| 2 | ATH        | PBT at ATH                  | ✅ On, 2%   | Latest Q PBT ≥ Q-ATH × (1 - tol%)               |
| 3 | ATH        | Net Profit at ATH           | ✅ On, 2%   | Latest Q Profit ≥ Q-ATH × (1 - tol%)            |
| 4 | Valuation  | PE < Historical Avg PE      | ✅ On, 5yr  | Current PE < Avg PE of previous N years          |
| 5 | Valuation  | PB < Historical Avg PB      | ✅ On, 5yr  | Current PB < Avg PB of previous N years          |
| 6 | Valuation  | Net Debt/Equity < threshold | ✅ On, 0.3x | Net Debt to Equity < max_value                   |
| 7 | Quality    | ROCE ≥ threshold            | ✅ On, 18%  | ROCE ≥ min_value                                 |
| 8 | Quality    | ROE ≥ threshold             | ✅ On, 18%  | ROE ≥ min_value                                  |
| 9 | Promoter   | Pledging ≤ threshold        | ✅ On, 5%   | Promoter Pledging ≤ max_value                    |

**ATH Rules note:** Quarterly-only comparison — no mixing of quarterly vs annual figures. Latest Q value vs max of all historical Q values.

**Pledging note:** If pledging data returns `None`, it is treated as a FAIL (cannot verify = reject for safety). Screener.in only shows the pledging sentence when > 0% — so `None` is genuinely ambiguous.

## SSE Streaming Screener
The `/api/screener/run-stream` endpoint emits Server-Sent Events for every step:
- `manifest` — full plan (cache hits vs internet fetches, ETA)
- `progress` — per-symbol status (`cache_hit` | `fetching` | `fetched`)
- `throttle_tick` — countdown ticks between internet fetches (1 per second)
- `complete` — final results payload

Architecture: fetcher runs in a background thread → pushes events into a `queue.Queue` → async generator drains the queue → yields SSE lines. Prevents the sync HTTP calls from blocking FastAPI's event loop.

Throttle rule: activates when > 5 symbols need live internet fetches. Each pair of fetches is separated by 20 seconds to avoid screener.in 429 rate limiting. Cache hits are always instant.

## How to Add a New Strategy
1. Create `backend/app/strategies/your_strategy.py`
2. Extend `BaseStrategy` abstract class
3. Implement `strategy_id`, `strategy_name`, and `evaluate()` method
4. Register in `backend/app/strategies/registry.py`
5. Add strategy config to `UserData/strategy_rules.json`

## How to Add a New Screener Filter Rule
1. Append a rule config dict to `DEFAULT_SCREENER_RULES` in `screener_engine.py`
2. Write the evaluator function (receives `fundamental_data`, `rule`, `params` → returns `{passed, reason, ...}`)
3. Register the evaluator in `EVALUATOR_REGISTRY`
4. No other code changes needed — the UI auto-renders from the rule config schema

---

## Development Milestones

### ✅ Milestone 1: Foundation
**Status: COMPLETED — Session 1**

- [x] Project structure (backend + frontend scaffold)
- [x] Strategy rules JSON (strategy_rules.json)
- [x] CSV universe parser (F40, E40, S200 pools)
- [x] FastAPI backend with CORS
- [x] Yahoo Finance data fetcher (v8 API + yfinance fallback + cache)
- [x] Metrics engine (200 DMA, 52W high/low, percentages)
- [x] Envelope strategy
- [x] 52 Week High Low strategy
- [x] Strategy registry (pluggable pattern)
- [x] Scanner orchestrator (fetch → compute → evaluate → rank)
- [x] REST API endpoints
- [x] Basic HTML dashboard with scan controls & results table
- [x] DevDoc.MD created

### ✅ Milestone 2: Dashboard v2 — UX & Features
**Status: COMPLETED — Session 2**

- [x] React + Vite frontend setup
- [x] **Home page** with pool cards, motivation quote, journal link
- [x] **Fundamental pointers** (position sizing, buy rules, must-haves, watch-outs)
- [x] **Strategy × Pool Matrix** (all 11 strategies mapped correctly from Master CSV)
- [x] **4 pool tabs**: F40, E40, S200, PlayArea
- [x] **Per-pool scan caching** — switch tabs without re-scanning
- [x] **Last scanned time** per pool tab
- [x] **PlayArea** — custom symbol input for ad-hoc screening
- [x] **Unified single table** (all stocks, differentiated by signal badges)
- [x] **True ATH**: Fetches max historical data for real All-Time High (not 52W High)
- [x] **Rich filters**: Signal, Cap Type, Sector, % Below DMA, % From Low, % Down from ATH
- [x] **Color-coded cap badges**: Large (blue), Mid (amber), Small (red)
- [x] **Dark/Light theme toggle** with localStorage persistence
- [x] **Header**: "Buddy Trader" branding with nav links
- [x] **Hidden scrollbar** for clean appearance
- [x] **Professional UI/UX**: Neutral palette, consistent spacing, smooth animations
- [x] Expandable rows with strategy details
- [x] Developer credit (Vicky)
- [x] DevDoc.MD updated with v2 architecture

### ✅ Milestone 3: 20% Rally Strategy
**Status: COMPLETED — Session 3**

- [x] Translate Pine Script (`Docs/20_Percent_Rally_PineScript`) to Python exactly
- [x] `compute_rally_metrics()` in metrics_engine — streak detection, low/high tracking, rally%
- [x] Completed-streak-only rule (mirrors Pine: label fires only when streak breaks)
- [x] Validity window extended to **9 months (189 trading days)** per user requirement
- [x] `rally_20_percent.py` strategy — VALID/INVALID status, Score 100/0
- [x] `next_buy_at` / `next_sell_at` price levels (Pine: "Next Buy at" / "Next Sell at" labels)
- [x] Registered in `registry.py`, applies to S200 pool
- [x] `compute_metrics()` signature extended with `rally_threshold` + `rally_window_days`
- [x] Scanner passes rally config thresholds to metrics engine
- [x] Frontend: VALID/INVALID signal badge (blue "RALLY" badge)
- [x] Frontend: Expanded row shows Next Buy/Sell prices + days since streak
- [x] ScanSummary: New "20% Rally" metric card with count
- [x] Signal filter: "20% Rally ✓" and "No Rally" options added
- [x] `strategy_rules.json` updated (field names, 189-day window)

### ✅ Milestone 4: Advanced Fundamental Screener
**Status: COMPLETED — Session 4**

- [x] **Screener Data Fetcher** — fetches fundamental data from Screener.in (HTML parsing)
  - Quarterly results (Sales, PBT, Net Profit)
  - Annual P&L data
  - Key ratios (PE, PB via Price/BookValue, ROCE, ROE, Net Debt/Equity)
  - Promoter pledging (from `#analysis` bullet list — confirmed correct HTML location)
  - Quick-ratios Ajax API for user-added custom ratios (5Yrs PE, 5Yrs PBV, Pledged %)
  - In-memory cache with 6hr TTL
- [x] **Persistent JSON cache** — `UserData/screener_cache.json`
  - Survives backend restarts
  - Atomic disk writes (crash-safe)
  - Slim format (raw time series stripped, only scalars stored)
  - No TTL — persists until explicit force_refresh
  - Surgical updates (subset force refresh does not affect other entries)
- [x] **SSE Streaming endpoint** — `/api/screener/run-stream`
  - manifest → progress → throttle_tick → complete event sequence
  - Background thread + asyncio queue bridge
  - Live countdown timer during 20s inter-fetch throttle
- [x] **Screener Engine** — data-driven rule evaluation (SOLID principles)
  - 9 independent configurable filter rules
  - Pure evaluator functions (business logic decoupled from UI)
  - Evaluator registry pattern (new filters = add config object + function only)
  - Categories: ATH Filters, Valuation, Quality, Promoter
- [x] **REST API endpoints**
  - `GET /api/screener/rules` — default rule definitions for UI rendering
  - `GET /api/screener/auth-status` — authentication mode + note for UI
  - `GET /api/screener/cache-info` — persistent cache contents
  - `POST /api/screener/run` — run screener (non-streaming)
  - `POST /api/screener/run-stream` — run screener (SSE streaming)
- [x] **React Screener Page** — full UI with:
  - Pool tabs (F40, E40, S200, PlayArea)
  - Data-driven filter configuration panel (auto-generated from rule configs)
  - Enable/disable checkbox per rule
  - User-editable parameter values with validation
  - Tooltip/help text for each criterion
  - Reset to Defaults button
  - LocalStorage persistence of all user preferences
  - Summary cards (Total, Data Available, All Passed, Duration)
  - **Copyable comma-separated symbol list** for passed stocks
  - Sortable results table with all fundamental columns
  - Expandable rows with per-rule evaluation details
  - Filter by: All / Passed / Failed
  - Auth status badge in header
  - SSE streaming progress panel with live countdown timer
- [x] **Header updated** — "Screener" nav tab (🔬) alongside Home & Scanner
- [x] **No existing functionality broken** — all prior endpoints verified

### ✅ Milestone 5: Data Accuracy v5 — Adjusted High ATH
**Status: COMPLETED**

- [x] ATH calculation switched from `max(AdjClose)` to `max(High × AdjClose/Close)`
- [x] Captures true intraday peak, not just closing price
- [x] Root cause documented: JPOLYINVST example (ATH day Close=1415 vs High=1487 — 72pt gap)
- [x] Fallback in 1y df also uses adjusted High (not raw High)

### 🔲 Milestone 6: Data & Persistence
**Status: PENDING**

- [ ] SQLite persistence for scan history
- [ ] Historical scan comparison
- [ ] Export to CSV/Excel
- [ ] Timestamp-aware cache (market hours)
- [ ] Handle delisted stocks / ticker mismatches

### 🔲 Milestone 7: Production Hardening
**Status: PENDING**

- [ ] Proper error boundaries in React
- [ ] Rate limiting for Yahoo Finance
- [ ] Logging improvements
- [ ] Docker containerization
- [ ] Automated daily scan (cron)
- [ ] Config management page (strategy enable/disable from UI)

---

## Key Design Decisions
1. **Per-pool scan caching** — switching tabs shows cached data instantly
2. **Single table view** — no separate tabs for opportunities/no-signal; use filters instead
3. **Dark theme default** — easier on eyes during market hours
4. **True ATH from adjusted intraday High** — `High × (AdjClose/Close)` per row over 5y daily, not just AdjClose max
5. **Separate ATH cache** — ATH rarely changes, cached independently from 1y price data
6. **PlayArea** — allows scanning any arbitrary set of symbols; enriched with master CSV metadata where available
7. **Strategy registry pattern** — new strategies added without touching scanner core
8. **Config-driven thresholds** — all values in strategy_rules.json
9. **Pool-aware scanning** — strategies only run on their designated pools
10. **Score-based ranking** — best score across applicable strategies determines position
11. **React + Vite frontend** — fast HMR, component-based, proper state management
12. **Page-based routing** — Home (overview) vs Scanner (workspace) vs Screener separation
13. **Persistent JSON cache** — fundamental data survives restarts; no re-fetch unless force_refresh
14. **Source consistency for PE/PB** — current value and N-year average must both come from the same methodology (both TTM from screener.in page)
15. **Pledging from analysis bullets** — screener.in does not put pledging % in the shareholding table; it only appears in the `#analysis` cons list and the `<meta name="description">` tag
16. **SSE streaming** — sync fetcher thread + asyncio queue bridge prevents blocking the event loop during long screener runs
17. **Atomic disk writes** — screener_cache.json uses `.tmp` → rename for crash safety

---

## Running the Application

> **Two terminals are always needed** — one for the backend, one for the frontend.
> Both must be running simultaneously for the dashboard to work.

---

### ⚠️ One-Time Environment Setup — `npm` PATH Fix

The Zoho Code IDE ships its own Node/npm runtime that is **not on the system PATH by default**.
Running `npm` in a fresh terminal gives: `bash: npm: command not found`.

**Fix — run once ever, never again:**
```bash
echo '' >> ~/.bashrc
echo '# Node/npm - Zoho Code IDE bundled runtime' >> ~/.bashrc
echo 'export PATH="/home/workspace/Buddy/.bin:/mnt/shared/agent/zcode/zcode_13897342/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

**Verify it worked:**
```bash
node --version   # → v24.x.x
npm --version    # → 11.x.x
```

> This fix is persistent — once added to `~/.bashrc` it survives terminal restarts.
> The `.bin/` folder inside the project contains wrapper scripts that point to the IDE's Node binary.

---

### Step 0 — First Time Only (Install Dependencies)

**Backend:**
```bash
cd /home/workspace/Buddy/backend
pip install -r requirements.txt
```

**Frontend** *(node_modules already exists — only run if freshly cloned)*:
```bash
cd /home/workspace/Buddy/frontend
npm install
```

---

### Step 1 — Kill Stale Processes First

> **Always do this before starting** — if a previous terminal was closed without `CTRL+C`,
> the process keeps running on the port and causes `[Errno 98] Address already in use`.

```bash
kill -9 $(lsof -ti :8000) 2>/dev/null && echo "Port 8000 cleared" || echo "Port 8000 was free"
kill -9 $(lsof -ti :3000) 2>/dev/null && echo "Port 3000 cleared" || echo "Port 3000 was free"
```

---

### Step 2 — Start Backend (Terminal 1)

```bash
cd /home/workspace/Buddy/backend
python3 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Expected output:**
```
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:     Started reloader process [xxxxx]
INFO:     Application startup complete.
```

> ⚠️ Keep this terminal open. `CTRL+C` stops the backend.

---

### Step 3 — Start Frontend (Terminal 2)

Open a **new terminal tab**, then:

```bash
cd /home/workspace/Buddy/frontend
npm run dev
```

**Expected output:**
```
  VITE v5.x.x  ready in xxx ms

  ➜  Local:   http://localhost:3000/
  ➜  Network: http://0.0.0.0:3000/
```

> ⚠️ Keep this terminal open. `CTRL+C` stops the frontend.
> If `npm: command not found` appears, do the **One-Time Environment Setup** above first.

---

### Step 4 — Open the Dashboard

| What | URL |
|------|-----|
| **Dashboard (use this)** | `http://localhost:3000/` |
| Backend API direct | `http://localhost:8000/api/` |
| Health check | `http://localhost:8000/api/health` |

The frontend at port 3000 automatically proxies all `/api/*` calls to port 8000 — no manual wiring needed.

---

### Stopping the Application

Press `CTRL+C` in each terminal.

If a terminal was closed without stopping (causing "address already in use" next time):
```bash
kill -9 $(lsof -ti :8000) 2>/dev/null
kill -9 $(lsof -ti :3000) 2>/dev/null
```

---

### Screener Credentials (Optional — for full fundamental data)

Add to `backend/.env` (copy from `.env.example`):
```
SCREENER_EMAIL=your@email.com
SCREENER_PASSWORD=yourpassword
```

Without credentials: only PE/PB history available (public chart API).
With credentials: quarterly results, ROCE, ROE, pledging, Net Debt/Equity also available.

Session is automatically persisted to `backend/screener_session.pkl` — login once, reused for ~23 hours.

---

### Quick API Test (Optional — Terminal 3)

```bash
# Health check
curl http://localhost:8000/api/health

# Run F40 scan
curl -X POST "http://localhost:8000/api/scan?pool=F40"

# Get cached F40 results
curl http://localhost:8000/api/scan/F40

# Scan custom stocks (PlayArea)
curl -X POST "http://localhost:8000/api/scan?pool=PlayArea&symbols=TCS,INFY,RELIANCE"

# Get scan statuses for all pools
curl http://localhost:8000/api/scans/status

# Clear all caches (price + ATH + fundamentals)
curl -X POST http://localhost:8000/api/cache/clear

# Check screener auth status
curl http://localhost:8000/api/screener/auth-status

# Check persistent cache contents
curl http://localhost:8000/api/screener/cache-info
```
