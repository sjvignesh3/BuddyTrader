# Plutus Browser Extension — Study of HIFY Nexus Pro & Integration Approach

> **Date:** 2026-09-23
> **Input:** `D:\Tools\Plutus\HIFYExtension` (HIFY Nexus Pro v1.4.0, Manifest V3, 12 files)
> **Purpose:** Decide what to reuse from HIFY, what to rebuild, what the Plutus backend must
> expose, and which extra features would speed up day-to-day analysis on TradingView and Screener.
> **Out of scope (by decision):** HIFY's login / subscription / device-seat machinery. Plutus is a
> personal tool; the only "auth" the extension needs is the owner token for Plutus' own gated routes.

---

## 1. Executive summary

HIFY is a thin, DOM-scraping Chrome extension with **no proprietary data pipeline**: every number it
shows comes from the page it sits on, and every watchlist comes from a single `POST /api/extension/hydrate`
call to its portal. Roughly **70 % of the code is directly reusable** (panel UI, instant symbol switching,
keyboard navigation, Screener colour-coding, Chart.js modal, auto-consolidated redirect), **~25 % is
auth/licensing that must be deleted**, and **~5 % is HIFY-specific data** (hard-coded watchlists and
market-cap table) that Plutus already has in Supabase and serves via its API.

The integration is mostly a **data-source swap**: replace the hydrate call with Plutus read endpoints,
then layer Plutus-only intelligence (200 DMA / ATH / 52-week metrics, 11-point fundamental score,
strategy signals, held positions, notes) onto both sites. That last part is where the real value is:
HIFY can only colour what Screener happens to display; Plutus already computes the numbers the user's
own rules depend on.

Suggested delivery: four phases, the first of which (strip auth, load unpacked, point at Plutus for
watchlists) is a one-day job.

---

## 2. What HIFY is — architecture in one page

```
manifest.json (MV3)
 ├─ background.js         service worker: re-inject on install/startup, symbol canonicalisation,
 │                        token-refresh orchestrator, message relay between tabs
 ├─ config.js             HIFY_PORTAL_URL + parseJwtPayload() — injected everywhere
 ├─ content.js            TradingView (https://*.tradingview.com/chart*)  — 3 000 lines
 ├─ screener_content.js   Screener.in (https://*.screener.in/*)           — 1 284 lines
 ├─ chart.min.js          Chart.js 4.5.1 (MIT) — loaded before screener_content.js
 ├─ hify_bridge.js        runs on happy-investing.in, copies the portal JWT into chrome.storage
 └─ popup.html/.js        account card + 10 Screener threshold inputs
```

Data flow: portal tab → `hify_bridge.js` → `chrome.storage.local` (JWT) → content scripts POST
`/api/extension/hydrate` → `{watchlists, stock_caps}` → rendered. Nothing else touches the network.

### 2.1 TradingView content script — feature inventory

| Feature | Lines | Mechanism | Verdict |
|---|---|---|---|
| Floating watchlist panel (`#hify-tv-panel`) with header, select, cap slicer, filter, list, add-row, resize handles | 615–2473 | Injected HTML + 790-line CSS block, dark theme matching TV | **Reuse** (rebrand) |
| Instant symbol switch | 365–461 | Clicks TV's symbol-search button, sets the React input via the native value setter, dispatches Enter, clicks first result, closes dialog; body class hides the dialog to avoid flicker | **Reuse** — the crown jewel; nothing in Plutus does this |
| Active-symbol detection | 487–560 | Reads `#header-toolbar-symbol-search`, `document.title`, legend, `?symbol=`; re-syncs on focus and on `<title>` mutation | **Reuse** |
| Keyboard nav | 565–611, 2405–2450 | Capture-phase `keydown`: Space/↓ next, ↑ prev, ←/→ cycle list, Alt+W toggle; 60 ms debounce | **Reuse** (consider making Space opt-in — it hijacks TV's own shortcut) |
| Official watchlists F40/E40/S200/OS200 | 45 (40 KB literal) | Hard-coded `MASTER_WATCHLISTS`, overwritten by hydrate | **Replace** with Plutus pools |
| Market-cap slicer | 48, 140–153, 1842 | Hard-coded `STOCK_CAPS` (474 tickers) | **Replace** with `cap_bucket` from Plutus snapshots |
| Custom watchlists S1–S4 (add / delete / rename / bookmark-copy) | 233–283, 1912–2400 | `chrome.storage.local["hify_custom_watchlists_<uid>"]` | **Reuse**, back it with a Plutus table so it syncs with the web app's PlayArea |
| In-panel dialogs + toasts | 1857–2142 | Generic overlay dialog, 4 s toast | **Reuse** (escape toast HTML — it uses `innerHTML`) |
| Screener opener | 1876–1909 | `window.open(screener.in/company/<T>/consolidated/)` | **Reuse** |
| Focus Mode (kill TV upsell dialogs) | 2892–2986 | CSS hides `gopro`/`upgrade` dialogs; MutationObserver clicks close or removes matching nodes | **Reuse**, but narrow the heuristics (it can eat TV's own alert dialogs) |
| Lock overlay + hydration + token refresh | 1465–1474, 1591–1593, 2475–2761, 2765–2887 | Entire licensing flow | **Delete** |

### 2.2 Screener content script — feature inventory

| Feature | Lines | Mechanism | Verdict |
|---|---|---|---|
| Toolbar next to "Export to Excel": TradingView link, ON/OFF toggle, Standalone↔Consolidated switch | 240–452 | Finds the Excel control, copies its computed size into CSS vars | **Reuse** |
| Smart auto-consolidated + staleness detection | 136–234 | Redirects to `/consolidated/`; if latest P&L year is ≥3 yrs old, flips back to standalone and remembers per ticker (`localStorage`) | **Reuse** — nice touch, Plutus' server client has the same fallback logic |
| Top-ratio tile colouring (P/E, 5y PE, book value, ROCE/ROE, 52w high, D/E, 200 SMA, ATH, pledge, public holding) | 454–527 | Reads `#top-ratios li .name/.value`, applies thresholds from popup | **Reuse**, but feed thresholds from Plutus `strategy_configs` |
| Financial-table YoY/QoQ colouring incl. expense-as-%-of-sales, reverse rows (interest, tax, depreciation), row extrema | 529–786 | Parses `#quarters`, `#profit-loss`, `#balance-sheet`; finds same period previous year by header text | **Reuse** |
| Other-income / exceptional-item outlier detection | 600–676 | IQR statistics per row, two shades of yellow | **Reuse** — directly serves the user's "Watchout" list |
| Shareholding QoQ colouring | 788–867 | `#shareholding` rows; public falling = green | **Reuse** |
| Peer table best-in-column | 869–899 | max/min only, P/E and debt = lower-is-better | **Reuse**, improve (apply thresholds, mark universe members) |
| Charts modal (Q/Y sales & profit; promoter/FII/DII/public/govt/shareholders) | 901–994 | Chart.js bar charts, red bar when lower than previous | **Reuse** |
| Auth gate, banner, hydrate on every `run()` | 1014–1189 | `POST /hydrate` on every DOM mutation, focus, popstate | **Delete** (also removes a performance problem) |

### 2.3 Shared / supporting pieces

| File | Verdict |
|---|---|
| `background.js` symbol helpers `toCanonicalSymbol` / `toTradingViewSymbol` / `toScreenerSymbol` + legacy alias map (`M_M`→`M&M`, `BAJAJ_AUTO`→`BAJAJ-AUTO` …) | **Reuse** and extend with a `toPlutusSymbol` (`TCS.NS`) and `toJournalSymbol` (`TCS`) |
| `background.js` inject-into-open-tabs on install/startup | **Reuse** |
| `background.js` token-refresh orchestrator, `hify_bridge.js` | **Delete**; optionally repurpose the bridge pattern to read Plutus' owner token from the web app tab (see §4.4) |
| `popup.html/.js` threshold inputs + defaults | **Reuse**; drop the account card; add Plutus API URL + token fields |
| `chart.min.js` | **Keep** (MIT) |
| `manifest.json` | **Rewrite**: remove `key`, `update_url`, happy-investing hosts; add Plutus API host(s) |
| `_metadata/` | Delete (Chrome Web Store signing artefacts) |

---

## 3. Gaps and defects worth fixing while porting

1. **Symbol handling on Screener is naive**: `NSE:<path segment>` with no `&`/`-` handling and no BSE fallback, so `M&M` becomes `NSE:M%26M` and a BSE-only code becomes `NSE:500325`. Use the background helpers on both sites.
2. **Screener thresholds only fire on tiles the user has added as custom quick ratios** ("200 DMA", "ATH", "Pledge", "Public holding" are not default Screener tiles). Plutus already computes these; inject them instead of hoping the tile exists.
3. **Every Screener `run()` waits on a network call** before colouring anything. Removing auth fixes this; the Plutus call should be cached and non-blocking.
4. **Space bar is hijacked globally** while the panel is open, breaking TV's own shortcuts. Make it configurable.
5. **Toast uses `innerHTML` with user-supplied list names.** Escape it.
6. **Guard references the wrong panel id** (`#hify-watchlist-panel` vs `#hify-tv-panel`), an undefined `@keyframes hifyFadeIn`, dead `removeUI()`. Cosmetic.
7. **HIFY default ROCE minimum is 12; the user's rule and Plutus' scan use 15.** Align defaults to Plutus.
8. **Fixed pastel colours look wrong in Screener dark mode.** Use Screener's CSS variables with fallbacks.

---

## 4. Plutus integration — what already exists and what must be built

### 4.1 Already available (no backend change)

| Need | Plutus route (FastAPI + Edge Function) | Notes |
|---|---|---|
| Watchlists = pools | `GET /api/pools`, `GET /api/stocks?pool=F40` | Replaces `MASTER_WATCHLISTS`; symbols come back as `TCS.NS` |
| Cap bucket, close, 200 DMA, 52w, ATH, rally per stock | `GET /api/snapshots/latest?pool=` or `?symbols=` | Replaces `STOCK_CAPS`; money fields are strings (keep them as strings until display) |
| Fundamental score (11 checks with details), technical signals | `GET /api/scan_results?symbols=` | `metrics_snapshot.checks[]` is exactly the card grid the web app shows |
| Latest quarterly fundamentals, ROCE/ROE, pledging, 5y avg PE/PB | `GET /api/fundamentals/{symbol}/latest` | |
| Held positions ("Held" badge) | `GET /api/journal/positions` | Gated: needs `X-Plutus-Auth` owner/viewer token |
| Dated stock notes (read/write) | `GET/POST/PUT /api/journal/notes` | Gated; plain symbol `TCS` |
| Opportunities (add from chart) | `POST /api/journal/opportunities` | Gated |
| Trigger a sync for a symbol not yet in the universe | `POST /api/admin/trigger` | Needs `X-Plutus-Admin-Token` |
| Sync freshness stamp | `GET /api/sync_jobs/latest` | Show "data as of <date>" in the panel |

CORS is already `allow_origins=["*"]`, so a content script or service worker fetch from
`chrome-extension://<id>` works without changes. If prod CORS is ever narrowed, add the extension origin.

### 4.2 Backend additions (recommended, in priority order)

| # | Addition | Why | Where |
|---|---|---|---|
| B1 | **`GET /api/extension/bootstrap`** → `{snapshot_date, pools:[…], watchlists:{F40:[…],E40:[…],S200:[…],PlayArea:[…]}, stocks:{ "TCS.NS": {cap_bucket, close, below_200dma_pct, fall_from_ath_pct, distance_from_52w_high_pct, best_status, funda_points, held_qty} } }` | One call instead of 4–6 per page load; the extension caches it in `chrome.storage` with a TTL keyed on `snapshot_date` (data changes once a day at 18:00 IST, so a 12 h TTL is safe). Also hides Render cold-start latency behind the cache | `plutus/api/extension.py` (new), `repository.py` helpers, Edge Function port, `test_deployment_config.py` gate |
| B2 | **`watchlists` table + `/api/watchlists` CRUD** (migration 019: `name`, `symbols TEXT[]`, `display_order`, `updated_at`; owner-write, viewer-read) | Custom lists S1–S4 and the web app's PlayArea (`plutus.playarea.v1` in localStorage today) become one synced list set. `playarea.ts` switches to the API | New migration, `plutus/api/watchlists.py`, add `/api/watchlists` to `PROTECTED_PREFIXES`, frontend `playarea.ts` |
| B3 | **`GET /api/strategy_configs`** (read-only) | Single source of thresholds (PE < 70, ROCE > 15, D/E < 0.25, pledge < 5, ATH tolerance 90 %, cap-aware ATH fall 20/30/40). The popup shows them as read-only defaults with a local override; the scan engine, web app and extension all agree | `app.py`, `repository.py`, Edge Function |
| B4 | **`GET /api/extension/stock/{symbol}`** → snapshot + latest fundamentals + latest scan results + positions + notes count in one object | The Screener and TV overlays for the *current* stock need all of it at once | `extension.py` |
| B5 | **Symbol canonicalisation contract in `plutus/registry`** (Python) mirroring the JS helpers: `TCS.NS` ↔ `NSE:TCS` ↔ `TCS`; alias map for `M&M`/`BAJAJ-AUTO`; BSE numeric codes → `BSE:500325` | Three sites, three spellings; keep one table of truth and unit-test it | `registry/symbols.py` + test; JS copy in the extension's `symbols.js` |
| B6 (optional, phase 4) | **`POST /api/fundamentals/ingest`** accepting the Screener page tables parsed by the extension (quarters, P&L, balance sheet, shareholding, top ratios, quick ratios) | Human-in-the-loop fallback when the GitHub Actions Screener login gets rate-limited; the browser is already logged in. Must go through the same Decimal validators and `rows_from_bundle` path as the server parser; store `data_source='extension'` | `plutus/api/fundamentals_ingest.py`, reuse `screener_page.py` parsers on the server side by posting raw HTML rather than parsed numbers (safer: server stays the only parser) |

### 4.3 Extension-side additions (no backend)

- `plutus_api.js` (service worker): fetch wrapper with `X-Plutus-Auth` header, retry, `chrome.storage` cache, and a `PLUTUS_API_URL` setting (local `http://127.0.0.1:8000` vs Render).
- `symbols.js`: the three HIFY converters plus `toPlutusSymbol` / `toJournalSymbol`.
- Options in the popup: API URL, owner token (paste once), thresholds override, Space-key toggle.

### 4.4 Reaching the gated routes without HIFY-style auth

The Plutus web app already stores the signed owner token in `localStorage["plutus.auth.v1"]`. Two options:

1. **Paste-once**: the popup has a token field; the user signs in on the web app, copies the token from the Console page (add a "copy token" button), pastes it. Simplest.
2. **Bridge pattern (HIFY's `hify_bridge.js`, stripped)**: a 40-line content script on the Plutus web-app origin reads that key and mirrors it to `chrome.storage`. Zero manual steps, same trust boundary as the browser tab itself.

Either way, open read routes (pools, snapshots, scans, fundamentals) need no token at all, so Phase 1 works with nothing configured.

---

## 5. Additional features for faster analysis

Grouped by where they appear. Items marked ★ map directly to a rule in `UserData/Fundamental POinters.md`.

### 5.1 TradingView panel

| Feature | Data | Effort |
|---|---|---|
| **Signal + score chips per row**: `BUY_ZONE / OPPORTUNITY / VALID`, funda `8/11`, conviction `PRIME / STRONG / WATCH` (reuse `conviction.ts` logic) | bootstrap (B1) | S |
| **Sort/filter modes**: by conviction rank, % below 200 DMA, % off ATH (cap-aware rule ★), funda score, sync date | bootstrap | S |
| **"Held" badge + qty/invested** on rows where a journal position is open | `/api/journal/positions` | S |
| **Pool tabs = Plutus pools** (F40 / E40 / S200 / PlayArea), PlayArea editable and synced (B2) | pools, watchlists | M |
| **Key-level lines**: show 200 DMA, 9 % / 14 % envelope entries, 52w low/high, ATH as ₹ values under the active row (same numbers as the web app's DMA gauge) | snapshot | S |
| **One-key actions**: `N` note (POST to notes, pre-filled with symbol and today), `O` add opportunity with current close, `B` bookmark to PlayArea, `S` open Screener, `P` open Plutus stock page | journal routes | M |
| **Data-as-of stamp + stale warning** when `snapshot_date` is older than the last trading day | sync_jobs | S |
| **Session replay list**: "stocks I viewed today" (auto-captured from active-symbol detection) with a "review in Plutus" link | local | S |
| Focus Mode heuristics narrowed to known upsell selectors only | — | S |

### 5.2 Screener.in company page

| Feature | Data | Effort |
|---|---|---|
| **Plutus verdict card above `#top-ratios`**: 11-check grid (pass/fail/NA with detail strings), technical signal, cap bucket, 200 DMA distance, ATH fall vs cap threshold ★, 52w position, held badge, last note date | B4 | M |
| **Threshold tiles no longer depend on user-added quick ratios** — inject the Plutus number as a synthetic tile when Screener lacks it (200 DMA, ATH, pledge, public holding) | B4 | S |
| ★ **TTM Sales / TTM Net Profit ≥ 90 % of 10-year max** highlighted on `#profit-loss` (TTM column vs row max) | page | S |
| ★ **TTM Net Profit > ₹250 Cr** badge | page | S |
| ★ **OPM trend flag** (stable/rising vs falling over last 8 quarters and 5 years) | page | S |
| ★ **Interest-to-PBT and borrowing trend** ("more interest reducing profit, more borrowing") from `#profit-loss` + `#balance-sheet` | page | S |
| ★ **Effective tax-rate anomaly** (Tax % row vs 25 % band, sudden drops) | page | S |
| ★ **Asset growth criterion**: Tangible fixed assets (Fixed Assets − Intangibles, needs the expanded balance-sheet sub-rows) ≥ 90 % of 10-yr max | page (expanded rows) | M |
| ★ **Price CAGR vs profit CAGR** (1 yr and 3 yr) from Screener's "Compounded Profit Growth" and "Stock Price CAGR" mini-tables | page | S |
| ★ **Market Cap/Sales and EV/EBITDA vs their own median** via Screener's public chart API (`/api/company/{id}/chart/?q=…`, the same endpoint `screener_client.py` already uses for 5y PE) | screener API, logged-in tab | M |
| **Peer table upgrade**: colour every column with the same thresholds as the tiles, mark peers that are in the Plutus universe, one-click "add peer to PlayArea" | B1 | S |
| **Charts modal upgrade**: add OPM %, interest, tax %, EPS, promoter pledge series; overlay Plutus 200 DMA history from `/api/snapshots/{symbol}/history` | page + history | M |
| **"Push this page to Plutus"** (B6) when the nightly Screener sync failed for this symbol | B6 | M |
| **Save note from Screener** (`N` key, same modal as TV) | notes | S |
| Dark-mode aware colours | — | S |

### 5.3 Cross-site / hygiene

- One threshold set, three consumers (B3). Changing PE max in Plutus changes the scan, the web app and both overlays.
- Symbol converters shared (B5); aliases tested.
- Per-site kill switch and per-feature toggles in the popup (HIFY has only a global ON/OFF).
- Structured console logging behind a debug flag; TradingView selectors listed in one `selectors.js` so a TV redeploy is a one-file fix.

---

## 6. Approach and phasing

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Fork & strip** (≈1 day) | Copy to `plutus_extension/`; delete auth (TV lines 1465–1474, 1591–1593, 2475–2761, 2765–2887; Screener lines 1014–1189 and the `isAuthorized` branches; all of `hify_bridge.js`; token code in `background.js`, `popup.js`); rebrand; new `manifest.json` without `key`/`update_url`; fix the 8 defects in §3; load unpacked | Panel and Screener colouring work offline from the hard-coded lists |
| **1 — Read integration** | B1, B3, B5 on the backend; `plutus_api.js`, `symbols.js`, cache; pools as watchlists; cap chips; signal/score chips; data-as-of stamp | No hard-coded watchlists remain; all numbers match the web app for the same date |
| **2 — Writes & personal data** | B2 (watchlists table, PlayArea sync), token handling (§4.4), held badge, notes and opportunity hot-keys on both sites | A note added from TradingView appears on the web app's stock page |
| **3 — Screener intelligence** | B4; Plutus verdict card; the ★ rules from §5.2; peer-table and chart upgrades | The Must-Have list in `Fundamental POinters.md` is fully visible on a Screener page without opening Plutus |
| **4 — Optional** | B6 ingest fallback; session replay; selector health check | — |

Guardrails carried over from `Plutus_Phased_Development.MD`: money fields stay strings in the
extension until render; no threshold literals outside `strategy_configs`; every new API route lands in
FastAPI and the Edge Function with the deployment-config test updated; extension does no writes except
through the gated journal/watchlist routes.

---

## 7. Risks and constraints

- **TradingView DOM fragility.** The switcher relies on `data-name="symbol-search-dialog"`, `input[data-role="search"]`, `[data-role="list-item"]` and hashed class prefixes; a TV redeploy can break it silently. Mitigate with `selectors.js`, a self-test on load (open/close the dialog once) and a visible "switcher degraded" warning.
- **Screener markup.** Table ids (`#quarters`, `#profit-loss`, `#balance-sheet`, `#shareholding`, `#peers`) and `td.text` have been stable for years and Plutus' server parser depends on the same ones, so both break together and get fixed together.
- **Render free tier cold starts** (30–60 s). The bootstrap cache (B1) plus a background pre-warm ping on browser start keeps the panel instant.
- **Rate etiquette on Screener.** The extension only reads the page already loaded; the optional chart-API calls in §5.2 must be throttled and cached per symbol per day.
- **Provenance.** HIFY is a paid, proprietary extension. Reusing its code for a private, unpublished, personal build is the user's call; it should not be redistributed or published to the Chrome Web Store. Chart.js is MIT and unaffected.
- **Unpacked extension** requires Developer Mode in Chrome and survives restarts; no store listing needed.

---

## 8. File-level decision table (for the fork)

| HIFY file | Action |
|---|---|
| `manifest.json` | Rewrite (name, hosts, remove `key`, `update_url`, `_metadata`) |
| `config.js` | Replace with `settings.js` (API URL, token, feature flags) |
| `background.js` | Keep symbol helpers + tab injection; delete token orchestration; add `plutus_api.js` fetch/cache + `PING` pre-warm |
| `content.js` | Keep ~2 100 lines; delete ~600 (auth); replace the two 40 KB literals with bootstrap data; add signal chips, sort modes, hot-keys |
| `screener_content.js` | Keep ~1 000 lines; delete ~180 (auth); add verdict card + ★ rules; route thresholds through B3 |
| `hify_bridge.js` | Delete (or 40-line Plutus token bridge) |
| `popup.html/.js` | Keep thresholds; replace account card with API/token/flags |
| `chart.min.js`, `icons/` | Keep Chart.js; replace icons |
