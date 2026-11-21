# Plutus Companion vs HIFY Nexus Pro v1.8.3: gap analysis

> **Date:** 2026-11-18
> **Input:** `D:\Tools\Plutus\HIFYExtension1\...\1.8.3_0` (HIFY v1.8.3, MV3) compared with `BuddyTrader/extension` (Plutus Companion v0.2.1)
> **Earlier study:** `Docs/Plutus_Extension_Study.MD` covered HIFY v1.4.0 (2026-09-23), the version Plutus Companion was modelled on.
> **Out of scope, as before:** HIFY's login, subscription and device-seat code.

---

## 1. What changed in HIFY between v1.4.0 and v1.8.3

| File | v1.4.0 | v1.8.3 | What the growth is |
|---|---|---|---|
| `content.js` (TradingView) | 3,000 lines | 10,367 lines | About 2,200 lines of CSS. The rest is a live quote grid, a fundamental rules engine, filter chips, a 4-page drawer, labels, notes, an IN/US split and more licensing code |
| `background.js` | 308 | 1,037 | Now fetches data from other sites on behalf of the content scripts: the TradingView scanner, screener.in, stockresearch.app, stockanalysis.com. Also refreshes Firebase tokens and enforces the device seat |
| `config.js` | 40 | 925 | About 650 lines of hard-coded US ticker→exchange map, 32 hard-coded US interest-coverage values, and a cloud-sync merge routine that nothing calls yet |
| `screener_content.js` | 1,284 | 1,438 | A "metrics bridge" that saves about 23 tile, table and shareholding values per ticker for the TradingView panel to read. Everything else is unchanged |
| **New** `us_financials_content.js` | — | 868 | Screener-style colouring of US income statements on stockanalysis.com and roic.ai |
| **New** `stockresearch_content.js` | — | 191 | Adds 3Y median and 3Y/10Y low–high P/E tiles on stockresearch.app |
| **New** `vcpscanner_content.js` | — | 1,189 | Colours financials tables on vcpscanner.com and adds a toolbar. **Despite the name, it contains no VCP pattern logic.** |

**The architectural change:** HIFY v1.4.0 only coloured the page it was running on. v1.8.3 has its own **client-side data layer**. It calls TradingView's unofficial scanner API for about 40 columns per symbol, for any symbol, and refreshes every 10 s. It scrapes Screener, stockresearch.app and stockanalysis.com on demand. HIFY still has no data pipeline of its own.

Plutus works the other way round: its numbers come from a nightly **server** pipeline with a single source of truth (Supabase plus the scan engine). That is why Plutus is ahead on correctness and depth, and behind on **coverage** (stocks outside the universe) and **intraday freshness**.

---

## 2. HIFY v1.8.3: features and components

### 2.1 TradingView panel (`content.js`)

| # | Feature | Data source |
|---|---|---|
| T1 | **India / US region toggle.** It resets the cap and label filters and limits the lists to that region | localStorage |
| T2 | **Official lists, hard-coded in the file.** F40, E40, S200 (435), OS200, plus 14 US lists: All 578, High Conviction 195, Mega 57, and **11 GICS sector lists** | Literal, refreshed from their portal |
| T3 | Custom lists S1–S4 for India and **U1–U4 for US**, with soft-delete stamps | chrome.storage |
| T4 | **Smart Labels.** Per-stock coloured tags, a 🏷 popover on each row, a label slicer, a Label Manager, and each label works as a virtual watchlist (`LABEL:<id>`) per region. The default label is "Holding" | chrome.storage |
| T5 | **TradingView scanner engine.** `POST scanner.tradingview.com/{india\|america}/scan` with 40 columns (close, SMA200, 52-week high/low, ATH, market cap, P/E, PEG, ROIC, ROE, margins, D/E, net debt, FCF, revenue and net income YoY, Perf.Y/3Y, P/B, EV/EBITDA, P/S, current ratio, sector, industry, float, dividend yield, EPS, EBITDA…). Batches of 250, results cached 30 s, one retry on HTTP 429 | Third party (unofficial API) |
| T6 | **6-column live grid**: Symbol / Last / Chg / Chg% / %52wH / %200D, with sortable headers, a green/red price flash, a 10 s poll while the tab is visible, and the active row patched from the tab title | T5 + `document.title` |
| T7 | **Market-cap fallback for any symbol.** India: Large ≥ ₹50,000 Cr, Mid ≥ ₹15,000 Cr. US: Mega ≥ $200B, Large ≥ $10B, Mid ≥ $2B | T5 |
| T8 | **Client-side fundamental rules engine: N/11 score.** 11 Must-Have rules (200 DMA, 52-week dip, ATH dip by cap tier, P/E, Net D/E with a Net Debt/EBITDA fallback, ROIC, ROE (bank-aware), PAT size, sales growth, PAT growth, OPM). 7 Good-to-Have rules (PEG, P/S, EV/EBITDA, price-versus-profit CAGR, deep-value P/B). 4 Watchouts (debt/cash, negative OPM with positive net margin, current ratio < 1, value trap). Verdicts: All-Star / Prime / Caution / Developing | T5 + Screener bridge |
| T9 | **Fundamental filter chips.** ⭐ All-Star plus 11 chips; each chip hides stocks that fail that rule | T8 |
| T10 | **Sort dropdown with 17 modes**, for example score, lowest P/E, highest ROIC, market cap, 52-week dip, 200 DMA distance | T5/T8 |
| T11 | **4-page sliding drawer** to the left of the panel | — |
| T11a | Page 1 **Filters and settings**: label filter, the T9 chips, **editable strategy thresholds for India and US** (P/E max, ROCE, ROE, Net D/E, 200 DMA, cap-tier dips, PAT floor, OPM, EV/EBITDA, P/S, current ratio, PEG), watchlist admin, Screener quick-open | local storage |
| T11b | Page 2 **Live Fundamental Dossier** for the active stock: Must-Have and Good-to-Have tables with traffic-light cells; **3Y/5Y/10Y median P/E**, interest coverage, Net Debt/EBITDA, Net Debt/FCF, sales and PAT vs 10-year peak, public holding, pledge; links to Screener, stockresearch.app, stockanalysis.com, roic.ai, vcpscanner.com and TradingView financials | T5 + background scrapes |
| T11c | Page 3 **Trade Decision / Position Sizing**: a **static placeholder** with nothing working | — |
| T11d | Page 4 **Notes timeline** for the active stock: add (Ctrl+Enter), delete, newest first, **stored only in this browser** | chrome.storage |
| T12 | Instant symbol switch, active-symbol detection, keyboard nav, Focus Mode, resizable panel. Same as v1.4.0, hardened | TradingView DOM |
| T13 | Licensing: lock overlay, Google SSO, one device seat, 5-minute heartbeat, 48 h offline grace | Their portal |

### 2.2 Background worker on-demand fetchers

| Message | What it fetches | What it computes |
|---|---|---|
| `FETCH_INDIAN_STOCK_VALUATION` | the `screener.in/company/{T}/consolidated/` HTML, plus `screener.in/api/company/{id}/chart/?q=Price+to+Earning-Median+PE-EPS&days=1095\|1825\|3650` | public % and pledge %, **3/5/10-year median P/E**, interest coverage = Operating Profit ÷ Interest |
| `FETCH_US_STOCK_VALUATION` | `stockresearch.app/stocks/{T}` (embedded Next.js series) and the `stockanalysis.com` income statement | 3/5/10-year median, low and high P/E; 15-year peak revenue and net income; interest coverage |
| `SCAN_FINANCIALS` | TradingView scanner | T5 |

### 2.3 Screener.in (`screener_content.js`)

Same as v1.4.0: toolbar, auto-consolidated view, tile colouring, YoY tables, outliers, shareholding, peers, charts. **New:** a metrics bridge that writes the page's tile values into `chrome.storage` so the TradingView panel can score a stock you looked at on Screener.

### 2.4 Other sites

| Site | What HIFY does |
|---|---|
| stockanalysis.com, roic.ai | Colours US income-statement rows: expenses as % of revenue, reverse rows (interest, D&A, tax), a "higher is greener" rule for growth rows, the row's best value, an IQR-style outlier fence for non-operating items. It also **unlocks StockAnalysis' paid "Full Width" button**, a paywall bypass. |
| stockresearch.app | Adds 3Y median and 3Y/10Y low–high P/E tiles |
| vcpscanner.com | Colours financials tables (same-quarter-last-year comparison, fixed bands for current ratio, quick ratio and interest coverage, net debt, zero-debt), colours the Piotroski / ROIC / ROE / beat-rate cards, adds a TradingView button. It extracts data into storage, but **nothing reads that data**. |

---

## 3. Where Plutus is already ahead (keep these)

| Plutus feature | What HIFY has instead |
|---|---|
| **Server-side 11-point score** using your real rules and `strategy_configs`, with an `n/a` count | A client-side score that **counts missing data as a pass**, so a stock with no data shows **11/11 All-Star**. Its "5-Yr Median" labels on P/S and EV/EBITDA actually use fixed thresholds. Its "10Y peak" uses every column, TTM included. |
| Technical signals (BUY / OPP / RALLY), PRIME conviction, data-as-of stamp | None |
| **Held-position strip** (average cost, P&L, days, target, stop, per-lot table) | A "Holding" label you set by hand |
| **Position sizer** with journal capital and cap-bucket limits, saved as an opportunity or plan | A static placeholder page |
| **Notes and watchlists synced** through the API to the web app | Stored only in the browser; Drive sync is a stub |
| Opportunity, PlayArea and bookmark hot-keys | Bookmark only |
| **Linked tabs** (TradingView ↔ Screener) and the Screener walk-through pill | None |
| Screener page rules (TTM vs peak, OPM stability, tax sanity, interest burden, borrowings trend, fixed-asset peak, price vs profit CAGR) and the bank/NBFC lender checks | Only YoY colouring |
| Symbol converters and a US registry driven by Plutus data | A hard-coded map of about 650 tickers |

---

## 4. Gap matrix: what Plutus lacks, and whether we can do it

Legend: ✅ possible, low risk · 🟡 possible with a caveat · ❌ not possible or should not be done

### 4.1 TradingView panel

| # | Gap | How we would do it in Plutus | Verdict | Effort |
|---|---|---|---|---|
| G1 | **Live prices in rows** (Last / Chg / Chg% / %52wH / %200D, with flash). Plutus rows show the nightly close; only the active stock gets a live price, from the tab title | Add a `scanner.fetch` handler to `background.js` that calls `scanner.tradingview.com/{india\|america}/scan` for only the visible list, with a few columns (close, change, change_abs) and a 10–15 s poll while the tab is visible. %200D and %52wH would be recomputed from the live price against Plutus' own SMA200, 52-week high and ATH from bootstrap, so the levels stay Plutus numbers. The host is already covered by our `*.tradingview.com` permission | 🟡 The endpoint is **unofficial**, so it can change or rate-limit (HTTP 429). Fine for personal use; degrade quietly to the nightly close | M |
| G2 | **Sortable column headers** and more sort modes (Chg%, live 200 DMA distance, P/E, ROCE, market cap) | Client-side comparator. Today's dropdown has conviction, DMA, ATH and score | ✅ | S |
| G3 | **Per-rule filter chips** ("hide stocks failing ROCE", ⭐ 11/11 only) | Bootstrap returns only `funda_points`. Add a compact pass/fail/na code per check to each bootstrap stock, e.g. `checks: "PPFPN…"`, built from `metrics_snapshot.checks` in `plutus/api/extension.py`; chips then filter on it. **Unlike HIFY, n/a must not count as a pass** | ✅ Needs a small backend change | S–M |
| G4 | **Labels / tags** (multi-colour, a stock in many lists, label as a view) | Option A, recommended: put a 🏷 popover with checkboxes on each row, backed by the **existing watchlists**. The worker already has add and remove calls, so a "label" is just a watchlist, with an optional `color` column added in a migration. No "Holding" label is needed, because the held chip comes from the journal. Option B: a separate `stock_labels` table plus routes, only if you want tags that are not lists | ✅ A: front-end plus a tiny migration | S–M |
| G5 | **IN / US region switch** in the panel | Filter the pools and watchlists in the select by `market` (bootstrap already sends `market` per stock and pools carry a market). Remember the choice per tab. This matches the web app's single IN/US switch decision | ✅ | S |
| G6 | **Sector / industry views** (HIFY's 11 US GICS lists) | Bootstrap already sends `sector`, `industry` and `sector_group` (`extension.py:173-175`). Add virtual lists "Sector: X" (and India `sector_group`) or a sector slicer next to the cap slicer | ✅ No backend change | S |
| G7 | **Active-stock dossier** on the chart (Must-Have / Good-to-Have tables without opening Screener) | Add a "Stock" drawer or tab in the TV panel that renders `/api/extension/stock/{symbol}`. It is the same data as the Screener card (11 checks with details, DMA gauge, ATH rule, 52-week, PE/PB, pools, held). Most of it can reuse `screener_content.js buildCard` | ✅ | M |
| G8 | **Extra valuation metrics**: 3Y and 10Y **median** P/E (Plutus has a 5Y average), EV/EBITDA, P/S, PEG, Net Debt/EBITDA, Net Debt/FCF, interest coverage, current ratio, dividend yield | Preferred: **server-side, nightly**. `screener_client.py` already calls Screener's chart API for the 5Y P/E, so add the `days=1095/3650` medians in the same pass and store them in fundamentals. EV/EBITDA, PEG, dividend yield and current ratio are mostly Screener quick ratios the sync can save. Fallback for stocks outside the universe: G9 | ✅ Server; 🟡 if fetched per view from the browser (rate etiquette) | M |
| G9 | **Coverage of any symbol** (HIFY scores whatever is on the chart; Plutus shows nothing for stocks outside the universe) | For a stock outside the universe, call the TradingView scanner on demand (G1 handler, about 25 columns) and show a **clearly labelled "TV data · provisional"** card: cap from market cap, P/E, ROE/ROIC, D/E, margins, YoY growth, distance from 200 DMA, 52-week, ATH. Add a one-click "Add to PlayArea / trigger sync" so the real Plutus score follows. Never mix these numbers into the Plutus score | 🟡 Third-party numbers that do not match Screener definitions (ROIC vs ROCE, TTM differences). Display only | M |
| G10 | **Editable scoring thresholds in the UI** | Plutus deliberately keeps one threshold set (`strategy_configs`); the popup already overrides **colouring** thresholds only. If you want to edit the scoring thresholds, add an owner-gated `PUT /api/strategy_configs` with a form in the web app, so the scan, web app and extension stay in agreement. **Do not** copy HIFY's per-browser fork of the scoring rules | 🟡 Your call; it changes nightly scan results | M |
| G11 | **Full notes timeline** (Plutus shows the latest 3 in the note dialog) | A "Notes" tab in the panel drawer: list, edit and delete through the existing `GET/PUT/DELETE /api/journal/notes`, Ctrl+Enter to save. Already synced, unlike HIFY's | ✅ | S |
| G12 | **Token capture on the deployed web app.** HIFY's bridge catches its token on the production portal automatically; ours works only on `localhost:5173`, so the deployed app needs a paste | Add `optional_host_permissions: ["https://*/*"]`. When the popup's **web app URL** is saved, request that one origin and `chrome.scripting.registerContentScripts` the existing `token_bridge.js` there. No hard-coded origin in the manifest | ✅ | S |
| G13 | Market-cap tier for US (**Mega** ≥ $200B) | US is currently treated as "Large" for sizing (by decision). A Mega/Large/Mid display chip from `market_cap` in bootstrap is cheap; sizing rules unchanged | ✅ Display only | S |

### 4.2 Screener.in

| # | Gap | How | Verdict | Effort |
|---|---|---|---|---|
| G14 | Page → panel metrics bridge (HIFY saves tile values for TV scoring) | Not needed for universe stocks, because the server has them. For stocks outside the universe this is the old plan's **B6 ingest**: post the page HTML to the server, where the existing parser stays the only parser | 🟡 Optional, phase 4 | M |
| G15 | 3Y / 10Y median P/E tiles on the page | Comes free once G8 lands server-side (synthetic tiles already exist) | ✅ | S after G8 |

*(Everything else HIFY does on Screener, Plutus already does or does better.)*

### 4.3 New sites

| # | Gap | How | Verdict | Effort |
|---|---|---|---|---|
| G16 | **US income-statement colouring** on stockanalysis.com and roic.ai | A new content script that reuses our Screener table colouring: expenses as % of revenue, reverse rows, row best/worst, the outlier fence. Fix HIFY's bugs while doing it: clear and re-apply instead of stacking colours, exempt banks' net interest income from the cost rule, debounce on mutation rather than on scroll. Add host permissions for those two sites. Also add a TV ↔ stockanalysis link for US stocks, since Screener has no US pages | ✅ DOM-only. Useful because your US fundamental score (US phase 3) is still open | M |
| G17 | **US P/E history** (3/5/10Y median, low and high) from stockresearch.app | Fetch that page's embedded series and decode it (cumulative weekly deltas ÷ scale). This works, but it depends on the site's internal Next.js data shape | 🟡 Fragile scraping of a third-party site; low priority. Yahoo cannot give 10 years | S–M |
| G18 | vcpscanner.com colouring and toolbar | Possible, but low value: HIFY's extract goes nowhere and there is no VCP logic to learn from | 🟡 Skip unless you use the site | M |
| G19 | **Unlocking StockAnalysis' paid "Full Width" button** | — | ❌ **Will not do.** It bypasses a site's paywall | — |

### 4.4 Infrastructure

| # | HIFY piece | Plutus | Verdict |
|---|---|---|---|
| G20 | Firebase SSO, token refresh, device seat, heartbeat, trial, offline grace | Personal tool; owner and viewer tokens | ❌ Not needed |
| G21 | Google Drive cloud sync and soft-delete merge of lists and notes | The server is the source of truth | ❌ Not needed |
| G22 | Hard-coded 650-ticker US exchange map | Our US registry comes from Plutus pools. A stock you open outside the pools would need its exchange; TradingView already shows it, so read it from the chart's `EXCHANGE:SYMBOL` | ✅ Already handled better |
| G23 | Their curated lists (F40 / E40 / S200 contents, the 578-stock US universe) | Your pools are your own universe. To get a larger US universe, add pools in Plutus. Copying their curated lists means taking their product data | ❌ Do not copy; ✅ build our own pools |

---

## 5. What is not possible (or not wise), in short

1. **Drawing Plutus levels (200 DMA, 9 % / 14 % entries, ATH) on the TradingView chart canvas.** Neither extension can do this: TradingView exposes no public API to a content script on its own site. A Pine indicator is the supported route. The panel and held strip keep showing the levels as numbers.
2. **The paywall bypass** (G19).
3. **Making the TradingView scanner the source of truth.** It is unofficial, undocumented and rate-limited. Use it only for live display (G1) and for provisional cards on stocks outside the universe (G9). Calling it from the server (GitHub Actions or Render) would look like a bot and risk being blocked.
4. **Per-view scraping of Screener's chart API from the browser** for every stock you open. HIFY does this; we should fetch it nightly on the server (G8) to respect Screener's rate limits.
5. **Copying HIFY's curated universes** (G23).

---

## 6. Recommended order

| Step | Items | Why first |
|---|---|---|
| 1 — quick wins (≈1 day) | G2 sortable headers, G5 IN/US switch, G6 sector views, G11 notes timeline, G12 deployed-app token bridge, G13 US Mega chip | No backend changes; each is a few hours |
| 2 — the big visible gap | G1 live prices in rows, G3 per-rule filter chips (small `extension.py` change), G7 active-stock dossier on the chart | This is what makes HIFY v1.8.3 feel "live"; Plutus keeps its better numbers underneath |
| 3 — data depth | G8 3Y/10Y median P/E and the extra ratios in the nightly sync → G15 tiles | Server-side, so the scan, web app and extension all gain |
| 4 — coverage | G9 provisional TV-data card for stocks outside the universe, G4 labels on top of watchlists | |
| 5 — US | G16 US financials colouring; G17 only if you want US P/E history | Feeds the open US phase 3 design |
| Decide | G10 editable scoring thresholds (server-side PUT or not) | Changes the scan's output, so it is your call |

---

## 7. HIFY bugs not to copy

- Missing data is scored amber, and amber counts as a pass, so a stock with no data scores **11/11 All-Star**.
- "10Y peak" sales and PAT use every column, including TTM.
- Two rules are labelled "5-Yr Median" (P/S, EV/EBITDA) but use fixed thresholds.
- The Screener script calls the licence check on every DOM change.
- On stockanalysis.com and roic.ai, colours stack and are never cleared, and the scan reruns on every scroll.
- Banks' net interest income gets the cost colouring.
- Focus Mode closes any dialog whose text contains "notice" or "trial".
- Space and the arrow keys are swallowed from TradingView while the panel is open. Ours is already opt-in.
