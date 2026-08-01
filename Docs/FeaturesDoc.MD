# Buddy Trader — Features & Implementation Guide

> This document describes every feature of Buddy Trader: what it does, why it was built that way,
> which tools and languages were used, and the exact logic behind each decision.
> Reading this end-to-end gives you a complete understanding of the system —
> well enough to explain and own every part of it.

---

## Table of Contents

1. [What Buddy Trader Is](#1-what-buddy-trader-is)
2. [Technology Choices](#2-technology-choices)
3. [Stock Universe & Pool System](#3-stock-universe--pool-system)
4. [Price Data Pipeline](#4-price-data-pipeline)
5. [Technical Metrics Engine](#5-technical-metrics-engine)
6. [Strategy System](#6-strategy-system)
7. [Scanner Orchestrator](#7-scanner-orchestrator)
8. [Fundamental Screener](#8-fundamental-screener)
9. [API Layer](#9-api-layer)
10. [Frontend Dashboard](#10-frontend-dashboard)
11. [Configuration System](#11-configuration-system)
12. [Caching Architecture](#12-caching-architecture)
13. [Data Accuracy Decisions](#13-data-accuracy-decisions)
14. [Security & Authentication](#14-security--authentication)

---

## 1. What Buddy Trader Is

Buddy Trader is a personal NSE stock scanner built for daily swing trading. It solves one specific problem: instead of manually checking hundreds of stocks every day to find which ones are in a buying zone, it does that automatically and surfaces only the relevant ones with clear reasons.

**What it does not do:**
- It does not place orders or connect to a broker.
- It does not back-test strategies.
- It does not send alerts.
- It does not fetch real-time intraday data.

**What it does do:**
- Fetches end-of-day price data for a configured universe of NSE stocks.
- Computes technical metrics (200 DMA, 52-week high/low, All-Time High, rally patterns).
- Evaluates each stock against configurable trading strategies.
- Ranks and filters stocks by signal strength.
- Fetches and evaluates fundamental data (PE, PB, ROCE, ROE, quarterly results, pledging).
- Presents everything in a clean React dashboard.

---

## 2. Technology Choices

### Backend: Python + FastAPI

**Why Python:** Python is the industry standard for data processing, financial calculations, and anything involving numerical operations on time series. Libraries like `pandas` make operations like rolling averages over 200 trading days a single line of code. Every financial library — yfinance, pandas, numpy — is native Python.

**Why FastAPI:** FastAPI is a modern Python web framework that automatically generates REST API documentation, handles request validation, supports async operations (critical for SSE streaming), and has near-zero boilerplate. It was chosen over Flask because FastAPI natively supports async endpoints, which the screener streaming feature depends on.

**FastAPI's role here:** It exposes REST endpoints that the React frontend calls. When a scan is triggered, FastAPI receives the request, runs the scanner, and returns JSON results. The screener streaming endpoint uses FastAPI's `StreamingResponse` to push Server-Sent Events line by line.

### Frontend: React + Vite

**Why React:** React's component model is ideal for a dashboard with many independent UI pieces — pool tabs, filter panels, expandable rows, summary cards. State management (which pool is selected, what the filter values are, what the scan results are) is handled cleanly through React's state system. Context API is used for global state (theme, auth status).

**Why Vite:** Vite is a build tool that provides instant hot module replacement during development — change a component, see it update in the browser in under 100ms without a full page reload. It also handles the proxy configuration that routes all `/api/*` requests from port 3000 to port 8000, so there are no CORS issues during development.

**React's role here:** Every visible piece of the dashboard — the pool tabs, the results table, the filter panel, the screener configuration — is a React component. Components fetch data from the FastAPI backend via the `api.js` service module and render results.

### Data Sources

**Yahoo Finance (price data):** Free, no API key required, covers all NSE stocks with `.NS` suffix. The v8 JSON API (`query1.finance.yahoo.com/v8/finance/chart/`) is called directly with Python's `urllib` — no library dependency. yfinance library is used as a fallback if the direct API call fails.

**Screener.in (fundamental data):** Used for quarterly financial results, PE/PB history, ROCE, ROE, promoter pledging, and Net Debt to Equity. The public chart API (`/api/company/{id}/chart/`) provides PE and PB history without login. Full fundamental data (quarterly results, ROCE, ROE, pledging) requires an authenticated session.

### Configuration: JSON

All strategy thresholds, pool assignments, and rule parameters live in `UserData/strategy_rules.json`. This means changing a threshold (e.g. making the Envelope buy zone 12% instead of 14%) requires editing one file — no code change. The backend reads this file on every scan, so changes take effect immediately without a restart.

### Universe: CSV

The stock universe (`Vicky - Master Template - Master.csv`) is a CSV file with columns for Symbol, Sector, Pool Code, Pool Name, and Cap Type. This was chosen deliberately — it is the simplest possible format that a trader can maintain in a spreadsheet and export. No database is needed for the universe.

---

## 3. Stock Universe & Pool System

### The Problem It Solves
Scanning 5,000 NSE-listed stocks every day is impractical. The universe is deliberately narrowed to ~300 high-quality stocks pre-curated into pools. Strategies are then assigned to specific pools — not to all stocks.

### Three Pools

**F40 (Flagship 40):** Approximately 40 large-cap, high-quality stocks. These are businesses with strong fundamentals that are well-understood. The Envelope and 52 Week High Low strategies run on this pool.

**E40 (Emerging 40):** Mid-cap stocks with growth potential but more volatility than F40. The 52 Week High Low strategy runs here.

**S200 (Smartpick 200):** ~200 stocks screened quantitatively. The 20% Rally strategy runs on this pool.

**PlayArea:** Not a fixed pool — it accepts any comma-separated symbols typed at runtime. Useful for checking specific stocks outside the pre-defined universe. When a PlayArea symbol exists in the master CSV, it inherits its sector and cap type metadata.

### How Pools Are Loaded
The `universe.py` module reads the CSV file, parses each row, and groups stocks by their `pool_code` column. The `get_pool_stocks(pool_code)` function returns all stocks for a given pool. For PlayArea, `get_pool_stocks("ALL")` returns the full universe so that custom symbols can be enriched with their real metadata if they exist.

### Why CSV Not a Database
For a personal tool, maintaining a CSV in a spreadsheet is far simpler than running SQL queries to add or remove stocks. The universe changes infrequently. A CSV file can be opened in Excel, modified, and saved — no database client needed.

---

## 4. Price Data Pipeline

### The Primary Source: Yahoo Finance v8 API

The v8 API returns OHLCV data (Open, High, Low, Close, Volume) plus an AdjClose (dividend-adjusted close) column and a `meta` section with pre-computed fields like `regularMarketPrice`, `fiftyTwoWeekHigh`, and `fiftyTwoWeekLow`.

The call is made directly with Python's built-in `urllib` library — no external dependencies. A `User-Agent` header is set to mimic a browser because Yahoo Finance rejects requests without one.

**Why use the v8 API directly instead of yfinance?**
The yfinance library wraps the same API but adds overhead and has historically had breaking changes. Direct API calls give precise control over what is requested. yfinance is still included as a fallback — if the direct call fails, the code automatically tries yfinance before giving up.

### Two Separate Fetch Operations

**1-year daily fetch** (for metrics):
- Used for 200 DMA calculation, current price, 52W high/low fallbacks
- Cached per symbol with a 1-hour TTL (in-memory dictionary)
- Retrieved once at scan time for the whole pool

**5-year daily fetch** (for ATH):
- Used exclusively to compute the All-Time High
- Stored in a separate `_ath_cache` dictionary
- ATH changes rarely, so a separate cache makes sense

### Why Not Fetch All-Time Data with `range=max`?
Yahoo Finance has a hidden behaviour: when you request `range=max&interval=1d`, it silently returns **monthly** candles for long price histories. A monthly candle's High covers the entire month's intraday range — this produces an inflated ATH. For example, TCS showed 4592 with monthly candles vs 4254 with daily candles. The 5-year daily fetch is the longest period that reliably returns true daily candles.

### Caching and Rate Limiting
Between every 5 fetches, the code sleeps 0.3 seconds to avoid Yahoo Finance's rate limits. A pool of 200 stocks fetches ~200 price records + 200 ATH records. The ATH records from a previous scan are reused if they are already cached — so only the first scan of a pool is slow.

### Sample Data Fallback
If live data is completely unavailable (e.g. no internet), a `load_sample_data()` function generates realistic synthetic prices using numpy random walk. This is used for testing and development. In production, the backend automatically falls back to sample data only if zero live stocks respond.

---

## 5. Technical Metrics Engine

The metrics engine takes a raw OHLCV DataFrame and computes all derived numbers needed by the strategies. Every computation decision here was made to match the values shown on TradingView and Screener.in — because those are what the trader sees on their charts.

### Current Close
Source: `regularMarketPrice` from Yahoo meta fields. This is the live unadjusted closing price — what you see on NSE. The raw Close column in the DataFrame can have an off-by-one issue on intraday days, so the meta field is preferred.

### 200 DMA (200-Day Moving Average)
Computed as `rolling(200).mean()` on the **AdjClose** column, not the raw Close column.

**Why AdjClose for DMA:** When a company pays a dividend, Yahoo Finance retroactively adjusts all historical adjusted closes downward by the dividend amount. This means the AdjClose series is a smooth, comparable series across time. The raw Close series is NOT retroactively adjusted — historical raw Close values are left as they were, which makes the raw series artificially higher in pre-dividend periods. A 200 DMA computed on raw Close is inflated compared to what TradingView shows. Switching to AdjClose makes the DMA match TradingView within ~0.5%.

### 52-Week High and Low
Source: Yahoo meta `fiftyTwoWeekHigh` and `fiftyTwoWeekLow` fields.

**Why use meta fields instead of computing from the DataFrame:** Yahoo's pre-computed 52W high/low matches exactly what screener.in and TradingView display. Computing `max(High)` over the last 252 rows of the DataFrame picks up intraday extremes that screener.in does not count. Using the meta field eliminates this discrepancy. The DataFrame computation is used as a fallback only when the meta field is missing.

### All-Time High (ATH)
Formula: `max(High × AdjClose / Close)` over the 5-year daily dataset.

**Why this specific formula:**
- We want the highest intraday price ever reached, adjusted for dividends and splits.
- Yahoo does not provide an "AdjHigh" column directly.
- The adjustment factor per row is `AdjClose / Close` — this is the same proportional factor Yahoo applies to the Close column to get AdjClose.
- Applying this factor to the raw High gives the dividend-adjusted intraday High.
- `max()` of this series is the true ATH.

**The JPOLYINVST example:** The ATH day's Close was 1415.60 (what the previous version returned), but the ATH day's High was 1487.70 (what TradingView shows). The gap was 72 points. This is why `max(AdjClose)` understated the ATH — it captured the closing price, not the intraday peak.

### 20% Rally Metrics
This is the most complex metric. The `compute_rally_metrics()` function is a direct Python translation of a Pine Script indicator.

**Algorithm:**
1. Mark each candle as green (`close > open`) or not.
2. Walk through all candles sequentially, tracking active green streaks.
3. When a non-green candle appears, close the active streak. Record the streak's lowest Low and highest High.
4. Compute rally percentage: `((highest_high - lowest_low) / lowest_low) × 100`.
5. If rally percentage ≥ threshold (default 20%) AND the streak ended within the last 189 trading days, record it as a valid rally.
6. Ongoing streaks at the last bar are intentionally excluded — the Pine Script fires a label only when the streak breaks, not while it is still running.
7. Return the most recent valid rally's details.

**Why 189 days:** 189 trading days ≈ 9 months. The original Pine Script used 6 months (126 days), but the user extended it to 9 months to catch more qualifying setups.

**Output fields:** `has_valid_20pct_rally`, `last_rally_pct`, `last_rally_low`, `last_rally_high`, `last_rally_start_date`, `last_rally_end_date`, `days_since_last_rally`, `total_valid_rallies_in_window`.

---

## 6. Strategy System

### Design Pattern: Abstract Base Class + Registry

Every strategy inherits from `BaseStrategy`, which is a Python abstract base class (ABC). The ABC enforces that every strategy must implement:
- `strategy_id` — a unique string identifier (e.g. `"envelope_200dma"`)
- `strategy_name` — a human-readable name
- `evaluate(metrics, config)` — the evaluation function

**Why this pattern:** New strategies can be added without touching any existing code. The scanner does not know or care what the strategy does internally — it just calls `evaluate()` and receives a standardized result dict. This is the Open/Closed Principle (open for extension, closed for modification).

### Strategy Registry
A dictionary in `registry.py` maps strategy IDs to singleton instances:
```
"envelope_200dma" → EnvelopeStrategy()
"week52_high_low" → Week52HighLowStrategy()
"rally_20_percent" → Rally20PercentStrategy()
```

The `get_strategy(id)` function raises a clear error if an unknown ID is requested.

### Evaluate Function Contract
Every `evaluate()` call returns a dict with:
- `status` — the signal status (e.g. `BUY_ZONE`, `OPPORTUNITY`, `NO_SIGNAL`, `VALID`, `INVALID`)
- `score` — a numeric score (0-100) for ranking
- `reasons` — list of human-readable strings explaining why the signal triggered
- `strategy_id` and `strategy_name`
- Any extra strategy-specific fields

### Envelope Strategy (200 DMA)
The simplest strategy. Takes `below_200dma_pct` from the metrics dict and compares it to two thresholds loaded from `strategy_rules.json`:
- `buy_zone_below_dma_pct` (default: 14%) → `BUY_ZONE`, score 100
- `opportunity_below_dma_pct` (default: 9%) → `OPPORTUNITY`, score 70
- Below threshold → `NO_SIGNAL`, score 0

The logic is: a large-cap stock 14%+ below its 200 DMA is statistically oversold and historically recovers. This is the primary entry signal for F40 stocks.

### 52 Week High Low Strategy
Takes `distance_from_52w_low_pct` from the metrics dict:
- ≤ 0.5% above 52W low → `BUY_ZONE`, score 100
- ≤ 5% above 52W low → `OPPORTUNITY`, score 75
- > 5% → `NO_SIGNAL`, score 0

The logic is: a stock near its 52-week low has significant downside already priced in. The 0.5% tolerance for BUY_ZONE exists because exact equality to the 52W low is rare in live market data.

### 20% Rally Strategy
Takes `has_valid_20pct_rally` (computed by the metrics engine) and returns:
- `True` → `VALID`, score 100
- `False` → `INVALID`, score 0

Also passes through `last_rally_low` (labelled `next_buy_at`) and `last_rally_high` (labelled `next_sell_at`) — the price levels the trader watches for the next re-entry after the rally.

### Pool Assignment
Each strategy's `strategy_rules.json` config has an `applies_to_pools` list. The scanner reads this list and only runs a strategy on stocks that belong to a matching pool. A strategy never runs on the wrong pool.

---

## 7. Scanner Orchestrator

The scanner (`scanner.py`) is the central coordinator. It runs once per scan request and follows this pipeline:

**Step 1 — Load pool stocks:** Read the master CSV and extract all stocks for the requested pool. For PlayArea, parse the comma-separated custom symbols and enrich them with master CSV metadata.

**Step 2 — Load strategy config:** Read `strategy_rules.json` and identify which strategies are enabled and applicable to this pool.

**Step 3 — Fetch price data:** Call `fetch_multiple_stocks()` for all symbols. Cache hits are returned instantly; uncached symbols are fetched with rate limiting.

**Step 4 — Fetch ATH data:** Call `get_ath_for_symbols()` for all symbols. This is a separate 5-year daily fetch per symbol, also cached independently.

**Step 5 — Compute metrics:** For each symbol with available data, call `compute_metrics()`. Pass the ATH override, Yahoo meta fields (for accurate 52W high/low), and rally configuration.

**Step 6 — Apply strategies:** For each symbol, loop through all applicable strategies and call `evaluate()`. Track the best score and status across all strategies applied to that stock.

**Step 7 — Sort and package:** Sort results — S200/PlayArea sorts by `days_since_last_rally` ascending (freshest rally first); all other pools sort by `best_score` descending.

**Step 8 — Cache per pool:** Store the complete result in `_scan_cache[pool_code]`. Subsequent requests for the same pool (e.g. switching tabs) are served from this cache instantly without a re-scan.

### Per-Pool Scan Cache
The scan cache is a dictionary in `scanner.py` at module level. It persists for the lifetime of the backend process. Each pool's entry is overwritten only when a new scan is explicitly triggered. This is what makes tab switching instant — no re-scan is needed.

---

## 8. Fundamental Screener

The screener is a separate system from the scanner. While the scanner evaluates technical signals (price vs DMA, price vs 52W low, rally patterns), the screener evaluates fundamental quality (is the business financially strong right now?).

### Data Source: Screener.in
Screener.in was chosen because it aggregates SEBI-filed quarterly results, computes standard ratios, and presents them in a consistent format. The data is the same data that the trader uses manually when evaluating stocks.

### Two Tiers of Data Access

**Tier 1 — Public (no login):**
The company ID is resolved via Screener.in's public search API. The PE and PB time series (up to 10 years, daily) are available via the public chart API without any authentication. These are used to compute current PE/PB and N-year historical averages.

**Tier 2 — Authenticated:**
Full quarterly financial tables, ROCE, ROE, promoter holding, pledging %, and Net Debt to Equity require a logged-in session. Credentials (`SCREENER_EMAIL`, `SCREENER_PASSWORD`) are read from environment variables.

### Login Flow
1. GET the login page → extract the Django CSRF token from the HTML form
2. POST username + password + CSRF token → receive `sessionid` cookie
3. Store the `CookieJar` in memory and on disk (`screener_session.pkl`)
4. All subsequent company page fetches include this cookie
5. On 429 (rate limit) → back off 65 seconds and retry once
6. On session expiry → automatic re-login triggered by the next fetch

The session file is checked before attempting a fresh login. If the stored session is less than 23 hours old and still valid (confirmed by a quick probe request), it is reused. This avoids triggering Screener.in's rate limits on backend restarts.

### HTML Parsing Approach
The company page is full HTML. Python's `re` (regex) module is used to extract data — no HTML parsing library like BeautifulSoup is used. This was intentional: `re` has no extra dependencies and the HTML structure of Screener.in is consistent enough to parse with targeted regex patterns.

**Key HTML parsing discoveries made during development:**

- **Quick-ratios are not in the initial page HTML.** Fields like "5Yrs PE", "5Yrs PBV", "Pledged %", and "Net Debt to Equity" are loaded by a separate Ajax call to `/api/company/{warehouseId}/quick_ratios/`. The `warehouseId` is different from the company ID and is embedded in the page HTML as a data attribute. The code replicates this Ajax call to get these fields.

- **Promoter pledging is NOT in the shareholding table.** The `#shareholding` section does not contain the pledging number. It appears only in the `#analysis` section's cons bullet list (e.g. "Promoters have pledged 89.4% of their holding.") and in the `<meta name="description">` tag. All parsing strategies that looked in the shareholding table were wrong.

- **Current PB = Current Price ÷ Book Value.** Screener.in does not list Price-to-Book as a single ratio. It lists "Current Price" and "Book Value" separately in `#top-ratios`. Current PB is computed by dividing these two values.

- **Numbers are inside `<span class="number">`** tags. Every ratio's value follows this pattern consistently.

### Screener Engine — SOLID Design

The screener engine follows SOLID principles:

**Rule config schema:** Every filter criterion is described by a config dict with an ID, category, label, description, default parameters, and an evaluator function name. This schema is what the React UI reads to auto-generate the filter panel — no hardcoded UI logic per rule.

**Evaluator registry:** A dictionary maps evaluator names (strings) to actual Python functions. The orchestrator looks up the function by name and calls it. Adding a new filter means: write a function, add it to the registry, add a config dict to the rules list. Nothing else changes.

**Pure functions:** Each evaluator receives `(fundamental_data, rule, params)` and returns `{passed, reason, ...}`. No side effects. Business logic is completely decoupled from the web layer and from the UI.

### Evaluator Logic

**ATH filters (Sales, PBT, Net Profit):** Latest quarterly value must be ≥ historical quarterly ATH × (1 − tolerance%). Tolerance defaults to 2%, meaning the latest quarter can be up to 2% below the all-time quarterly peak and still pass. Quarterly values are compared only to other quarterly values — annual totals are never mixed in.

**PE below average:** Current TTM PE must be less than the N-year average PE. Both values must come from the same source (the screener.in page) — mixing the chart API's PE with the page's 5yr average produces wrong results because the two use different EPS calculation methodologies.

**PB below average:** Same source consistency requirement as PE. Current PB (computed as Price / Book Value from the page) vs N-year average PB (from the `5Yrs PBV` quick-ratio field).

**ROCE / ROE:** Current value from the `#top-ratios` section, compared against a user-set minimum threshold. Default threshold is 18% for both.

**Net Debt to Equity:** From the quick-ratios Ajax API. Must be below a maximum threshold. Negative values (net cash company) always pass.

**Pledging:** Promoter pledging percentage must be ≤ maximum threshold (default 5%). If the pledging value is `None` (data could not be extracted), it is treated as a FAIL — the rule cannot be verified, so it rejects rather than approves.

### Persistent JSON Cache

Every fetched fundamental record is saved to `UserData/screener_cache.json`. This is a JSON file written with atomic semantics: data is written to `.tmp` first, then the `.tmp` file is renamed to replace the real file. On POSIX systems (Linux, macOS), `rename()` is atomic — a crash mid-write cannot corrupt the existing cache.

**No TTL on the persistent cache.** Once a stock's fundamental data is cached, it stays cached indefinitely. The only way to refresh is to explicitly pass `force_refresh=True` in the screener request. This design choice was deliberate: fundamental data changes quarterly, not hourly. There is no value in automatically re-fetching it on every scan.

**Slim format:** The raw daily PE and PB time series (up to 3,650 data points each) are stripped before writing to disk. Only the computed averages (5yr, 3yr, 10yr scalars) and current values are stored. Without this slimming, each symbol would consume 50-100 KB in the cache file.

### SSE Streaming

The screener's `/run-stream` endpoint streams progress in real time. This was necessary because fetching fundamentals for 200+ stocks with a 20-second inter-fetch throttle takes up to an hour. The user needs to see what is happening.

**Architecture challenge:** Python's HTTP fetch calls are blocking (synchronous). FastAPI's async endpoints must not block the event loop. Solution:

1. The fetch work runs in a background thread (`threading.Thread`).
2. The thread pushes events into a `queue.Queue` as it progresses.
3. FastAPI's async generator pulls events from the queue using `run_in_executor` (which runs the blocking `queue.get()` call in a thread pool without blocking the event loop).
4. Events are formatted as Server-Sent Events (`data: {...}\n\n`) and yielded to the client.

This architecture means the async event loop is never blocked, so other API requests can still be served while a long screener run is in progress.

---

## 9. API Layer

### FastAPI Routing

All routes are defined in `api/routes.py` and mounted under the `/api` prefix in `main.py`. FastAPI automatically validates request parameters using Python type annotations — if a required parameter is missing or the wrong type, FastAPI returns a structured error response without any custom validation code.

### Pydantic Models
The screener endpoints accept a JSON body defined as a Pydantic `BaseModel`:
- `pool` — which pool to screen
- `symbols` — optional custom symbols (PlayArea)
- `rules` — optional user-modified rule configs
- `force_refresh` — whether to bypass the persistent cache

Pydantic validates the JSON body, converts types, and raises clear errors if the shape is wrong.

### Background Login Trigger
On application startup (`main.py`), a background thread is spawned to attempt Screener.in login. This means by the time the first screener request arrives, the session is already established. Without this, the first screener run would include the login latency.

### CORS Configuration
`CORS_ORIGINS = ["*"]` is set in `config.py` for development. This allows the Vite dev server (port 3000) to call the FastAPI backend (port 8000) without cross-origin issues. In a production deployment where frontend and backend are served from the same origin, this setting should be tightened.

### Proxy Setup (Vite)
`vite.config.js` configures a proxy: any request to `/api/*` from the frontend is forwarded to `http://localhost:8000`. This means the frontend code calls `/api/scan` (not `http://localhost:8000/api/scan`) and works identically in development and production.

---

## 10. Frontend Dashboard

### Page Structure
Three pages, each a React component:

**HomePage:** Landing page. Shows pool cards with last-scan status and signal counts. Contains the Fundamental Pointers quick-reference (position sizing rules, must-have criteria, watch-outs). Shows the Strategy × Pool matrix. Links to the Trading Journal.

**ScannerPage:** The main workspace. Pool tabs across the top. Per-pool scan results below. Filter panel on the side. Expandable rows for strategy details.

**ScreenerPage:** Fundamental screening workspace. Rule configuration panel on the left. Progress panel during screener run. Results table on the right.

### Routing
React Router handles navigation between pages. The URL changes (`/`, `/scanner`, `/screener`) and the browser's back button works. No full page reload — React manages the transition.

### State Management
- **Theme (dark/light):** React Context + localStorage. Persisted across sessions.
- **Scan results per pool:** Stored in component state in ScannerPage. Persists for the lifetime of the browser session — switching between Home and Scanner does not lose results.
- **Screener rule configuration:** Stored in localStorage so user preferences survive page refreshes.
- **Screener auth status:** Fetched from `/api/screener/auth-status` on Screener page mount, displayed as a badge in the header.

### Key Components

**Header.jsx:** Sticky header with navigation links, theme toggle, and screener auth status badge. Stays visible while scrolling.

**PoolCards.jsx:** Grid of cards on the Home page. Each card shows the pool name, last scan time, and signal counts (BUY/OPP/RALLY). Click to jump to the scanner for that pool.

**ResultsTable.jsx:** The central component of the Scanner page. Sortable by any column — click a column header to sort ascending, click again for descending. Expandable rows — click a row to see strategy-level detail (which strategies fired, what their individual scores and reasons are).

**ScanSummary.jsx:** Row of metric cards below the scan button: Total Scanned, Data Available, Buy Zone, Opportunity, No Signal, Errors, 20% Rally count.

**ScanControls.jsx:** Pool tab selector + PlayArea text input + Scan button.

**StrategyMatrix.jsx:** Visual grid showing which of the 11 strategies applies to which of the 4 pools, read from the Master CSV data.

### Filters (Scanner Page)
All filters are applied client-side — the backend sends all results, the frontend filters what is displayed. This means filter changes are instant with no API call.

Filters available:
- Signal type (All / Has Signal / Buy Zone / Opportunity / 20% Rally ✓ / No Signal)
- Cap type (Large / Mid / Small)
- Sector (dynamic dropdown from scan data)
- % Below DMA (min/max slider-style inputs)
- % From Low (min/max)
- % Down from ATH (min/max)

### Screener Configuration Panel
The configuration panel is entirely data-driven — it reads the rule config schema from `/api/screener/rules` and auto-generates the UI. Each rule gets:
- An enable/disable checkbox
- Editable input fields for each parameter (tolerance %, lookback years, threshold values)
- A help tooltip with the rule description

This means adding a new screener rule requires no frontend changes — just add the rule config to the backend, and the UI renders it automatically.

### SSE Progress Panel
During a screener run, a live progress panel appears showing:
- How many symbols are served from cache vs fetched from the internet
- Estimated total time (fetches × throttle delay)
- Per-symbol status as it updates in real time
- A countdown timer during the 20-second pause between internet fetches

This is implemented using the browser's `fetch()` API with a `ReadableStream` reader, consuming the SSE stream line by line.

### Copyable Symbol List
After a screener run, all stocks that passed all rules are shown with a "Copy Symbols" button. Clicking it copies a comma-separated list of NSE symbols to the clipboard. This is designed for the trader's workflow: copy the passed symbols, paste them into a watchlist or a scanner on another platform.

### Theme System
Dark mode is the default. A sun/moon toggle in the header switches themes. The chosen theme is stored in `localStorage` so it persists between sessions. CSS variables defined in `main.jsx` control all colors — switching theme = changing one class on the root element.

**Color palette:**
- Dark: background `#0D1117`, accent `#58A6FF` (blue), success `#3FB950` (green), danger `#F85149` (red)
- Light: background `#F5F6F8`, accent `#4A7FDB`, success `#2DA44E`

---

## 11. Configuration System

### strategy_rules.json Structure

```
version
name
description
market          → "NSE"
timeframe       → "1d"
data_requirements → minimum history lengths
stock_pools     → pool code → name, source column, category
global_metric_definitions → how each metric is computed (documentation)
status_enums    → allowed status values per strategy type
strategies[]    → array of strategy configs
  id
  name
  enabled
  type          → "technical" or "technical_pattern"
  applies_to_pools[]
  priority
  inputs        → thresholds (e.g. buy_zone_below_dma_pct: 14.0)
  rules         → metric comparisons with operator and threshold
  status_logic  → when each status triggers
  score_map     → status → score value
  output_fields → which fields this strategy produces
implementation_notes
```

### How Thresholds Are Read
The scanner calls `load_strategy_rules()` (reads and parses the JSON) on every scan. The result is passed to each strategy's `evaluate()` function as the `config` parameter. Each strategy reads its thresholds from `config["inputs"]`. If a threshold is missing from the JSON, each strategy has hardcoded defaults as fallback.

### Adding a New Strategy Configuration
1. Add a new object to the `strategies[]` array.
2. Set `enabled: true`, specify `applies_to_pools`.
3. Define `inputs` with all thresholds.
4. Set `score_map` for each status.
5. No code change needed — the scanner reads this automatically.

The code change is only needed to implement the strategy logic itself (the Python class).

---

## 12. Caching Architecture

Buddy has four independent caching layers:

### 1. Price Data Cache (in-memory)
- Dictionary: `symbol → {data: DataFrame, meta: dict, fetched_at: datetime}`
- TTL: 1 hour
- Populated by: `fetch_stock_data()` on each scan
- Cleared by: `POST /api/cache/clear`

### 2. ATH Cache (in-memory)
- Dictionary: `symbol → float`
- No TTL — ATH changes slowly
- Populated by: `get_ath_for_symbols()` on each scan
- Cleared by: `POST /api/cache/clear`

### 3. Scan Result Cache (in-memory)
- Dictionary: `pool_code → scan_result`
- No TTL — persists until a new scan is triggered for that pool
- Populated by: `run_scan()` at the end of each scan
- Cleared by: triggering a new scan for the pool

### 4. Fundamental Data Cache — Two Levels

**In-memory (`_fundamental_cache`):**
- Dictionary: `symbol → {data: dict, fetched_at: datetime}`
- TTL: 6 hours
- Populated by: `fetch_fundamental_data()` on each screener run
- Cleared by: `POST /api/cache/clear`

**Persistent JSON (`UserData/screener_cache.json`):**
- Survives backend restarts
- No TTL — valid until explicit `force_refresh=True`
- Written atomically: `.tmp` → rename
- Only slim data stored (no raw PE/PB time series)
- Read on first access, held in `_pcache_memory` dict thereafter

**Cache check order for fundamentals:**
1. Check persistent JSON cache → serve instantly if found (unless `force_refresh=True`)
2. Check in-memory cache → serve instantly if found and not expired
3. Fetch from screener.in → update both caches

---

## 13. Data Accuracy Decisions

This section explains every data accuracy decision made during development, and why each specific approach was chosen.

### Decision 1: AdjClose for 200 DMA
**Problem:** TradingView showed DMA ~50 points lower than what the backend computed.
**Root cause:** Raw Close prices are not retroactively adjusted for dividends. A stock that paid ₹10 dividend shows a ₹10 gap between pre- and post-dividend raw Close, which inflates the 200-period average.
**Solution:** Use AdjClose for the rolling average. Yahoo retroactively adjusts the entire AdjClose history when a dividend is paid, making it a smooth, comparable series.

### Decision 2: Yahoo Meta Fields for 52W High/Low
**Problem:** `max(High)` over 252 rows picked up intraday candle extremes that screener.in's 52W high did not include.
**Root cause:** Yahoo's 52W high/low in the meta section is computed on daily closes only, not intraday highs. Their pre-computed values match screener.in exactly.
**Solution:** Use `meta["fiftyTwoWeekHigh"]` and `meta["fiftyTwoWeekLow"]` directly.

### Decision 3: 5-Year Daily for ATH (not `range=max`)
**Problem:** ATH values were inflated by ~300+ points for some stocks.
**Root cause:** Yahoo's `range=max` silently returns monthly candles for stocks with long histories. A monthly candle's High covers the entire month's intraday range — this is not the true daily ATH.
**Solution:** Request 5 years with `interval=1d` — the longest period that reliably returns daily candles.

### Decision 4: Adjusted High for ATH (not AdjClose max)
**Problem:** ATH day's Close (1415) ≠ ATH day's High (1487) for JPOLYINVST — a 72-point understatement.
**Root cause:** `max(AdjClose)` captures the highest closing price, not the highest intraday price. Stocks can trade significantly higher intraday before closing lower.
**Solution:** Compute `adjusted_high = High × (AdjClose / Close)` per row. This derives a dividend-adjusted intraday High series. ATH = max of this series.

### Decision 5: TTM-Consistent PE/PB Source
**Problem:** PE PASS/FAIL was wrong when mixing chart API PE with screener page PE average.
**Root cause:** The chart API computes PE as `closing price / adjusted EPS`. The screener.in page shows TTM (Trailing Twelve Month) PE which uses a different EPS calculation. The 5yr average from the quick-ratio also uses TTM PE. Comparing chart API current PE to TTM 5yr average is apples vs oranges.
**Solution:** Both current PE and the N-year average must come from the same source. The screener.in page takes absolute priority. Chart API is fallback only if the page fails.

### Decision 6: Pledging Source
**Problem:** Pledging always returned None even for authenticated fetches.
**Root cause:** The `#shareholding` section does not contain the pledging percentage. It only appears in the `#analysis` section's bullet list and in the `<meta name="description">` tag.
**Solution:** Search both locations — `#analysis` cons bullets first, then the meta description.

---

## 14. Security & Authentication

### Screener Credentials
Credentials are stored in a `.env` file that is git-ignored. They are never hardcoded. The `.env.example` file shows the expected variable names without actual values.

The credentials are read from environment variables at runtime using `os.environ.get()`. If the variables are not set, the screener operates in public-only mode without raising an error.

### Session Cookie Storage
The Screener.in session cookie is stored as a Python pickle file (`screener_session.pkl`) in the backend directory. This file is git-ignored. It contains only the HTTP cookie — no credentials.

### CORS
Set to `["*"]` (allow all origins) for development. This is intentional and noted in the config file. For a personal tool running locally, this is acceptable. If deployed publicly, `CORS_ORIGINS` should be set to the specific frontend origin.

### No Authentication on the API
The FastAPI backend has no authentication layer. It accepts all requests on port 8000. Since this is a personal local tool, adding authentication was deliberately deferred. The backend should not be exposed to the public internet in its current state.

### Rate Limit Handling
Two platforms have rate limits:
- **Yahoo Finance:** Sleep 0.3 seconds every 5 fetches to avoid 429 errors.
- **Screener.in:** 20-second inter-fetch throttle between authenticated page fetches. On 429 error during login, wait 65 seconds and retry once. Persistent session avoids repeated logins that trigger rate limits.
