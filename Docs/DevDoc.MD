# Buddy Trader — Development Document

## Project Overview
Personal NSE end-of-day swing trading scanner that surfaces ranked opportunities from a configured stock universe using technical strategies. Built for **Vicky** as a daily scanning companion.

## Architecture
```
Buddy/
├── backend/                    # Python FastAPI backend
│   ├── app/
│   │   ├── api/routes.py       # REST endpoints
│   │   ├── core/
│   │   │   ├── config.py       # App config, paths, strategy rules loader
│   │   │   └── universe.py     # CSV parser, pool extractor
│   │   ├── services/
│   │   │   ├── data_fetcher.py  # Yahoo Finance fetcher (v8 API + yfinance fallback + ATH max history)
│   │   │   ├── metrics_engine.py # Technical metrics (DMA, 52W, true ATH from max history)
│   │   │   ├── scanner.py       # Main orchestrator with per-pool caching + ATH integration
│   │   │   ├── screener_data_fetcher.py  # Screener.in HTML parser (quarterly, ratios, pledging)
│   │   │   └── screener_engine.py        # Data-driven fundamental screener engine (SOLID)
│   │   ├── strategies/          # Pluggable strategies
│   │   │   ├── base.py          # Abstract base class
│   │   │   ├── envelope.py      # Envelope (200 DMA) strategy
│   │   │   ├── week52_high_low.py # 52 Week High Low strategy
│   │   │   └── registry.py      # Strategy registry
│   │   ├── static/index.html    # Legacy SPA (superseded by React frontend)
│   │   └── main.py              # FastAPI entry point
│   ├── data/                    # Local data storage (future: SQLite)
│   └── requirements.txt
├── frontend/                    # React + Vite frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── Header.jsx       # Sticky header with nav, theme toggle, dev credit
│   │   │   ├── ResultsTable.jsx # Unified sortable table with expandable strategy details
│   │   │   ├── ScanSummary.jsx  # Metric cards (scanned, buy zone, etc.)
│   │   │   └── StrategyMatrix.jsx # Strategy × Pool matrix from Master CSV
│   │   ├── context/
│   │   │   └── ThemeContext.jsx  # Light/Dark theme with localStorage persistence
│   │   ├── pages/
│   │   │   ├── HomePage.jsx     # Landing: pool cards, motivation, journal, fundamentals
│   │   │   ├── ScannerPage.jsx  # Scanner: pool tabs, filters, scan results
│   │   │   └── ScreenerPage.jsx # Advanced Screener: configurable fundamental screening
│   │   ├── services/
│   │   │   └── api.js           # API client for FastAPI backend
│   │   ├── App.jsx              # Root component with page routing
│   │   └── main.jsx             # Entry point with global styles
│   ├── index.html
│   ├── vite.config.js           # Vite config with proxy to backend
│   └── package.json
├── UserData/
│   ├── Vicky - Master Template - Master.csv   # Stock universe
│   ├── strategy_rules.json                     # Strategy config
│   └── Fundamental POinters.md                 # Trading rules reference
└── Docs/
    ├── Plan.MD          # Original MVP plan
    └── DevDoc.MD        # This file
```

## Tech Stack
| Layer     | Technology              | Purpose                         |
|-----------|------------------------|---------------------------------|
| Backend   | Python 3.8 + FastAPI   | API server, strategy engine     |
| Frontend  | React 18 + Vite 5      | SPA dashboard with routing      |
| Data      | Yahoo Finance (v8 API) | Live OHLCV price data           |
| Config    | JSON                   | Strategy rules, thresholds      |
| Universe  | CSV                    | Stock pools (F40, E40, S200)    |

## API Endpoints
| Method | Endpoint                     | Description                          |
|--------|------------------------------|--------------------------------------|
| GET    | `/`                          | Serve legacy dashboard               |
| GET    | `/api/health`                | Health check                         |
| POST   | `/api/scan?pool=F40`         | Trigger scan for a pool              |
| POST   | `/api/scan?pool=PlayArea&symbols=TCS,INFY` | Scan custom symbols   |
| GET    | `/api/scan/{pool_code}`      | Get cached scan for a pool           |
| GET    | `/api/scan/last`             | Get most recent scan (any pool)      |
| GET    | `/api/scans/status`          | Scan timestamps for all pools        |
| GET    | `/api/pools`                 | List all stock pools                 |
| GET    | `/api/pools/{code}/stocks`   | Stocks in a pool                     |
| GET    | `/api/strategies`            | Strategy configurations              |
| POST   | `/api/cache/clear`           | Clear price + ATH + fundamental cache|
| GET    | `/api/screener/rules`        | Default screener rule definitions    |
| POST   | `/api/screener/run`          | Run advanced fundamental screener    |

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
| Column       | Description                                    |
|-------------|------------------------------------------------|
| Symbol      | NSE ticker                                      |
| Sector      | Industry sector from master CSV                  |
| Cap         | Large / Mid / Small with color-coded badge       |
| Close ₹     | Latest closing price                             |
| 200 DMA     | 200-day moving average                           |
| % Below DMA | How far price is below DMA (positive = below)   |
| 52W Low     | 52-week low price                                |
| 52W High    | 52-week high price                               |
| % From Low  | Distance above 52-week low                       |
| ATH         | **True All-Time High** from max historical data  |
| % ↓ ATH     | How far price has fallen from true ATH           |
| Signal      | BUY / OPP / — (color-coded)                     |
| Score       | Composite score from best strategy               |

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

### 3. 20% Rally
- **ID:** `rally_20_percent`
- **Applies to:** S200
- **Pine Script Source:** `Docs/20_Percent_Rally_PineScript`
- **Logic:** Detects completed consecutive green-candle streaks (close > open) where the move from the streak's lowest Low to highest High is ≥ 20%. Streak must have ended within the last 9 months (~189 trading days). Only *completed* streaks count — an ongoing streak is excluded until it breaks.
- **Signals:**
  - `VALID`   → A qualifying 20% rally found in the window (Score: 100)
  - `INVALID` → No qualifying rally in the window (Score: 0)
- **Extra Outputs:** `next_buy_at` (streak low), `next_sell_at` (streak high), `days_since_last_rally`, `total_valid_rallies_in_window`

---

### 1. Envelope (200 DMA)
- **ID:** `envelope_200dma`
- **Applies to:** F40
- **Logic:** Measures how far current price is below the 200-day moving average
- **Signals:**
  - `BUY_ZONE` → Price ≥ 14% below 200 DMA (Score: 100)
  - `OPPORTUNITY` → Price ≥ 9% below 200 DMA (Score: 70)
  - `NO_SIGNAL` → Price < 9% below 200 DMA (Score: 0)

### 2. 52 Week High Low
- **ID:** `week52_high_low`
- **Applies to:** F40, E40
- **Logic:** Measures proximity of current price to the 52-week low
- **Signals:**
  - `BUY_ZONE` → Price within 0.5% of 52W low (Score: 100)
  - `OPPORTUNITY` → Price within 5% above 52W low (Score: 75)
  - `NO_SIGNAL` → Price > 5% above 52W low (Score: 0)

## Data Accuracy — Metrics Source of Truth (v4)

### What each metric uses and why:

| Metric | Source | Reason |
|--------|--------|--------|
| **Close** | Yahoo meta `regularMarketPrice` | Live unadjusted price, avoids off-by-one on intraday candles |
| **200 DMA** | `rolling(200)` on **AdjClose** (1y daily) | AdjClose series is dividend-adjusted — matches TradingView. Raw Close inflates DMA because pre-dividend prices are not retroactively adjusted in raw series |
| **52W High** | Yahoo meta `fiftyTwoWeekHigh` | Pre-computed by Yahoo, matches screener.in / TV exactly. Computing from `max(High column)` gives intraday extremes that overshoot the screener definition |
| **52W Low** | Yahoo meta `fiftyTwoWeekLow` | Same as above |
| **ATH** | `max(AdjClose)` from **5y daily** | `range=max` silently returns monthly candles → monthly High = entire month's intraday extreme → inflated ATH (saw 4592 vs actual 4289 for TCS). 5y daily gives real daily adjusted closes. Small residual vs TV (~36pts for TCS) is Yahoo vs TV using slightly different dividend adjustment factors — same peak date, conceptually correct |

### Root Cause of Previous Wrong Numbers (TCS example):
| Field | Old (wrong) | New (correct) | TV/Screener | Root Cause Fixed |
|-------|-------------|---------------|-------------|-----------------|
| Close | 2069 | 2069 | 2069 | Already correct |
| 200 DMA | 2736 | 2682 | 2694 | Switched to AdjClose rolling |
| 52W High | 3399 | **3350** | 3350 | Using Yahoo meta field |
| 52W Low | 1976.80 | **1976.80** | 1976.80 | Using Yahoo meta field |
| ATH | 4592 | **4254** | 4289 | Using 5y AdjClose (not max range monthly candles) |

## How to Add a New Strategy
1. Create `backend/app/strategies/your_strategy.py`
2. Extend `BaseStrategy` abstract class
3. Implement `strategy_id`, `strategy_name`, and `evaluate()` method
4. Register in `backend/app/strategies/registry.py`
5. Add strategy config to `UserData/strategy_rules.json`

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

### ✅ Milestone 3: Advanced Fundamental Screener
**Status: COMPLETED — Session 4**

- [x] **Screener Data Fetcher** — fetches fundamental data from Screener.in (HTML parsing)
  - Quarterly results (Sales, PBT, Net Profit)
  - Annual P&L data
  - Key ratios (PE, PB via Price/BookValue, ROCE, ROE)
  - Shareholding (Promoter holding, Pledging)
  - In-memory cache with 6hr TTL
- [x] **Screener Engine** — data-driven rule evaluation (SOLID principles)
  - 9 independent configurable filter rules
  - Pure evaluator functions (business logic decoupled from UI)
  - Evaluator registry pattern (new filters = add config object only)
  - Categories: ATH Filters, Valuation, Quality, Promoter
- [x] **REST API endpoints**
  - `GET /api/screener/rules` — default rule definitions for UI rendering
  - `POST /api/screener/run` — run screener with user-configured rules
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
- [x] **Header updated** — "Screener" nav tab (🔬) alongside Home & Scanner
- [x] **No existing functionality broken** — all prior endpoints verified

### Filter Rules Implemented

| # | Category   | Rule                        | Default     | Condition                                 |
|---|------------|-----------------------------| ------------|-------------------------------------------|
| 1 | ATH        | Sales at ATH                | ✅ On, 2%   | Latest Q Sales ≥ Q-ATH × (1 - tol%)      |
| 2 | ATH        | PBT at ATH                  | ✅ On, 2%   | Latest Q PBT ≥ Q-ATH × (1 - tol%)        |
| 3 | ATH        | Net Profit at ATH           | ✅ On, 2%   | Latest Q Profit ≥ Q-ATH × (1 - tol%)     |
| 4 | ATH        | Match Last N Quarters       | ✅ On, 2Q   | Above 3 rules hold for last N quarters    |
| 5 | Valuation  | PE < Historical Avg PE      | ✅ On, 5yr  | Current PE < Avg PE of previous N years   |
| 6 | Valuation  | PB < Historical Avg PB      | ✅ On, 5yr  | Current PB < Avg PB of previous N years   |
| 7 | Quality    | ROCE ≥ threshold            | ✅ On, 18%  | ROCE ≥ min_value                          |
| 8 | Quality    | ROE ≥ threshold             | ✅ On, 18%  | ROE ≥ min_value                           |
| 9 | Promoter   | Pledging ≤ threshold        | ✅ On, 5%   | Promoter Pledging ≤ max_value             |

### 🔲 Milestone 3b: E40 + S200 Strategy Mapping (Original)
**Status: PENDING**

- [ ] Apply 52W High Low to E40 pool (already configured in rules)
- [ ] Validate E40 scan results against charts
- [ ] Decide which strategies apply to S200

### ✅ Milestone 4: 20% Rally Strategy
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

### 🔲 Milestone 5: Data & Persistence
**Status: PENDING**

- [ ] SQLite persistence for scan history
- [ ] Historical scan comparison
- [ ] Export to CSV/Excel
- [ ] Timestamp-aware cache (market hours)
- [ ] Handle delisted stocks / ticker mismatches

### 🔲 Milestone 6: Production Hardening
**Status: PENDING**

- [ ] Proper error boundaries
- [ ] Rate limiting for Yahoo Finance
- [ ] Logging improvements
- [ ] Docker containerization
- [ ] Automated daily scan (cron)
- [ ] Config management page (strategy enable/disable)

---

## Key Design Decisions
1. **Per-pool scan caching** — switching tabs shows cached data instantly
2. **Single table view** — no separate tabs for opportunities/no-signal; use filters instead
3. **Dark theme default** — easier on eyes during market hours
4. **True ATH from max history** — fetches full listing history for accurate ATH, not just 52W High
5. **Separate ATH cache** — ATH rarely changes, cached independently from 1y price data
6. **PlayArea** — allows scanning any arbitrary set of symbols
7. **Strategy registry pattern** — new strategies added without touching scanner core
8. **Config-driven thresholds** — all values in strategy_rules.json
9. **Pool-aware scanning** — strategies only run on their designated pools
10. **Score-based ranking** — best score across applicable strategies determines position
11. **React + Vite frontend** — fast HMR, component-based, proper state management
12. **Page-based routing** — Home (overview) vs Scanner (workspace) separation

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

# Clear all caches (price + ATH)
curl -X POST http://localhost:8000/api/cache/clear
```
