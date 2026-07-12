# Buddy Scanner - Development Document

## Project Overview
Personal NSE end-of-day swing trading scanner that surfaces ranked opportunities from a configured stock universe using technical strategies.

## Architecture
```
Buddy/
├── backend/               # Python FastAPI backend
│   ├── app/
│   │   ├── api/           # REST endpoints
│   │   │   └── routes.py  # All API routes
│   │   ├── core/          # Config, universe loader
│   │   │   ├── config.py  # App config, paths, strategy rules loader
│   │   │   └── universe.py # CSV parser, pool extractor
│   │   ├── services/      # Business logic
│   │   │   ├── data_fetcher.py  # Yahoo Finance data fetcher with cache
│   │   │   ├── metrics_engine.py # Technical metrics calculator
│   │   │   └── scanner.py       # Main scan orchestrator
│   │   ├── strategies/    # Strategy implementations (pluggable)
│   │   │   ├── base.py         # Abstract base strategy
│   │   │   ├── envelope.py     # Envelope (200 DMA) strategy
│   │   │   ├── week52_high_low.py # 52 Week High Low strategy
│   │   │   └── registry.py     # Strategy registry (add new strategies here)
│   │   └── main.py        # FastAPI app entry point
│   ├── data/              # Local data storage (future: SQLite)
│   └── requirements.txt
├── frontend/              # React Vite dashboard
│   ├── src/
│   │   ├── components/    # UI components
│   │   │   ├── Header.jsx
│   │   │   ├── ScanControls.jsx
│   │   │   ├── ScanSummary.jsx
│   │   │   └── ResultsTable.jsx
│   │   ├── services/
│   │   │   └── api.js     # Backend API client
│   │   ├── App.jsx        # Main app component
│   │   └── main.jsx       # Entry point
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
├── UserData/              # User's stock universe & strategy config
│   ├── Vicky - Master Template - Master.csv
│   └── strategy_rules.json
└── Docs/
    ├── Plan.MD
    └── DevDoc.MD          # This file
```

## Tech Stack
| Layer     | Technology           | Purpose                        |
|-----------|---------------------|--------------------------------|
| Backend   | Python 3.8 + FastAPI | API server, strategy engine    |
| Frontend  | React 18 + Vite     | Dashboard UI                   |
| Data      | Yahoo Finance (yfinance) | Live OHLCV price data     |
| Config    | JSON                | Strategy rules, thresholds     |
| Universe  | CSV                 | Stock pools (F40, E40, S200)   |

## API Endpoints
| Method | Endpoint                     | Description                        |
|--------|-----------------------------|------------------------------------|
| GET    | /                           | App info + available endpoints     |
| GET    | /api/health                 | Health check                       |
| POST   | /api/scan?pool=F40          | Trigger a new scan                 |
| GET    | /api/scan/last              | Get last scan results              |
| GET    | /api/pools                  | List all stock pools               |
| GET    | /api/pools/{code}/stocks    | List stocks in a pool              |
| GET    | /api/strategies             | Get strategy configurations        |
| POST   | /api/cache/clear            | Clear price data cache             |

## Strategies Implemented

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

## How to Add a New Strategy
1. Create `backend/app/strategies/your_strategy.py`
2. Extend `BaseStrategy` abstract class
3. Implement `strategy_id`, `strategy_name`, and `evaluate()` method
4. Register in `backend/app/strategies/registry.py`
5. Add strategy config to `UserData/strategy_rules.json`

---

## Development Milestones

### ✅ Milestone 1: Foundation (Current)
**Status: COMPLETED**
**Date: Session 1**

- [x] Project structure created (backend + frontend)
- [x] Strategy rules JSON finalized (strategy_rules.json)
- [x] CSV universe parser (extracts F40, E40, S200 pools)
- [x] FastAPI backend scaffold with CORS
- [x] Yahoo Finance data fetcher with in-memory cache
- [x] Metrics engine (200 DMA, 52W high/low, percentages)
- [x] Envelope strategy implementation
- [x] 52 Week High Low strategy implementation
- [x] Strategy registry (pluggable pattern)
- [x] Scanner orchestrator (fetch → compute → evaluate → rank)
- [x] REST API endpoints (scan, pools, strategies, cache)
- [x] React dashboard with Vite
- [x] Scan controls (pool selector, run scan button)
- [x] Summary cards (BUY_ZONE, OPPORTUNITY counts)
- [x] Results table (sortable, expandable rows with strategy details)
- [x] DevDoc.MD created

### 🔲 Milestone 2: Validation & Refinement
**Status: PENDING**

- [ ] Validate scan results against manual chart checks
- [ ] Handle edge cases (delisted stocks, ticker mismatches)
- [ ] Add loading state improvements
- [ ] Error boundary in React
- [ ] Persisted scan history (SQLite)
- [ ] Timestamp-aware cache (respect market hours)

### 🔲 Milestone 3: E40 + Filters
**Status: PENDING**

- [ ] Enable E40 pool scanning
- [ ] Add fundamental filters (Market Cap, D/E, ROCE, ROE)
- [ ] Import fundamentals from CSV
- [ ] Filter toggle UI in dashboard
- [ ] Threshold configuration UI

### 🔲 Milestone 4: 20% Rally Strategy
**Status: PENDING**

- [ ] Translate Pine Script to Python
- [ ] Implement green streak detection
- [ ] Rally validation logic (20% threshold, 6-month window)
- [ ] Apply to S200 pool
- [ ] Dashboard support for pattern-type strategies

### 🔲 Milestone 5: Advanced Dashboard
**Status: PENDING**

- [ ] Config management page (strategy enable/disable)
- [ ] Pool management page
- [ ] Historical scan comparison
- [ ] Export to CSV/Excel
- [ ] Dark mode toggle

### 🔲 Milestone 6: Production Hardening
**Status: PENDING**

- [ ] SQLite persistence layer
- [ ] Proper error handling throughout
- [ ] Rate limiting for Yahoo Finance
- [ ] Logging improvements
- [ ] Docker containerization
- [ ] Automated daily scan (cron)

---

## Key Design Decisions
1. **In-memory cache first, SQLite later** — keeps MVP simple while allowing fast iteration
2. **Strategy registry pattern** — new strategies added without touching scanner core
3. **Config-driven thresholds** — all values in strategy_rules.json, no hardcoding
4. **Pool-aware scanning** — strategies only run on their designated pools
5. **Score-based ranking** — best score across all applicable strategies determines rank
6. **Yahoo Finance for MVP** — accepts 1-day delay, avoids paid API dependency

## Running the Application

### Backend
```bash
cd /home/workspace/Buddy/backend
python3 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend
```bash
cd /home/workspace/Buddy/frontend
npm install
npm run dev
```

### Quick Test (API only)
```bash
# Health check
curl http://localhost:8000/api/health

# Run F40 scan
curl -X POST "http://localhost:8000/api/scan?pool=F40"

# Get pools
curl http://localhost:8000/api/pools
```
