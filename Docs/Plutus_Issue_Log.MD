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

## 4. Deliberate deviations / notes

- **Local ports are 55321–55329** (not the CLI-default 54321–54324) so the Plutus stack coexists with the other Supabase project running on this machine (`virundhu-cartsas`). Keys/URLs in `plutus/.env` + `frontend_v2/.env.local`.
- `close` now always comes from the session bar (not `regularMarketPrice`) — rows are internally consistent and backfills are correct; at 17:30+ IST the two are identical.
- `pe_current` keeps the legacy trailing→forward fallback, but `forward_pe` is now stored separately so consumers can distinguish.
- ROCE/ROE/pledging stay NULL from yfinance (Indian-listing gap, per Validation Report) → `fundamental_screener` FAILs until the manual overrides CSV is applied. Expected behaviour ("missing = fail for safety").

## 5. Known gaps (tracked, not blocking local use)

1. **Rally threshold config knob is inert at sync time** — `has_valid_20pct_rally` is computed at 20%/189d in the daily sync; the strategy-config value only changes the displayed reasons. Wire `strategy_configs` into the sync pipeline if a non-20% threshold is ever needed.
2. `run_scan` never loads `strategy_configs` from the DB — strategies always use code defaults (which match `strategy_rules.json` exactly). Fundamental screener reads `thresholds`/`enabled_rules` keys that don't match the `inputs` column shape.
3. No pagination on universe/snapshot reads (PostgREST cap 1000 rows). Safe at 442 stocks; needed before the universe grows past ~1000, and the scan engine's multi-quarter fundamentals read may hit it sooner.
4. `pe_5y_avg` uses a static current-TTM-EPS across the 5y close window (documented simplification; understates historical PE for growers).
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
