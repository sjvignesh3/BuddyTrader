# Plutus Companion — browser extension

Overlays Plutus data on TradingView and Screener.in so the daily analysis loop
(chart → fundamentals → note → journal) never leaves the page you are on.

```
extension/
├── manifest.json            MV3; content scripts for TradingView + Screener, token bridge for the web app
├── background.js            service worker: the ONLY code that calls the Plutus API; caches; local watchlists
├── shared/
│   ├── symbols.js           TCS.NS ↔ TCS ↔ NSE:TCS ↔ /company/TCS/ (one converter, unit-tested on the server side too)
│   ├── settings.js          one settings blob in chrome.storage.local with defaults
│   └── ui.js                toast / dialog / DOM helpers + the message bridge
├── tv/                      TradingView panel (tv_content.js + tv.css)
├── screener/                Screener.in overlays (screener_content.js + screener.css)
├── popup/                   settings popup
├── webapp/token_bridge.js   copies the web app's session token into the extension (localhost:5173)
├── vendor/chart.min.js      Chart.js 4.5.1 (MIT)
└── icons/
```

## Install (unpacked, personal use)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this `extension/` folder.
2. Click the toolbar icon → set **Plutus API URL** (local `http://127.0.0.1:8787`, or the Render URL) → **Test connection**.
3. Sign in on the Plutus web app once. On `localhost:5173` the token is picked up automatically; for a
   deployed web app copy `localStorage["plutus.auth.v1"]` from its DevTools and paste it into **Session token**.
   Everything read-only works without a token; notes, held badges, PlayArea and synced watchlists need it.
4. Reload any open TradingView / Screener tabs (the worker also injects into already-open tabs on install).

## Backend requirements

| Piece | Where |
|---|---|
| Read bundles | `GET /api/extension/bootstrap`, `GET /api/extension/stock/{symbol}`, `GET /api/strategy_configs` (`plutus/api/extension.py`) |
| Custom watchlists | migration `020_watchlists.sql` + `/api/watchlists` (`plutus/api/watchlists.py`, gated by `X-Plutus-Auth`) |
| Notes / positions / opportunities | existing `/api/journal/*` |
| PlayArea membership | existing `/api/universe/pools/PlayArea/members` |

Apply the migration on each database the API points at:

```bash
psql "$PLUTUS_SUPABASE_DB_URL" -f plutus/migrations/020_watchlists.sql
```

The Supabase Edge Function (`supabase/functions/plutus-api`) does **not** carry the extension routes; point the
extension at the FastAPI service (the same `VITE_PLUTUS_API_URL` the web app uses).

## What it does

**TradingView (`/chart*`)** — a draggable, resizable panel:

* Plutus pools (F40 / E40 / S200 / PlayArea) and custom watchlists (S1–S4 by default; synced through the API
  when a token is set, otherwise kept in this browser).
* Click a row (or `↑` / `↓`, optional `Space`) to switch the chart instantly — drives TradingView's own symbol
  search. `←` / `→` cycle lists, `/` filters, `Alt+W` hides the panel.
* Follows the chart: whatever symbol TradingView shows is highlighted (and the list holding it is selected).
* Per-row chips: cap bucket, technical signal (BUY / OPP / RALLY), fundamental score `n/11`, PRIME, HELD qty,
  % from 200 DMA. Sort by conviction, DMA depth, ATH fall or score. Cap slicer with counts.
* Hot-keys on the active stock: `N` dated note, `O` opportunity, `B` bookmark to a watchlist, `A` PlayArea
  add/remove, `S` Screener, `P` Plutus stock page.
* Focus mode hides TradingView upsell dialogs. Data-as-of stamp turns amber when the snapshot is stale.

**Screener.in (`/company/...`)**

* Auto-opens the consolidated view; falls back to standalone when consolidated statements are ≥ 3 years
  stale, and remembers your choice per company.
* Toolbar next to *Export to Excel*: TradingView, Plutus, ON/OFF, Standalone ↔ Consolidated, Note, Bookmark.
* **Plutus card** above the ratios: cap, technical signal, PRIME, held position, pools; the 11 fundamental
  checks with pass/fail detail; 200 DMA gauge with the 9 % / 14 % entry levels in ₹; ATH fall vs the
  cap-aware rule; 52-week range; 20 % rally; PE/PB; on-page rule checks (TTM sales & profit ≥ 90 % of
  10-year peak, TTM profit > ₹250 Cr, OPM stable, tax-rate sanity, interest burden, borrowings trend,
  fixed-asset peak, 1Y/3Y price CAGR vs profit CAGR, public holding < 30 %). Buttons: Note, Opportunity,
  PlayArea.
* Ratio tiles coloured against the **server** thresholds (PE, 5Y PE vs current, ROCE, ROE, D/E, pledge) and
  local ones (52w high, 200 SMA, ATH, public holding). Missing tiles are synthesised from Plutus data
  (200 DMA, off-ATH, pledged %, public %, net D/E, 5Y avg PE).
* Tables: YoY colouring for quarters / P&L / balance sheet / cash flow, expense rows as % of sales, reverse
  rows (interest, tax, depreciation, borrowings), other-income and exceptional-item outliers (IQR), best /
  worst per row. Shareholding QoQ. Peers: best per column, threshold colouring, "in Plutus" chips.
* Chart buttons: fundamentals (quarterly & annual sales / profit / OPM, EPS, interest, borrowings) and
  shareholding series.

## Conventions

* Internal symbol form is always `TCS.NS`; convert at the edges with `shared/symbols.js`.
* All DOM ids / classes / storage keys are prefixed `px-` / `plutus_`.
* TradingView selectors live in one object (`TV` at the top of `tv/tv_content.js`); Screener section ids are
  the same ones `plutus/fundamentals/screener_page.py` parses.
* No money math in the extension beyond display formatting; numbers arrive as strings from the API.
