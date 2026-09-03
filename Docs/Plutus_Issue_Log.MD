# Plutus — Issue Log & Fix Tracker

> **Created:** 2026-08-31 · Full implementation audit against `Plutus_Plan.MD` / `Plutus_Phased_Development.MD` / `Plutus_Local_and_Live_Runbook.md`, followed by fixes and a complete local E2E validation.
> **Headline:** the 391-test suite was green, but the system had **never worked end-to-end against a real database** — every DB write path failed on first live contact. All blocking issues below are now fixed and validated locally.

---

## 1. CRITICAL — fixed & validated

| # | Issue | Where | Fix |
|---|-------|-------|-----|
| C1 | `bulk_upsert` sent `Decimal`/`date` objects to PostgREST → `TypeError`, every snapshot/fundamentals write failed (tests used fakes, so invisible) | `plutus/adapters/supabase_client.py` | JSON-safe coercion at the write boundary: Decimal→string, date→ISO |
| C2 | `daily_snapshots.stock_id` / `fundamentals.stock_id` were `NOT NULL` but no worker ever supplies them → NOT NULL violation on every insert | migrations 003/004 | `stock_id` nullable (matches Plan §5.3/§5.4); idempotent `ALTER` added |
| C3 | Quarterly upsert conflicts on `(symbol, quarter_end_date)` but no matching unique index existed → 42P10 on every quarterly write | migration 004 | `ux_fund_symbol_quarter` unique index added |
| C4 | `seed_universe` read the wrong CSV columns: the all-listed "Ticker" dump (4831 rows) + the strategy×pool marker matrix → wrong universe, wrong pools, no sectors | `plutus/scripts/seed_universe.py` | Rewritten to parse the curated LEFT table (cols 0–5, same as legacy `backend/app/core/universe.py`); pools merge across duplicate rows. Seeds **442** stocks |
| C5 | Nightly cron scan ran `--pool ALL` which matched nothing → silent empty scan every weekday | `plutus/scripts/run_scan.py` | `--pool ALL` now fans out over F40/E40/S200/PlayArea; empty pools are skipped with a warning, exit 2 only if *no* pool scanned |
| C6 | Edge Function 404'd every route in production (wrong mount-prefix stripping for `https://<ref>.functions.supabase.co/plutus-api/...`) | `supabase/functions/plutus-api/index.ts` | Routes on the first `/api/` segment; health served at all root forms |
| C7 | `MONEY_KEYS` in the Edge Function named columns that don't exist (`pe`, `market_cap_cr`, `ath_price`, …) → ~20 money fields shipped as raw JS numbers; the test gating it asserted the same wrong names | `index.ts` + `test_deployment_config.py` | Replaced with the 41 real NUMERIC column names; test now asserts real names and rejects stale ones |
| C8 | FastAPI never stringified live money values (PostgREST NUMERIC → float passed through); scan engine and canary **refused** floats: every strategy returned ERROR, canary reported "missing" (reproduced live before fixing) | `plutus/api/serializers.py`, `plutus/scan/engine.py`, `plutus/canary/runner.py` | Float→Decimal/string conversion at every read boundary (shortest-repr round-trip is exact for our NUMERIC scales) |
| C9 | **ATH & 200-DMA computed on unadjusted prices** — `Adj Close` was fetched then thrown away; `adj_close` column stored the live quote. Any split/bonus in 5y inflated ATH N× and poisoned DMA/envelope signals | `plutus/metrics/rally.py` (OHLCVBar), `plutus/sync/history_builder.py`, `plutus/metrics/pipeline.py` | `OHLCVBar` carries `adj_close` + `volume`; DMA/ATH/trend computed on adjusted series; real `Adj Close` stored |
| C10 | `pilot_fetch` crashed on any real DataFrame (broken dead loop) | `plutus/scripts/pilot_fetch.py` | Dead loop removed |
| C11 | Newer Supabase (cloud + CLI) no longer auto-grants table privileges → 42501 "permission denied" for both anon and service_role on every request (reproduced live) | migrations 010/011 | Explicit `GRANT`s for anon (read) / service_role (all) + sequences + views |
| C12 | `postgrest<0.20` pin incompatible with `supabase>=2.15` → every live client call raised `TypeError: unexpected keyword 'http_client'` (reproduced live) | `plutus/requirements.txt` | Pin relaxed to `postgrest<2.0` |
| C13 | `pandas.Timestamp` leaked through `_coerce_date` (Timestamp subclasses `date`) → every live sync failed on date comparison (reproduced live) | `plutus/sync/history_builder.py` | Proper Timestamp→date normalisation |

## 2. MAJOR — fixed & validated

| # | Issue | Fix |
|---|-------|-----|
| M1 | `plutus/.env` was documented + `python-dotenv` pinned, but **nothing ever loaded it** — every CLI needed manually exported env vars | `config.py` loads `plutus/.env` / repo `.env` (env vars always win; `PLUTUS_SKIP_DOTENV=1` for tests) |
| M2 | Views ran as owner (no `security_invoker`) → anon could read `trades` open-position counts through `v_stocks_latest`, bypassing RLS | `security_invoker=true` on both views (009) |
| M3 | `v_stocks_latest` joined on `ds.stock_id = s.id` which is never populated → view returned no snapshot data; `v_fundamentals_latest` keyed on nullable `stock_id` (all NULLs collapse to one row) | Both views join/key by `symbol` |
| M4 | `--as-of` was ignored: pipeline used the newest bar + overwrote `close` with the LIVE quote → backfills wrote today's prices under past dates, mixing sessions and poisoning canaries | Pipeline filters bars to `d <= snapshot_date`; session bar close is canonical, live quote only a fallback |
| M5 | A short history (<200 bars) produced a fake "200-DMA" indistinguishable from a real one and fed the envelope BUY_ZONE gate | Pipeline returns `dma_200=None` + error entry below 200 bars |
| M6 | `?pool=&limit=` truncated before filtering in both APIs → far fewer pool rows than asked | `.contains("pools",[pool])` (GIN-indexed) before `.limit()` in repository + Edge Function |
| M7 | Error envelope mismatch: FastAPI `{"detail"}` vs Edge `{"error"}` | FastAPI exception handler renders `{"error": ...}` |
| M8 | `pe_5y_avg`/`pb_5y_avg` implemented but never called — columns stayed NULL forever | Quarterly worker fetches 5y closes and computes both on the newest quarter (validated live: RELIANCE 20.6/1.90, TCS 22.6/10.41) |
| M9 | Five NaN/None guard bugs raised `TypeError`/`InvalidOperation` instead of returning None (52W meta path also skipped its series fallback) | Fixed in `week52.py`, `validators.py`, `fundamentals/quarterly.py` (NaN cells now via `to_decimal`) |
| M10 | Canary could never exit 2 — a dead DB/bad key reported green | `load_error` on the report; CLI exits 2 when fixtures can't load |
| M11 | Scan engine silently dropped ALL scan_results when the scans-id lookup returned empty (reported success) | Surfaced as an upsert error |
| M12 | yfinance timeout config was never applied during syncs | `apply_session_timeout()` wired into both sync CLIs |
| M13 | Quarterly workflow had no failure notifier (daily/backup did) | Notify-on-failure step added |
| M14 | Frontend gates broken: `npm run typecheck` failed (TS null-narrowing), `npm run lint` unrunnable (ESLint 9, no flat config), `tsc -b` emitted stray `.js` files next to sources (13 were committed) | Null-capture fix; `eslint.config.js` + deps; `noEmit`; stray `.js` + `tsbuildinfo` removed and ignored |
| M15 | Pool page "All strategies" showed the LAST result per symbol (fundamental FAIL masked BUY_ZONE) | Shows the strongest signal by status rank |
| M16 | Edge Function used the service-role key while claiming "RLS still applies" (service role bypasses RLS) | Prefers the anon key (RLS-enforced); service key only a fallback |
| M17 | `major_holders` parsing was positional + a fraction heuristic that read 0.75% as 75% | Label-aware (`insidersPercentHeld`/`institutionsPercentHeld`, always fractions) with positional fallback |
| M18 | Volume came from `.info` (live intraday figure), not the session bar | Bar volume first, `.info` fallback |
| M19 | Six registered Tier-A fields were never computed (`forward_pe`, `debt_to_equity_pct`, `ebitda_ttm`, `revenue_ttm`, `profit_margin_pct`, `price_change_nd_pct`) | All six now populated (trend look-back = 7 trading days on adjusted closes, matching legacy `strategy_rules.json`) |

## 3. MINOR — fixed

- `Decimal("0")` thresholds silently replaced by defaults (falsy-`or`) in canary + all 4 strategies → explicit `None` checks (`dec_or_default`).
- Permanent PG errors (42xxx/23xxx/22xxx) no longer retried 3× per chunk in `bulk_upsert`.
- Alert severity: non-empty `upsert_errors` now `error` (was `warning`), per the Stage 8 spec; quarterly alerts no longer print `written: None`.
- `--limit` now applies with explicit `--symbols`; default `--as-of` is IST-today (was runner-local); overrides CSV read as `utf-8-sig`.
- Dead test fixed (`"TO public" not in sql.lower()` could never fail); misleading registry formula strings corrected (`clamped >= 0` was false; DMA uses adjusted closes).
- Numpy integer dtypes accepted by `to_decimal` (all-int64 frames no longer yield zero bars).
- Workflows: stale "chained with &&" comment; role-existence guards in 010 so migrations also apply on bare Postgres.
- Runbook: `fundamental_filter`→`fundamental_screener`, seed count 247→442, overrides-CSV example replaced (master CSV would produce 5331 errors), port-remap note added.

## 3b. Round 2 (2026-09-01) — UI completion + data-unit fixes

| # | Issue | Fix |
|---|-------|-----|
| R1 | **UI was a thin slice of Plan §8.2** — no Tier B display anywhere (fundamentals endpoint not even wired into the frontend), no expandable rows, no filter panel, only 5 of the planned columns | Pool view rebuilt: full column set (Cap bucket, MCap in ₹Cr, PE, PB, Below 200-DMA, Fall from ATH, Dist 52W Low, Signal); click-to-expand row with **Tier A** (17 price-action fields), **Tier B** (14 quarterly fields, lazily fetched), and all 4 strategy signals with reasons; filter panel (symbol search, cap bucket, signal, strategy); last-sync status in the header |
| R2 | `net_debt_to_equity` stored yfinance's PERCENT form (36.65) but the screener compares against a RATIO threshold (0.30) → the D/E rule could never pass | Converted to ratio (÷100) at extraction; validated live (TCS: 0.1021 vs 0.30 → PASS) |
| R3 | Strategy reason strings showed `???` (em-dashes mangled by an ASCII re-encode during the earlier fix round) | Em-dashes restored in all 3 strategy files; re-scan rewrote the stored reasons |
| R4 | Stored scan predated the quarterly sync, so `pe_5y_avg`/`net_debt_to_equity` rules showed "not available" even though the data existed | Re-ran scan; fundamentals-merge path validated live (PE/PB-vs-5yr-avg rules now evaluate real values). Operational note: **scan must run after (or be re-run after) a quarterly sync** — the nightly workflow order (sync → scan) already guarantees this for Tier A |

## 3c. Round 3 (2026-09-01) — data-source reconciliation vs Screener.in / TradingView

| # | Finding | Resolution |
|---|---------|-----------|
| S1 | ROCE / ROE were NULL ("yfinance doesn't provide") — user asked for a reliable source | **Screener.in enrichment** added to the quarterly sync: the PUBLIC company page (no login) serves ROCE/ROE; values overlay the derived ones, source recorded in `data_quality_flags`. Validated: TCS ROCE 63.00 / ROE 51.80 — exact match with Screener. Env-gated `PLUTUS_SCREENER_ENRICH` (default on); `PLUTUS_SCREENER_COOKIE` unlocks login-only ratios (Pledged percentage). Yfinance-statement **derived fallbacks** also implemented (ROCE = (PBT_TTM+Interest_TTM)/avg capital employed; ROE = NP_TTM/avg equity) for when Screener is unreachable |
| S2 | `net_debt_to_equity` was gross D/E (TCS 0.10) — user supplied the correct formula | Rebuilt from the balance sheet: **(Total Debt − Cash & Cash Equivalents) / Stockholders Equity** → TCS 0.0455. NOTE: Screener's custom "Net Debt to Equity" (−0.02 for TCS) counts current investments as cash — decision open whether to include them (TCS parks ~₹35k Cr there) |
| S3 | Pledging still NULL | Not on Screener's public page (login-only custom ratio) and not in yfinance. Paths: set `PLUTUS_SCREENER_COOKIE`, or the manual overrides CSV. TCS pledging = 0.00 per user's account |
| S4 | "OHLC differs from TradingView" | **Not a bug — date mismatch.** User compared the Aug-31 snapshot against Sep-1 TradingView. After the Sep-1 sync: TCS O 2,355.00 / H 2,372.00 / L 2,325.00 / C 2,369.00 — byte-identical to TradingView's Sep-1 bar. The UI header shows the snapshot date; always compare same sessions |
| S5 | PE 17.42 vs Screener's 16.2; MCap ₹8.68L vs ₹8.70L Cr; 5Y-PE 22.6 vs 29.7 | Methodology differences, documented: our PE = yfinance trailing (price ÷ consolidated TTM EPS 137.71 = 17.2, matches TradingView convention); Screener's Stock P/E uses a different PAT basis. MCap differs by share-count convention (~0.2%). 5Y-avg-PE gap is the documented static-TTM-EPS simplification (known gap #4) — Screener uses contemporaneous EPS, unreconstructable from yfinance's ~6 quarters of history |
| S6 | Batch upsert NOT NULL violation on `data_quality_flags` (found during S1 validation) | PostgREST bulk upserts use one uniform column list — a key present on one row becomes an explicit NULL on the others. `data_quality_flags: {}` now set on every extracted row |

## 3d. Round 4 (2026-09-01) — Tier B pivoted to Screener.in (locked decision)

**Decision:** quarterly fundamentals now come from Screener.in's authenticated front page — the parsing methodology proven in legacy Buddy (`backend/app/services/screener_data_fetcher.py`) — ported to Plutus with Decimal discipline and Supabase writes. yfinance remains the DAILY (Tier A) source only. The lightweight yfinance-quarterly path and the Round-3 enrichment module were removed.

| What | Detail |
|---|---|
| New modules | `plutus/fundamentals/screener_page.py` (pure parsers: #quarters, #top-ratios, quick-ratios fragment, #shareholding, pledging fallbacks), `plutus/fundamentals/screener_client.py` (login flow with CSRF + 429 back-off, company page, quick-ratios Ajax via warehouse-id, public chart-API 5Y-average fallback) |
| Worker | `sync/quarterly.py` rewritten: pre-flight login (bad credentials fail the run in seconds, not after 400 cooldowns), per-symbol isolation kept, **15 s cooldown** between fetches when >5 symbols (legacy 20 s; env `PLUTUS_SCREENER_COOLDOWN_S`), 0.5 s politeness for small batches |
| Removed | `screener_enrich.py` (Round 3), yfinance quarterly extractors + ROCE/ROE/net-D/E derivations + `compute_pe_5yr_avg`/`compute_pb_5yr_avg`, `pe_5yr_avg`/`pb_5yr_avg` re-exports in `metrics/pe_pb.py` |
| Units | Screener prints ₹ Crores; DB stores absolute rupees — converted once in `rows_from_bundle` |
| Credentials | `SCREENER_EMAIL`/`SCREENER_PASSWORD` in `plutus/.env` (gitignored; same names as legacy). Quarterly workflow now injects them from GitHub secrets, timeout raised 30→240 min (~450 symbols × 15 s ≈ 2 h) |
| Validated (TCS vs user's Screener page) | ROCE 63.0 ✓ ROE 51.8 ✓ Net D/E −0.02 ✓ (the custom quick-ratio itself) Pledged 0.00 ✓ 5Yrs PE 29.7 ✓ 5Yrs PBV 13.2 ✓ Promoters 71.77 ✓ FII+DII 22.48 ✓ Public 5.69 ✓; quarterly table column-for-column (13 quarters) ✓ |
| Result | `fundamental_screener` produces its first full PASS verdicts on live data (TCS, ITC: 6/6 rules) |
| Notes | Shareholding now comes from Screener's #shareholding table (FIIs+DIIs = institutional). ITC has no promoter row (professionally managed) — NULL is correct. Pledging: quick-ratio first, then the "#analysis / meta pledged X%" sentence; a page with neither reports a warning and stays NULL (fail-safe in the screener rule) |

## 3e. Round 5 (2026-09-01) — weekly Screener valuation + source lock-down

**Decision:** PE / PB / Market Cap also move to Screener.in, on a WEEKLY cadence (Saturday 05:00 IST). Prices and every price-derived metric stay yfinance-daily with AdjClose, exactly as BuddyTrader.

| What | Detail |
|---|---|
| New | Migration `012_screener_ratios.sql` (one row per symbol: market_cap ₹-absolute, pe, pb, price, book value, raw JSONB); `sync/weekly_ratios.py` worker + `run_weekly_ratios` CLI (pre-flight login, 15 s cooldown >5 symbols); `.github/workflows/plutus-weekly-ratios.yml` (cron `30 23 * * 5` = Sat 05:00 IST, timeout 240 min) |
| Daily sync change | Loads `screener_ratios` once per run and stamps pe_current / pb_current / market_cap (+ cap_bucket) into every snapshot — scans now compare **Screener PE vs Screener 5Y-avg PE** (same-source rule, as legacy Buddy enforced). Missing ratio row → NULLs + error note, never a silent yfinance substitute |
| Removed / retired | yfinance trailing/forward PE, D/E, EBITDA no longer fetched (`metrics/pe_pb.py` deleted; columns `forward_pe` / `debt_to_equity_pct` / `ebitda_ttm` kept in schema, no longer populated); Volume removed from the UI (still stored — it ships free with the OHLCV bar) |
| Prices confirmed | Tier A remains yfinance with **AdjClose** (BuddyTrader approach): 200-DMA = mean of last 200 AdjCloses — same math as legacy's `AdjClose.rolling(200).mean()`; ATH = max(High × AdjClose/Close); Sep-1 TCS OHLC byte-identical to TradingView. One deliberate improvement over legacy: <200 bars → DMA NULL + error (legacy averaged what it had, silently feeding BUY_ZONE) |
| Validated (TCS vs user's Screener page) | MCap ₹8,69,924 Cr ✓ exact · Stock P/E 16.20 ✓ exact · PB 8.00 (page prints 7.99 — theirs divides by unrounded book value, ours by the printed 296; ~0.1%) · screener rule reasons now read "PE 16.2 vs 5yr Avg 29.7" — same source both sides |
| Ops | New GitHub secret usage: weekly workflow needs `SCREENER_EMAIL` / `SCREENER_PASSWORD` (same as quarterly). Fixed en-route: dotenv now loads before Screener login even when a CLI skips `get_settings()` |

## 3f. Round 6 (2026-09-01) — UI overhaul, 11-check funda score, PlayArea

| What | Detail |
|---|---|
| **Fundamental score (out of 11)** | `fundamental_screener` strategy rewritten as the exact BuddyTrader 11-check scorer (legacy `routes.py::getFundamentalsFromCache` contract): PE<70, PE<5yr-avg, PB<5yr-avg, NetD/E<0.25, ROCE>15, ROE>15, Sales/NP/PBT ≥90% of ATH quarter, Pledging<5, OPM stable. `score` = passes (unknown = N/A, not fail); status PASS at ≥8. Full check breakdown persisted in `metrics_snapshot`. Engine now merges quarter-history aggregates (latest/ATH Q figures, latest/avg OPM) into snapshots. One upgrade over legacy: real Screener OPM% is used instead of the net-margin proxy |
| **Pool table = every legacy column** | Symbol · Sector · Cap · Close ₹ · 200 DMA · % Below DMA · 52W Low · 52W High · % From Low · ATH · % ↓ ATH · Last Week Trend · Score /11 · then Signal (F40/E40) or the rally tail Days Since Streak · % To Next Buy · Streak % (S200/PlayArea — legacy RALLY_POOLS). All columns sortable (legacy default sorts: score desc / days-since-streak asc; nulls always sink). Legacy colour semantics preserved (trend ▲▼, ↓ATH bands, ≤5% from low, days ≤30 blue, % to buy ≤0/≤10) |
| **Filters** | Symbol search, cap bucket, sector, signal, min-score slider + summary tiles (stocks, buy zone, opportunities, avg funda score) and clear-filters chip |
| **Expanded row** | Legacy layout upgraded: price-action strip, per-strategy cards with reasons + rally Next Buy/Next Sell levels, Fundamental Details panel (pts badge with 8+/6–7/<6 bands, metric chips, latest-Q vs ATH chips, the 11-check ✅/❌/❓ grid) |
| **PlayArea** | Implemented as the tactical watchlist: search-and-add any stock from the synced universe (chips, remove, localStorage persistence per browser). Data flows: new `symbols=` mode on `/api/snapshots/latest` and `/api/scan_results` (the latter returns each symbol's LATEST result per strategy across any pool scan) — added to BOTH FastAPI and the Edge Function. Rally view + full score column, same as S200 |
| Housekeeping | Old ExpandedRow removed; dynamic Tailwind class pitfall avoided (literal align classes); PlayArea skips the pool-snapshots query |
| Verified | Browser: F40 table sorted by score (INFY/PAGEIND/TCS 11/11 · ITC 7 · RELIANCE 5), expanded INFY shows 11-check grid with real Screener data; PlayArea add/remove + rally tail; new endpoints live through the Edge Function (200s). Gates: pytest / typecheck / lint / build all green |

**PlayArea note:** membership is per-browser (v1 API is read-only). A DB-backed shared PlayArea (tagging `stocks.pools`) needs the V2 write path — flagged for when auth lands.

## 3g. Round 7 (2026-09-01) — fetch-on-miss (legacy cache contract restored)

**Gap:** a PlayArea addition (e.g. WIPRO) with no `fundamentals` / `screener_ratios` rows stayed unscored — legacy Buddy fetched cache-miss symbols live at run time ("only symbols NOT yet in the cache are fetched live").

**Fix:** `run_daily_sync` now runs a **fetch-on-miss enrichment** after every non-dry sync: any synced-OK symbol missing a `fundamentals` row or a `screener_ratios` row is fetched from Screener.in immediately (quarterly + weekly workers, respective cooldowns), before the workflow's scan step scores it. Best-effort — enrichment errors are reported in the CLI JSON (`enrichment` block) and logged, never alter the sync's exit code. Opt out with `--no-enrich`. UI: an all-N/A score now renders as **“—”** (legacy NOT-IN-CACHE) instead of a red 0/11, and the detail panel says "NOT SCORED — fundamentals fetch on the next daily sync".

**Validated live:** `run_daily_sync --symbols WIPRO.NS` → enrichment fetched 1 fundamentals + 1 ratios set (0 errors) → rescan → WIPRO scores **8/11** in PlayArea (ROCE 17.8, ROE 15.5, pledging 0.00, 5Y PE 20.0, PE 13.8, MCap ₹1,82,240 Cr — all Screener-sourced). All gates green.

## 3h. Round 8 (2026-09-02) — on-demand PlayArea fetch + premium UI redesign

**Bug fixed:** a PlayArea symbol never seen by any sync had no snapshot row → it silently didn't render, and nothing fetched (Round 7's fetch-on-miss only fired at sync time).

| What | Detail |
|---|---|
| On-demand fetch | New LOCAL-DEV endpoint `GET /api/admin/sync?symbols=` (FastAPI only, 404 when `PLUTUS_ENV=prod`, deliberately NOT ported to the Edge Function — prod stays read-only): background thread runs Screener enrichment → daily sync → pool scans for the symbols. PlayArea now shows a never-synced symbol as an amber **“no data”** chip with a **“Fetch data”** button; while fetching, the page polls every 5 s until the row lands (3-min cap). `frontend_v2/.env.local` now points at FastAPI (:8787) so this works locally |
| Ordering fix (found during validation) | Enrichment now runs BEFORE the price sync (both the CLI and the on-demand thread) so the snapshot being written is stamped with the fresh PE/PB/MCap — previously a first-ever fetch left the PE checks N/A until the next day |
| Validated live | Added HDFCBANK (never synced) → Fetch data → yfinance 5y history + 13 Screener quarters + ratios landed, pools rescanned → row appeared automatically: PE 13.70 / PB 1.80 / Large, score 7/11, radar rank #1 STRONG·BUY |
| **UI redesign (v2)** | New premium light theme — warm ivory ground, ink text, deep-teal + gold accents, Fraunces display serif + Inter, soft-shadow cards. Decision-first layout: **Opportunity Radar** (top-4 setups ranked signal→score→depth, PRIME/STRONG/WATCH conviction chips, one-line "why"), stat strip, filter toolbar (search/cap/sector/signal/min-score), the full BuddyTrader-column table (all columns + sorting kept; % Below DMA renders as a progress bar toward the 14% buy threshold; score as a radial ring), redesigned expanded row, and a **Compare tray** (pick ≤4 stocks from radar cards or table checkboxes → side-by-side metric grid with the better value marked per row) |
| Housekeeping | ScoreBadge → ScoreRing; status pills/colours retuned for light; Pools landing + header restyled. All gates green (pytest, typecheck, lint, build) |

## 3i. Round 9 (2026-09-02) — cyclicality-aware YoY check replaces OPM; Screener deep link

| What | Detail |
|---|---|
| OPM removed | "OPM Stable/Positive" dropped from the 11 checks AND from fetching (screener parser no longer extracts the OPM row; `operating_margin_pct` column kept, written NULL; engine aggregates no longer compute latest/avg OPM; UI chip removed) |
| New check 11: **Net Profit YoY (same quarter)** | Latest Q net profit vs the SAME quarter one year earlier (month-matched from stored quarters — e.g. Jun 2026 vs Jun 2025). Pass when YoY growth ≥ 0 (config `yoy_growth_min`). When the latest quarter is DOWN QoQ but UP YoY, the detail explicitly names it: *"QoQ dip but YoY up: cyclic/seasonal pattern"* — a seasonal business is boosted, never knocked out, for a soft quarter. Turnaround handling: loss in the same quarter last year → pass if now profitable. Missing history → N/A (score max stays 11) |
| Screener link | "View on screener.in ↗" button on the Fundamental details card (`/company/{code}/consolidated/`) |
| UI | Teal chip in the quarter row: "Same Q last year (Jun 2025) ₹17,090 Cr **+19.3% YoY**" |
| Validated live | HDFCBANK: Jun-2026 NP ₹20,383 Cr vs Jun-2025 ₹17,090 Cr → +19.3% YoY despite a QoQ dip → check passes with the cyclic tag, **score 4→8** (PASS band). TCS/INFY also flagged cyclic (IT June seasonality); ITC −15.6% / RELIANCE −24.6% YoY fail honestly. 5 new offline tests (incl. month-matched YoY lookup + ISO-string dates from PostgREST); all gates green |

## 4. Deliberate deviations / notes

- **Local ports are 55321–55329** (not the CLI-default 54321–54324) so the Plutus stack coexists with the other Supabase project running on this machine (`virundhu-cartsas`). Keys/URLs in `plutus/.env` + `frontend_v2/.env.local`.
- `close` now always comes from the session bar (not `regularMarketPrice`) — rows are internally consistent and backfills are correct; at 17:30+ IST the two are identical.
- `pe_current` keeps the legacy trailing→forward fallback, but `forward_pe` is now stored separately so consumers can distinguish.
- ROCE/ROE/pledging stay NULL from yfinance (Indian-listing gap, per Validation Report) → `fundamental_screener` FAILs until the manual overrides CSV is applied. Expected behaviour ("missing = fail for safety").

- Plan §8.2's **"Sync Now" button is intentionally absent** in v1: the API layer is read-only by contract (money-safety); syncs run via CLI locally and GitHub Actions in prod. A write-capable admin endpoint is a V2 item alongside auth.

## 5. Known gaps (tracked, not blocking local use)

1. **Rally threshold config knob is inert at sync time** — `has_valid_20pct_rally` is computed at 20%/189d in the daily sync; the strategy-config value only changes the displayed reasons. Wire `strategy_configs` into the sync pipeline if a non-20% threshold is ever needed.
2. `run_scan` never loads `strategy_configs` from the DB — strategies always use code defaults (which match `strategy_rules.json` exactly). Fundamental screener reads `thresholds`/`enabled_rules` keys that don't match the `inputs` column shape.
3. No pagination on universe/snapshot reads (PostgREST cap 1000 rows). Safe at 442 stocks; needed before the universe grows past ~1000, and the scan engine's multi-quarter fundamentals read may hit it sooner.
4. ~~`pe_5y_avg` static-TTM simplification~~ — RESOLVED in Round 4: 5Y PE/PBV now come from Screener's quick ratios (chart-API average as fallback).
5. Registry covers 6 of 10 tables (`pools`, `strategy_configs`, `trades`, `canary_checks` uncatalogued); registry `nullable` metadata drifts from SQL in places.
6. `trades` has no natural unique key (V2 concern — writes are still gated off).
7. `PLUTUS_YF_MAX_RETRIES` / `*_BATCH_SIZE` / `SYNC_HISTORY_YEARS` env vars are read but unused (hardcoded 3 / 500 / "5y").
8. yfinance's curl-based transport doesn't honour the socket timeout in all paths (one live call ran 216s before the retry envelope recovered it). Workflow `timeout-minutes` remains the backstop.
9. `sync_jobs.payload_json` (incl. raw error strings) is anon-readable — consider redaction before public hosting.
10. Docs drift in `Plutus_Plan.MD` §5 (e.g. `pe_5yr_avg` vs shipped `pe_5y_avg`, old `sync_jobs` schema) and `Plutus_Phased_Development.MD` ("Applied in Stage 1" claims, locked route map) — the migrations + this log are authoritative.

## 6. Local E2E validation results (2026-08-31)

| Step | Result |
|------|--------|
| `pytest plutus/` | ✅ 393 tests, all pass (exit 0) |
| Migrations 001–011 on local stack | ✅ clean + idempotent re-run |
| `seed_universe` (real CSV) | ✅ 442/442, pools F40/E40/S200 merged |
| `run_daily_sync` (5 symbols, live yfinance) | ✅ 5/5 snapshots, sane values, `sync_jobs` row |
| `run_scan --pool ALL` | ✅ exit 0; ITC=BUY_ZONE(100), INFY=OPPORTUNITY(70) — hand-checked vs snapshot numbers |
| `run_quarterly_sync` (2 symbols) | ✅ 11 rows, holdings + 5Y PE/PB populated |
| `run_canary` | ✅ exit 0 clean / exit 1 on forced drift |
| FastAPI (`:8787`) — all 10 endpoints | ✅ 200; money fields are strings; `{"error"}` envelope |
| Edge Function (local serve) | ✅ all routes 200; money-string parity |
| Frontend (`:5173`) `/pools`, `/pools/F40`, `/status` | ✅ live data, correct signals, no console errors |
| Alert webhook (local listener) | ✅ warning fired on partial failure; silent on green |
| `npm run typecheck` / `lint` / `build` | ✅ all exit 0 |

**Note:** the FastAPI dev port is **8787** locally (`PLUTUS_API_PORT`) because another service on this machine owns `127.0.0.1:8000`.
