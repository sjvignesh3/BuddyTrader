# Plutus Companion v0.3 → v0.6: implementation plan

> **Date:** 2026-11-20 · **Revision 2:** 2026-11-21 (your notes from the HIFY walkthrough video and six screenshots, §0A)
> **Based on:** `Docs/Plutus_Extension_Gap_Analysis_v1.8.3.MD` (gaps G1–G23)
> **Starting point:** Plutus Companion v0.2.1 (`extension/`), FastAPI routes in `plutus/api/extension.py` and `plutus/api/watchlists.py`
> **Test data:** cloud backup `plutus-backup-2026-11-20_081045.zip`, restored into the **local** stack only (§1)

---

## 0. Decisions: defaults assumed by this plan

| # | Decision | Default in this plan | Alternative |
|---|---|---|---|
| D1 | Live row prices from TradingView's scanner endpoint, which is unofficial | **Yes**, behind a popup toggle (on by default). On error it falls back to the nightly close | No live prices |
| D2 | How labels are stored | **Watchlists plus a colour column.** A label is a watchlist; one stock can sit in many | A separate `stock_labels` tags table |
| D3 | Editing scoring thresholds from the UI (G10) | **Not in this plan.** Parked | Owner-only `PUT /api/strategy_configs` plus a web-app form |
| D4 | Third-party US sites (revised 2026-11-21) | **vcpscanner.com, stockresearch.app, stockanalysis.com and roic.ai**: the same four sites HIFY covers (phase 5) | Fewer sites |
| D5 | Card for stocks outside the universe, from TradingView data (G9) | **Yes**, clearly labelled "TV data · provisional", never fed into the Plutus score | Show "not in Plutus" only |

Changing a decision only affects the phase that uses it.

---

## 0A. Revision 2: your video notes, checked against the HIFY code

| # | What you saw | What the code actually does | In this plan |
|---|---|---|---|
| 1 | Focus Mode removes ads and lets you add more than 2 indicators | Focus Mode is about 95 lines (`content.js:10231-10326`) plus a CSS block (2826-2839). It **only hides and auto-closes** TradingView's upgrade dialogs, toasts and banners. There is no code that adds indicators or touches TradingView's indicator limit. If more indicators stayed on the chart in the video, that is a side effect of the "upgrade" dialog being closed, or of that account or chart layout; I could not confirm it from the code | Our Focus mode already does the same hiding. I will **not** build anything aimed at getting past TradingView's plan limits. The supported way to get more on a free plan is one combined Pine indicator that draws several lines (your `HIFYIndicator` folder is that idea) |
| 2 | Sortable list | Clickable column headers plus a 17-option "Sort by" dropdown (Top Gainers, Losers, …) | **F3**, with "Top gainers (Chg %)" and "Top losers" added once live prices exist (F7) |
| 3 | Price syncs once a minute | Faster than that: a **10-second** poll while the tab is visible, with results reused for 30 s. Source: TradingView's scanner endpoint (`scanner.tradingview.com/india/scan`), price columns for the visible list | **F7**. Refresh interval is a popup setting: 15 s (default) / 30 s / 60 s. The price is fetched by the extension in your browser, not by the Plutus server |
| 4 | Hovering a row shows the whole fundamentals in a box | A plain tooltip built from their browser-side score: 11 Must-Have lines, 7 "boosters", watchouts | **F17 (new)**: a hover card with the **Plutus** 11 checks (pass / fail / n/a with the detail text), signal, DMA / 52-week / ATH distances and the held position |
| 5 | Labels | Coloured tags, popover with checkboxes, label slicer | **F13** (unchanged) |
| 6 | Separate India and US views | Region toggle that swaps lists, slicers and labels | **F1** (unchanged) |
| 7 | Sort by top gainers / losers per day | Dropdown in the drawer | **F3 + F7** |
| 8 | New watchlist from the Filters section | Watchlist admin block in the drawer | Moved into the drawer's Filters tab (**F18**); the functions already exist in our panel |
| 9 | Fundamental filters narrow the list on the right | Chips hide stocks that fail the chosen rule | **F8**; ours treats "no data" as not passing |
| 10 | Drawer with 4 sections; Fundamentals, Trade Log and Notes follow the selected stock | Fundamentals and Notes work. **Their Trade Log is an empty placeholder** (static sample values, no logic) | **F18 (new)** drawer with 4 tabs: Filters · Fundamentals (F9) · **Trades (F19, new, real journal data)** · Notes (F4) |
| 11 | US sites highlighted like Screener (stockresearch, vcpscanner, roic) | Three content scripts doing page-only colouring. Screenshot 6 is vcpscanner.com; screenshot 5 is stockresearch.app with three added P/E tiles | **F15, F20, F21** (phase 5, D4 revised) |

**On reusing their source code for the highlighting:** I will re-implement the same rules in our own shared colouring module, not copy their files, which is how v0.2 was built. Three reasons:
- Their code is a paid product's code.
- It carries their names, licence checks and known bugs (colours stack and never clear; a bank's interest income is coloured as a cost).
- The rules themselves are simple and are written down in the gap analysis. Our Screener colouring already implements most of them.

The one part of their US code that is excluded is the unlock of StockAnalysis' paid "Full Width" button.

---

## 0B. Status (2026-11-21)

| Phase | Version | Status |
|---|---|---|
| 1 Quick wins + drawer shell | 0.3.0 | built, committed (`extension-v0.3` 585fe6b), running on the user's chart |
| 2 Live prices, chips, dossier, hover card, Trades tab | 0.4.0 – 0.4.2 | built, committed (5bf4ad2, 335e402 token diagnostics, c241b47 drawer polish) |
| 3 P/E medians + valuation box | 0.5.0 | built: `screener_client.pe_stats` from the existing chart request, migration **029** (+ same columns appended to 004), registry fields, `derived` block in `/api/extension/stock`, card valuation box, Screener synthetic tiles. **F11 narrowed:** interest coverage and Net Debt/EBITDA are *not* derivable from stored data (interest, borrowings and cash are not stored); shipped instead: P/S, market cap / EBITDA, P/E vs medians, P/B vs 5Y avg. Those two ratios need the quarterly parser to read the P&L / balance-sheet rows — a later item |
| 4 Labels + provisional card | 0.6.0 | built: migration **028** (`watchlists.color`), `/api/watchlists` accepts `color`, label popover (`🏷` / `L`), row dots, label slicer, colour swatches in the list dialogs; provisional TradingView card for stocks outside the universe (`live.fundamentals`, 1 h cache) with Add to PlayArea / Sync now |
| 5 US sites | 0.6.1 | built: `shared/table_colour.js` (Screener rules, Node-tested), `us/us_sites.js` on stockanalysis.com, roic.ai (paired label / value tables), vcpscanner.com, plus stockresearch.app P/E tiles (3Y median, 3Y / 10Y low–high) from the page's own series; pill with colours toggle, TradingView / Plutus links, N note. No paywall interaction (G19 excluded). Verified on a stockanalysis-style harness page; not yet on the live sites |

## 1. Local test environment from the 2026-11-20 backup

### 1.1 Where the data lives

| Item | Path (git-ignored via `UserData/backups/`) |
|---|---|
| Original ZIP (copy) | `UserData/backups/plutus-backup-2026-11-20_081045.zip` (the original is still at `D:\Tools\Plutus\`) |
| Restore set | `UserData/backups/2026-11-20_081045/restore/` (manifest plus 22 JSON tables) |

It was validated offline with `personal.load_backup`: format 1, created 2026-11-20 08:10 UTC from the cloud project. Row counts:

| Group | Tables (rows) | Used by the extension for |
|---|---|---|
| universe | pools 5 (F40, E40, S200, PlayArea, USMEGA), stocks 476 | pools, the IN/US switch, sector views |
| journal | trades 99, opportunities 28, stock notes 23, settings 1, sizing plans 0, IPO 2 + 2, notebook 4 | held strip, sizer capital, notes timeline, opportunities |
| watchlists | watchlists 4 (S1–S4) | lists, labels (D2) |
| expenses / networth | 76 expenses, 10 assets, … | **not needed**; leave them out of the restore |

**The backup has no market data:** no snapshots, no scan results, no fundamentals. Those are filled by running the syncs locally (step 5 below).

### 1.2 One-time setup

> ⚠ `plutus/.env` currently points at the **cloud** project (`qgwjitudbaxdqxypqhwd.supabase.co`). Real environment variables override `.env` (`plutus/config.py` loads it with `override=False`), so set the local URL and key **in the shell** for every local command. Read the `target` line that `restore_personal` prints, and only add `--yes` when it says `127.0.0.1:56321`.

```powershell
supabase start
```

```powershell
$env:PLUTUS_SUPABASE_URL = "http://127.0.0.1:56321"; $env:PLUTUS_SUPABASE_SERVICE_KEY = "<service_role key from supabase start>"
```

1. Apply the migrations `001`–`027` (and, as each phase lands, `028`/`029`) to the local DB on port 56322, as in runbook §4.4. Migrations 025–027 are still pending locally, and `pools.json` carries the `market` column from 026.
2. Do a dry run (writes nothing; check that the target is local):

```powershell
.venv\Scripts\python.exe -m plutus.scripts.restore_personal UserData/backups/2026-11-20_081045/restore --tables universe,journal,watchlists --dry-run
```

3. Restore (same command with `--yes` instead of `--dry-run`).
4. Fill in market data for the restored universe:

```powershell
.venv\Scripts\python.exe -m plutus.scripts.run_daily_sync --market IN
```

```powershell
.venv\Scripts\python.exe -m plutus.scripts.run_daily_sync --market US
```

```powershell
.venv\Scripts\python.exe -m plutus.scripts.run_quarterly_sync --pool F40
```

```powershell
.venv\Scripts\python.exe -m plutus.scripts.run_scan --pool ALL
```

```powershell
.venv\Scripts\python.exe -m plutus.scripts.run_scan --pool ALL --market US
```

   The quarterly sync needs the Screener login in `.env`; F40 is enough for testing. Add `--pool E40` / `S200` if needed.
5. Start the API (`python -m plutus.scripts.run_api`, port 8787) and the web app (5173). Load `extension/` unpacked. In the popup, set the API URL to `http://127.0.0.1:8787` and sign in on `localhost:5173` so the bridge picks up the token.

### 1.3 Test fixtures for each phase

| Phase | What the backup gives it |
|---|---|
| 1 | IN and US pools for the region switch; the sectors on 476 stocks; 23 notes across several symbols for the timeline |
| 2 | Scan results for F40 (after `run_scan`) for chips and the dossier; prices for every pool symbol |
| 3 | F40 fundamentals with the new P/E medians, after re-running the quarterly sync with the new code |
| 4 | S1–S4 to turn into coloured labels; symbols outside the universe (any chart that is not a pool stock) for the provisional card |
| 5 | USMEGA tickers (for example NVDA) for stockanalysis.com and roic.ai pages |

Automated tests never touch the backup. They keep their existing in-memory fakes (`plutus/tests/test_api_extension.py`, `extension/tests/background.test.js`). The backup is only for manual and browser checks.

---

## 2. Feature list

| ID | Feature | Gap | Phase | Backend | Migration |
|---|---|---|---|---|---|
| F1 | IN / US region switch in the TV panel | G5 | 1 | — | — |
| F2 | Sector / industry views and a sector slicer | G6 | 1 | — | — |
| F3 | Sortable column headers and new sort modes | G2 | 1 | — | — |
| F4 | Notes timeline tab (list, edit, delete, Ctrl+Enter) | G11 | 1 | — (routes exist) | — |
| F5 | Token bridge on the deployed web app origin | G12 | 1 | — | — |
| F6 | US cap tier chip (Mega / Large / Mid / Small) | G13 | 1 | — | — |
| F7 | Live prices in rows (Last, Chg, Chg%, live %200D / %52wH / %ATH, flash) | G1 | 2 | — | — |
| F8 | Per-rule filter chips and 11/11 "all pass" filter | G3 | 2 | `extension.py` bootstrap adds `checks` | — |
| F9 | Stock dossier drawer on the chart (Plutus card on TradingView) | G7 | 2 | — (uses `/api/extension/stock`) | — |
| F10 | 3Y / 5Y / 10Y **median** P/E (plus 10Y low/high) in the nightly fundamentals | G8 | 3 | `screener_client.py`, fundamentals writer | **029** |
| F11 | Extra ratios in the dossier and on Screener: interest coverage, Net Debt/EBITDA, EV/EBITDA | G8 | 3 | `extension.py` computes them from stored fundamentals | — |
| F12 | Synthetic Screener tiles for the new medians | G15 | 3 | — | — |
| F13 | Labels: coloured watchlists, 🏷 popover on rows, label slicer | G4 | 4 | `watchlists.py` accepts `color` | **028** |
| F14 | Provisional "TV data" card for stocks outside the universe, plus "Add to PlayArea and sync" | G9 | 4 | — | — |
| F15 | US income-statement colouring on stockanalysis.com and roic.ai | G16 | 5 | — | — |
| F16 | TradingView ↔ US-site links for US stocks (the Screener toolbar equivalent) | G16 | 5 | — | — |
| F17 | **Row hover card**: Plutus 11 checks, signal, distances, held position | video #4 | 2 | — (uses F8 `checks`) | — |
| F18 | **4-tab drawer** that follows the selected stock: Filters · Fundamentals · Trades · Notes; watchlist admin in Filters | video #8, #10 | 1 (shell + Notes), 2 (rest) | — | — |
| F19 | **Trades tab**: open lots, closed trades, opportunities and sizing plans for the selected stock | video #10 | 2 | — (journal routes exist) | — |
| F20 | **vcpscanner.com** statement colouring (income statement, balance sheet, ratios) and toolbar | G18 | 5 | — | — |
| F21 | **stockresearch.app** extra P/E tiles: 3-year median, 3-year and 10-year low–high | G17 | 5 | — | — |

**Not built:** G10 (thresholds UI, D3), G14 (Screener ingest, kept in the old phase 4), anything that gets past TradingView's indicator limit (§0A #1), G19–G23 (paywall bypass, licensing, Drive sync, their curated lists).

---

## 3. Phases

### Phase 1: quick wins → **v0.3.0** (no backend changes)

| Feature | Changes |
|---|---|
| **F1 region switch** | `tv/tv_content.js`: a 🇮🇳 / 🇺🇸 segmented control in the panel header. `renderSelect` filters pools and watchlists by market (a pool by its `market`; a watchlist by the market of most of its symbols, or "both" when empty). Switching resets the cap / sector slicers and selects the first list for that market. The choice is stored in `settings` (`tvRegion`). The cap slicer shows Mega / Large / Mid / Small for US (F6) |
| **F2 sector views** | `tv/tv_content.js`: a sector slicer row under the cap slicer, a dropdown of the active list's sectors with counts. India uses `sector_group` when present (Banks, NBFC…), otherwise `sector`; US uses `sector`. An optgroup "Sectors" adds virtual lists `SECTOR:<name>` built from bootstrap stocks of the current region. Read-only; no add / remove |
| **F3 sorting** | `tv/tv_content.js`: a header row above the list with clickable columns: Symbol, Last, Chg%, 200D, 52wH, ATH, Score. ▲/▼ state is saved as `tvSort` + `tvSortDir`. New `rankValue` keys: `chg`, `high52`, `pe`, `mcap`. The popup's default-sort select gets the same keys |
| **F4 notes timeline** | `background.js`: add `notes.update` and `notes.delete` messages (PUT / DELETE `/api/journal/notes/{id}`). `tv/tv_content.js`: a new "Notes" view in a side drawer (built here, reused by F9) listing every note for the active symbol, newest first, with inline edit, delete (confirm), and add with a date (Ctrl+Enter). It follows the chart symbol. The Screener note dialog gets a "see all" link that opens the same list in a dialog |
| **F5 deployed token bridge** | `manifest.json`: `"optional_host_permissions": ["https://*/*"]`. `popup/popup.js`: when Web app URL is saved and is not localhost, call `chrome.permissions.request({origins:[origin+'/*']})`. `background.js`: on start and on settings change, `chrome.scripting.registerContentScripts([{id:'plutus-token-bridge', matches:[origin+'/*'], js:['shared/settings.js','webapp/token_bridge.js']}])`, unregistering the old id first. `token_bridge.js`: drop the comment that says production is unsupported |
| **F6 US cap chip** | `tv/tv_content.js` row render: for US, the tier comes from `market_cap` (Mega ≥ $200B, Large ≥ $10B, Mid ≥ $2B, else Small). **Display only**; sizing still treats US as Large |

**F18 drawer shell (phase 1 part):** the side drawer is built in this phase with the tab bar (Filters · Fundamentals · Trades · Notes) and a "1 of 4" pager. It opens to the left of the panel and follows the chart symbol. Notes is live in this phase; Filters holds the sort dropdown, the sector slicer and the watchlist admin buttons (New / Rename / Delete / Reload, moved from the panel footer). Fundamentals and Trades show "coming in v0.4" until phase 2.

**Tests**
- `extension/tests/background.test.js`: notes update / delete message routing; bridge registration picks the saved origin and skips localhost.
- A new `extension/tests/panel_logic.test.js`: pure helpers moved into `shared/panel_logic.js` (region filter, sector grouping, sort comparator, US tier) so they can be tested in Node.

**Manual check (backup data):**
- The US switch shows only USMEGA and US watchlists.
- The sector slicer counts add up to the list size.
- Notes for a restored symbol list all entries; edit and delete persist after reload.

### Phase 2: live data and chart dossier → **v0.4.0**

| Feature | Changes |
|---|---|
| **F7 live prices** | **New** `shared/tvscan.js` (worker side), used by `background.js` handler `tvscan.quotes {symbols}`: POST `https://scanner.tradingview.com/{india\|america}/scan` with body `{"symbols":{"tickers":[…]},"columns":["close","change","change_abs"]}`. Tickers come from `PlutusSymbols.toTradingView`. Batches of 200, one region per request, a 10 s cache per symbol. On HTTP 429 or a failure it backs off exponentially (15 s → 2 min) and reports `degraded`. `tv/tv_content.js`: polls the **visible rows only**, every 15 s, while `document.visibilityState === 'visible'`. It patches Last / Chg% cells in place with a 600 ms flash class, and recomputes `below_200dma_pct`, `distance_from_52w_high_pct` and `fall_from_ath_pct` from the live price against the bootstrap `dma_200` / `high_52w` / `ath` (a Plutus level with a live price). When the feed is degraded, a small "live ⏸" pill appears in the as-of stamp and rows show the nightly close. Popup toggle `tvLivePrices` and interval `tvLiveIntervalSec` (15 / 30 / 60). Sort modes "Top gainers" and "Top losers" use the live Chg %. No numbers are written anywhere |
| **F8 filter chips** | **Backend:** in `plutus/api/extension.py`, `stock_entry` adds `checks: {id: true\|false\|null}` from the fundamental result's `metrics_snapshot.checks` (helper `funda_checks(results)`), plus a top-level `check_labels: {id: label}` in bootstrap. Size: about 11 small entries per stock, roughly +25 KB for 476 stocks. **Extension:** a chip row in the drawer's "Filters" view, one chip per check id seen in the list; lender ids (`gnpa`, `nnpa`, `roa`) appear only when lender stocks are present. Each chip has 3 states: off / must-pass / must-not-fail (null allowed). ⭐ "all pass" = every check `true`; **n/a never counts as a pass**. Chip state is per tab, with a dot on the drawer button when any is active |
| **F9 chart dossier** | Move the Screener card builder out of `screener/screener_content.js` (`buildCard`, `kv`, `positionFor`, gauge helpers) into **new** `shared/card.js`, which both sites load. `tv/tv_content.js`: a drawer view "Stock", opened with `D` or the ⓘ button, that renders `card.js` for the chart symbol from `getStock` (already cached in the worker), re-rendering on symbol change with a 250 ms debounce. It adds a "Screener ↗" button and keeps the Note / Opportunity / PlayArea / Size buttons. It fills the drawer's Fundamentals tab from F18 |
| **F17 row hover card** | `tv/tv_content.js`: hovering a row for 400 ms shows a card (our own element, not a `title` tooltip) built from bootstrap data only, so there is no network call per hover: score `n/11` with n/a count, one line per check (🟢 pass / 🔴 fail / ⚪ n/a + label) from F8's `checks` and `check_labels`, the technical signal, live or nightly price, % from 200 DMA / 52-week high / ATH, cap, sector, and the HELD line when a position is open. The detail text for each check (the actual value) needs `/api/extension/stock`, so the card shows pass/fail immediately and fills in values if the worker has that stock cached |
| **F19 Trades tab** | `background.js`: `trades.forSymbol {symbol}` → `GET /api/journal/trades?symbol=` (open and closed) and `GET /api/journal/opportunities` filtered to the symbol; sizing plans from `/api/sizing/plans`. `tv/tv_content.js`: the Trades tab shows open lots (date, qty @ price, live P&L, target / stop), closed trades (buy → sell, P&L, days held), active opportunities, and buttons for Size (`Z`) and Opportunity (`O`). Needs the session token; shows the usual "token needed" hint otherwise |

**Tests**
- `plutus/tests/test_api_extension.py`:
  - `funda_checks` maps passed True/False/None, and handles a missing result.
  - Bootstrap includes `checks` and `check_labels`.
  - A lender stock carries lender ids.
- `background.test.js`:
  - tvscan batching and region split.
  - 429 back-off.
  - The cache hit within 10 s.
  - Tests use a fake `fetch`.
- `panel_logic.test.js`: chip filtering, including that null fails "must-pass" and passes "must-not-fail".
- The Screener card still renders: open the saved RELIANCE page fixture used in v0.2.

**Manual check:**
- Prices tick during market hours. When the network is blocked for `scanner.tradingview.com`, the panel falls back without errors.
- The ⭐ filter hides stocks with any n/a.
- The dossier matches the Screener card for the same stock.

### Phase 3: valuation depth → **v0.5.0** (server side)

| Feature | Changes |
|---|---|
| **F10 P/E medians** | `plutus/fundamentals/screener_client.py`: `_chart_avg` already downloads **10 years** (`days=3650`) to compute the 5-year average. Refactor it into `_chart_series(cid, metric)` and derive `pe_median_3y`, `pe_median_5y`, `pe_median_10y`, `pe_low_10y` and `pe_high_10y` from the **same response**, so there are no extra Screener requests. Keep `pe_5yr_avg` as is (the fundamental check uses it). **Migration `029_fundamentals_pe_medians.sql`:** five `NUMERIC(10,2)` columns, nullable. Thread them through the fundamentals writer and `repository.latest_fundamentals`. Edge Function: no change (extension routes are FastAPI-only) |
| **F11 extra ratios** | `plutus/api/extension.py`: the stock route adds `derived: {interest_coverage, net_debt_to_ebitda, ev_to_ebitda}`, computed with `Decimal` from stored fundamentals (operating profit / interest from the latest quarters' TTM; net debt from borrowings − cash; EV = market cap + net debt). `null` when an input is missing; strings on the wire like other money values. Shown in the dossier and the Screener card under a "Valuation" block, coloured with `default_thresholds()` additions (`interest_coverage_min` 3, `net_debt_ebitda_max` 2.5, `ev_ebitda_max` 15), **display only**, not scored |
| **F12 Screener tiles** | `screener/screener_content.js` `injectSyntheticTiles`: add "Median PE 3Y / 10Y" and "PE 10Y range" when Screener does not show them. Colour: green when the current P/E is below the median |

**Tests**
- `screener_client` unit tests with a recorded chart JSON:
  - median and low/high correct for odd and even counts;
  - the 3Y window cut-off is right;
  - empty datasets return `None`.
- Extension route test: `derived` values on a fake fundamentals row, and nulls when inputs are missing.
- The migration applies cleanly on the local stack after 027.

**Deploy order:** migration 029 can go **before** the backend; nullable columns are harmless to the old code. Run the quarterly sync once after deploying to fill them.

### Phase 4: labels and coverage → **v0.6.0**

| Feature | Changes |
|---|---|
| **F13 labels (D2)** | **Migration `028_watchlist_color.sql`:** `ALTER TABLE watchlists ADD COLUMN color TEXT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$')`. `plutus/api/watchlists.py`: `color` is optional on create / patch and returned on list. Add it to `personal.TABLES` serialisation if columns are listed explicitly; backups must keep it. `background.js`: pass `color` through, and keep local fallback lists the same shape. `tv/tv_content.js`: a 🏷 button on each row opens a popover of every watchlist with checkboxes (checked = the stock is in it), toggling `watchlist.add` / `watchlist.remove`, plus "+ new label" with a 7-swatch palette. Rows show a coloured dot per list they belong to (up to 3, then "+n"). A slicer row of label dots filters the current list to stocks in the chosen label. No "Holding" label: the HELD chip already comes from the journal |
| **F14 provisional card (D5)** | `tvscan.fundamentals {symbol}` in the worker: one scanner request with about 25 columns (close, SMA200, 52-week high/low, ATH, market cap, P/E, P/B, ROE, ROIC, D/E, operating margin, net margin, revenue YoY, net income YoY, EPS, dividend yield, sector, industry), cached for 1 h. When `getStock` returns 404 (not in Plutus), the Stock view renders a **grey "TV data · provisional"** card: cap tier from market cap, 200 DMA / 52-week / ATH distances, ratio table **uncoloured**, and **no score**. Buttons: "Add to PlayArea" (existing) and "Sync now" (existing `triggerSync`, admin token) |

**Tests**
- Watchlist API:
  - colour accepted, round-trip, rejected when it isn't hex;
  - a null colour leaves the old behaviour unchanged.
- Backup / restore round trip keeps `color`.
- `background.test.js`: the provisional fetch is used only on a 404, with a 1 h cache.

**Deploy order:** **migration 028 before the backend.** The new backend selects `color`, so the old backend is unaffected by an extra column.

### Phase 5: US financials sites → **v0.6.x**

| Feature | Changes |
|---|---|
| **F15 US statement colouring** | **New** `us/us_financials.js` + `us/us.css`, on `https://stockanalysis.com/stocks/*` and `https://roic.ai/*` (new `host_permissions` and `content_scripts` entries). It reuses the colouring core extracted from `screener_content.js` into **new** `shared/table_colour.js`: period parser, prior-column map, expense % of revenue, reverse rows, row best / worst, outlier fence. Site adapters find the tables (StockAnalysis `#main-table`; roic.ai label/value split tables). Fixes over HIFY: **clear before re-colouring**, a MutationObserver with a 200 ms debounce (no scroll hook), bank "net interest income" excluded from reverse rows, and an on/off pill that removes the colours without a reload. **No paywall changes of any kind** (G19) |
| **F20 vcpscanner.com** | **New** `us/vcpscanner.js` on `https://vcpscanner.com/stock/*`, using `shared/table_colour.js` with a site adapter. Rules, matching what your screenshot 6 shows: growth % rows (≥ 20 % dark green, > 0 light green, < 0 light red, ≤ −15 % dark red); margin rows (row peak dark green, up light green, down light red); expense-% rows (lowest dark green, highest dark red, fell yellow, rose light red); revenue / profit rows (row peak dark green, above prior light green); debt rows (zero debt and lowest green, highest red); fixed bands for current ratio, quick ratio and interest coverage. Quarterly pages compare with the same quarter last year. Toolbar: TradingView, Plutus, Note, on/off |
| **F21 stockresearch.app** | **New** `us/stockresearch.js` on `https://stockresearch.app/stocks/*`: reads the page's own embedded weekly P/E series, computes the 3-year median and the 3-year and 10-year low–high, and adds three tiles next to the site's "10-year median" tile (as in your screenshot 5), each marked with a small Plutus badge. This depends on the site's internal data format, so the script does nothing, silently, when the series is not found |
| **F16 US cross-links** | A small toolbar pill on the US pages with buttons for TradingView (`NASDAQ:NVDA` via `PlutusSymbols.toTradingView`), the Plutus stock page, Note and PlayArea. In the TV panel, US stocks get "Financials ↗" (stockanalysis) where Indian ones get "Screener ↗" (`S` key) |

**Tests**
- `table_colour` unit tests on header and number fixtures: `(1.2B)`, `$3.4M`, `Q3 2025`, `FY2024`, TTM.
- Screener colouring has no regressions: the same RELIANCE fixture renders the same classes before and after the extraction.

---

## 4. Change list by file

| File | Phase | Change |
|---|---|---|
| `extension/manifest.json` | 1, 5 | `optional_host_permissions`; stockanalysis / roic / vcpscanner / stockresearch hosts and content scripts; version bumps 0.3.0 → 0.6.x |
| `extension/background.js` | 1, 2, 4 | `notes.update` / `notes.delete`; dynamic bridge registration; `tvscan.quotes` / `tvscan.fundamentals` handlers; pass watchlist `color` through |
| `extension/shared/tvscan.js` **new** | 2 | scanner client: batching, region split, cache, back-off |
| `extension/shared/panel_logic.js` **new** | 1 | pure helpers: region filter, sector groups, sort, US tier, chip filter |
| `extension/shared/card.js` **new** | 2 | Plutus stock card shared by Screener and the TV dossier |
| `extension/shared/table_colour.js` **new** | 5 | colouring core shared by Screener and the US sites |
| `extension/tv/tv_content.js` + `tv.css` | 1, 2, 4 | region switch, sector slicer, sortable header, drawer (Stock / Filters / Notes), live cells, chips, label popover and dots, provisional card |
| `extension/screener/screener_content.js` + css | 2, 3, 5 | use `card.js` and `table_colour.js`; median tiles; "see all notes" |
| `extension/us/us_financials.js`, `us/vcpscanner.js`, `us/stockresearch.js` + `us.css` **new** | 5 | US statement colouring, P/E tiles and toolbars |
| `extension/popup/*` | 1, 2 | web-app origin permission request; `tvLivePrices`, `tvRegion`, sort direction settings |
| `extension/shared/settings.js` | 1, 2 | new defaults: `tvRegion`, `tvSortDir`, `tvLivePrices` |
| `extension/tests/*` | 1–5 | `background.test.js` additions; new `panel_logic.test.js`, `table_colour.test.js` |
| `extension/README.md` | each | feature docs and the new hosts |
| `plutus/api/extension.py` | 2, 3 | `funda_checks`, `check_labels`; `derived` ratios; threshold additions |
| `plutus/api/watchlists.py` | 4 | `color` field |
| `plutus/fundamentals/screener_client.py` | 3 | `_chart_series`; P/E medians and range from one request |
| fundamentals writer + `plutus/repository.py` | 3 | new columns through write and read paths |
| `plutus/backup/personal.py` | 4 | confirm `watchlists.color` is exported and restored |
| `plutus/migrations/028_watchlist_color.sql` **new** | 4 | colour column |
| `plutus/migrations/029_fundamentals_pe_medians.sql` **new** | 3 | five P/E columns |
| `plutus/tests/test_api_extension.py`, watchlist and screener tests | 2–4 | as listed per phase |
| `.github/workflows/plutus-tests.yml` | 1 | run the new extension Node tests in the existing `web-and-extension` job |

Migration numbers: 028 and 029 are the next free numbers after `027_journal_markets.sql`. If phase 3 ships before phase 4, keep the numbers anyway; they are independent.

---

## 5. Guardrails (unchanged from v0.2)

- Internal symbol form stays `TCS.NS` / `NVDA`; convert at the edges with `shared/symbols.js`.
- The service worker is the only code that does network calls (the Plutus API and the TradingView scanner).
- Money and ratio values from Plutus stay strings until display. Live scanner numbers are **display only**: never written to Plutus, never part of the score.
- One threshold source (`strategy_configs` / `default_thresholds()`); popup overrides affect colouring only.
- All DOM ids / classes / storage keys are prefixed `px-` / `plutus_`. No vendor names in code.
- Each phase ends with:
  - the Python tests and extension Node tests green;
  - a manual pass on the local stack with the backup data;
  - README updated;
  - the version bumped.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| The scanner endpoint changes or rate-limits | Visible-rows-only polling every 15 s; back-off; a "live ⏸" indicator; one toggle turns it off; the panel works fully without it |
| TradingView DOM changes break the drawer position | The drawer is attached to our own panel, not to TradingView elements; selectors stay in the `TV` object |
| Restoring into the wrong database | Shell-only local env; the restore prints the target; `--dry-run` first; restore only the `universe,journal,watchlists` groups |
| Larger bootstrap payload (F8) | Compact `checks` map (about +25 KB); the existing 12 h cache keyed on `snapshot_date` |
| The shared-code refactors (`card.js`, `table_colour.js`) regress Screener | Fixture-based snapshot comparison of the RELIANCE page before and after |

---

## 7. Effort estimate

| Phase | Version | Size |
|---|---|---|
| 1 Quick wins and drawer shell | 0.3.0 | ~1.5–2 days |
| 2 Live data, chips, dossier, hover card, Trades tab | 0.4.0 | ~3–4 days |
| 3 P/E medians and ratios | 0.5.0 | ~1–1.5 days |
| 4 Labels and provisional card | 0.6.0 | ~1.5–2 days |
| 5 US financial sites (four sites) | 0.6.x | ~2.5–3 days |
