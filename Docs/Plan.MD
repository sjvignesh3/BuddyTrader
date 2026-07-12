# Swing Trading Scanner MVP Plan

## Goal
Build a personal-use NSE end-of-day stock scanner dashboard to save time by scanning a fixed universe of ~400 stocks and surfacing ranked opportunities based on configurable strategies and filters.

## Product Scope
- Personal use only
- Scanner dashboard only
- NSE equities only
- Daily candles only
- End-of-day data is sufficient
- Up to 1-day delayed data acceptable
- Manual/triggered scan execution
- Ranked opportunities output
- No alerts in v1
- No chart snapshots in v1
- No backtesting in v1

## Core Requirements
1. Configurable ratios and thresholds
2. Enable/disable filters without code changes
3. Apply specific strategies to specific stock pools
4. Support multiple stock pools (e.g. qualitative, quantitative)
5. Score-based ranking instead of strict pass/fail only
6. Dashboard for easy scanning and review
7. Scalable foundation for adding more strategies later

## Initial Strategies
1. Envelope
2. 52Week HighLow
3. 20% Rally

Note: strategy definitions still need to be converted into exact machine-readable rules before implementation.

## Initial Must-Have Filters
- Market cap > configurable threshold
- Below 200 DMA
- Fall from ATH > configurable threshold
- Debt/Equity < 0.25
- ROCE > 15
- ROE > 15

## Nice-to-Have Later
- All-time-high sales
- All-time-high revenue
- All-time-high profit
- Alerts
- Backtesting
- More technical indicators
- More advanced chart-pattern logic

## Stock Pool Flexibility
Need support for separate rule application by pool.

Examples:
- Qualitative stocks:
  - Envelope
  - 52Week HighLow
- Quantitative stocks:
  - 20% Rally
  - Optional fundamental filters if enabled

Each stock should be taggable into one or more pools.

## Recommended Tech Stack
### Backend
- Python
- FastAPI

### Frontend
- React

### Storage
- SQLite for MVP

### Config
- JSON or database-backed strategy/filter config

## Why Python + React
- Python is strong for data processing, technical calculations, and strategy evaluation
- React gives flexibility for a scalable dashboard UI
- This combination is suitable for later expansion without rework

## High-Level Architecture
1. Data ingestion layer
   - Load stock universe
   - Fetch/update technical data
   - Import or fetch fundamental data

2. Metrics engine
   - Calculate 200 DMA
   - Calculate ATH and fall from ATH %
   - Calculate 52W high/low distances
   - Normalize metrics for scanner use

3. Strategy engine
   - Read strategy config
   - Read enabled/disabled filters
   - Apply strategies by pool
   - Compute score and reasons

4. Persistence layer
   - Store stocks
   - Store pool mappings
   - Store scan results
   - Store configuration

5. Dashboard
   - Trigger scan
   - View ranked results
   - Filter by strategy/pool
   - Manage thresholds and toggles

## Proposed MVP Features
### Dashboard
- Run scan button
- Last scan timestamp
- Total scanned stocks
- Opportunities count
- Ranked opportunities table

### Results Table
Columns:
- Symbol
- Name
- Pool
- Strategy
- Score
- Close
- 200 DMA
- % below 200 DMA
- ATH
- % from ATH
- Market cap
- Debt/Equity
- ROCE
- ROE
- Reasons matched

### Config Management
- Enable/disable strategies
- Enable/disable filters
- Edit thresholds
- Edit weights
- Assign strategies to pools

### Stock Pool Management
- Maintain stock list
- Assign stock to qualitative/quantitative pools

## Suggested Data Model
### Stock
- symbol
- name
- exchange
- active

### Pool
- id
- name

### StockPoolMap
- stock_id
- pool_id

### MetricSnapshot
- stock_id
- date
- close
- dma_200
- below_200dma_pct
- ath
- fall_from_ath_pct
- high_52w
- low_52w
- distance_from_52w_high_pct
- distance_from_52w_low_pct
- market_cap
- debt_to_equity
- roce
- roe

### Strategy
- id
- name
- enabled
- applies_to_pools

### StrategyFilter
- strategy_id
- metric_key
- enabled
- operator
- threshold_value
- weight

### ScanResult
- scan_id
- stock_id
- strategy_id
- score
- normalized_score
- reasons
- created_at

## Suggested Project Structure
```text
Buddy/
  backend/
    app/
      api/
      core/
      models/
      schemas/
      services/
      strategies/
      main.py
    data/
      universe.csv
      fundamentals.csv
      config.json
    requirements.txt
  frontend/
    src/
      components/
      pages/
      services/
      App.jsx
      main.jsx
    package.json
  docs/
    Plan.MD
```

## Data Strategy for MVP
### Technical Data
Automate from day 1:
- Daily close
- 200 DMA
- ATH
- 52W high/low
- distance-based metrics

### Fundamental Data
Start with practical import support:
- universe CSV
- fundamentals CSV

Reason:
- reduces dependency on unstable free sources in MVP
- keeps project implementable quickly
- allows later automation

## Scoring Model
Each enabled filter contributes weight on pass.

Example:
- Below 200 DMA by threshold -> 30
- Market cap threshold -> 10
- Debt/Equity threshold -> 10
- ROCE threshold -> 10
- ROE threshold -> 10
- Fall from ATH threshold -> 20

Formula:
- raw score = sum of passed weights
- normalized score = raw score / total enabled weights * 100

This supports ranking and flexible rule bending.

## Implementation Phases
### Phase 1: Rule and Config Design
- Define stock pools
- Define strategy schema
- Define filter schema
- Decide exact strategy rules

### Phase 2: Backend Foundation
- FastAPI setup
- SQLite setup
- basic models and schemas
- config loading

### Phase 3: Data Layer
- Stock universe import
- Fundamentals import
- Technical metrics calculation

### Phase 4: Strategy Engine
- Generic filter evaluator
- Pool-aware strategy application
- Score calculation
- Results persistence

### Phase 5: React Dashboard
- Scan trigger
- Results page
- Config page
- Pool management page

### Phase 6: Strategy Expansion
- Add exact 20% Rally logic from Pine Script
- refine Envelope and 52Week HighLow logic

## Risks and Mitigations
### Risk: Free data-source limitations
Mitigation:
- start with CSV imports where necessary
- automate only what is reliable first

### Risk: Pine Script translation complexity
Mitigation:
- keep each strategy modular
- implement 20% Rally after scanner engine is stable

### Risk: Too much discretionary logic
Mitigation:
- use scanner as shortlist generator
- manually inspect final candidates on charts

## Immediate Next Steps
1. Convert all 3 strategies into exact machine-readable rules
2. Split 400-stock universe into pools
3. Define config schema for strategies, filters, and weights
4. Scaffold Python backend
5. Scaffold React frontend

## Pending Clarifications
Need exact definitions for:
- Envelope strategy rule
- 52Week HighLow rule
- 20% Rally rule
- how fundamentals attach to each strategy
- whether some filters are global or strategy-specific

## Success Criteria for MVP
The MVP is successful if it can:
- scan the 400-stock NSE universe on demand
- apply configurable strategy/filter logic
- respect stock pool assignments
- produce a ranked opportunity list
- show clear reasons for each result in a dashboard
