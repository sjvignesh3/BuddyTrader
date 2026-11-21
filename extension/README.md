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
│   ├── ui.js                toast / dialog / DOM helpers, brand mark + the message bridge
│   ├── panel_logic.js       pure list logic: markets, US cap tiers, sectors, sort comparator (Node-tested)
│   └── sizer.js             position sizer: port of lib/sizing.ts + the journal cap rule, and its dialog
├── tv/                      TradingView panel (tv_content.js + tv.css)
├── screener/                Screener.in overlays (screener_content.js + screener.css)
├── popup/                   settings popup
├── webapp/token_bridge.js   copies the web app's session token into the extension (localhost:5173)
├── tests/background.test.js offline tests for the worker (tab linking) + symbol converters
├── vendor/chart.min.js      Chart.js 4.5.1 (MIT)
└── icons/
```

## Install (unpacked, personal use)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this `extension/` folder.
2. Click the toolbar icon → set **Plutus API URL** (local `http://127.0.0.1:8787`, or the Render URL) → **Test connection**.
3. Sign in on the Plutus web app once. On `localhost:5173` the token is picked up automatically. For a
   deployed web app, enter its URL as **Plutus web app URL** and Save: Chrome asks once for that site, the
   token bridge is registered there, and signing in on the web app feeds the token to the extension. (Pasting
   `localStorage["plutus.auth.v1"]` into **Session token** still works.)
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
* **India / US switch** (shown once the universe has US stocks): pools, watchlists and sector views of one
  market at a time. Switching resets the slicers; following the chart into a stock of the other market flips
  the region. US rows get a Mega / Large / Mid / Small tier from market cap (display only; sizing is unchanged).
* **Sector views**: a sector dropdown next to the filter narrows the current list (India groups Banks / NBFC
  by `sector_group`, else `sector`), and every sector of the region is also a virtual list in the selector.
* **Columns**: each row shows % from the 200 DMA, % off the 52-week high, % off the ATH and the `n/11` score.
  Click a column header to sort, click again to flip. Chips underneath: technical signal (BUY / OPP / RALLY),
  PRIME, HELD qty. Cap slicer with counts.
* **Drawer** (`☰` or `Alt+D`, slides out beside the panel) that follows the selected stock:
  *Filters* (sort, region, watchlist New / Rename / Delete, refresh), *Stock* (summary; the full 11-check card
  arrives in v0.4), *Trades* (open lots), *Notes* (the full dated timeline: add with `Ctrl+Enter`, edit, delete).
* Hot-keys on the active stock: `N` dated note, `O` opportunity, `B` bookmark to a watchlist, `A` PlayArea
  add/remove, `S` Screener, `P` Plutus stock page.
* Focus mode hides TradingView upsell dialogs. Data-as-of stamp turns amber when the snapshot is stale.
* `⤢` (or `Alt+E`) expands the panel to a tall 520 px view and restores the previous size; drag the header to
  move, drag the bottom-right corner to resize, double-click the header to reset.

**Screener.in (`/company/...`)**

* Auto-opens the consolidated view; falls back to standalone when the consolidated view is empty (companies
  that file only standalone, e.g. SANOFICONR) or its statements are ≥ 3 years stale, and remembers the choice
  per company. Picking Consolidated yourself always wins.
* Toolbar in the company header row (before *Export to Excel*, or before *Follow* when a page has no Export):
  TradingView, Plutus, Consolidated · Standalone, Note, Bookmark, on/off switch.
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

**Workflow across both sites**

* **Linked tabs** (`⇄` in the panel header and on the Screener pill). Switching the chart moves an open Screener
  company tab to the same stock; opening a company on Screener moves the chart. The worker prefers a tab visible
  in another window (second monitor), never touches Screener pages that are not company pages, and swallows the
  moved tab's report so the two never ping-pong.
* **Walk-through on Screener.** A pill bottom-left walks the list the TradingView panel shows (same filter and
  sort) with `←` / `→`. Picking a list in the pill switches the panel too. Without a panel list it walks the
  stock's own pool A → Z.
* **Position sizer** (`Z` on the chart, `⚖` on rows, `⚖ Size` on the Screener card). Capital comes from the
  journal, entry from the live chart price (or Screener's price), stop and target from one-click chips (rally
  low, 52-week low, −5 / −8 / −10 %, 200 DMA, 52-week high, ATH). Shows qty, deployed, ₹ risk, stop distance,
  R-multiple, and the per-stock cap-bucket limit including what you already hold, with a "max qty within
  limit" fix. Saves as a journal opportunity (qty, stop, target, GTT limit, risk note) or a Position Sizer plan.
  `frontend_v2/src/lib/extensionSizerParity.test.ts` proves it matches the web app on thousands of inputs.
* **Held-position strip** (TradingView footer). For a stock with OPEN lots: qty @ weighted average, live P&L ₹
  and %, days since the first buy, distance to the newest lot's target and stop, invested → value, open risk
  to stop. The lots button opens a per-lot table (date, qty @ price, P&L, target / stop).

## Tests

```bash
node --test extension/tests/*.test.js
```

`tests/harness/tv_harness.html` renders the real panel against a stubbed service worker and a fixture
universe (India + US) for eyeballing layout changes without TradingView:
`python -m http.server 8799 --directory extension` → `http://127.0.0.1:8799/tests/harness/tv_harness.html`.

## Conventions

* Internal symbol form is always `TCS.NS`; convert at the edges with `shared/symbols.js`.
* All DOM ids / classes / storage keys are prefixed `px-` / `plutus_`.
* TradingView selectors live in one object (`TV` at the top of `tv/tv_content.js`); Screener section ids are
  the same ones `plutus/fundamentals/screener_page.py` parses.
* No money math in the extension beyond display formatting; numbers arrive as strings from the API.
