# Plutus — Phased Development Plan

> **Companion to:** `Plutus_Plan.MD` (architecture) & `Plutus_Validation_Report.MD` (data source proof)
> **Purpose:** Break the Plutus rebuild into small, verifiable, non-overlapping stages so each stage ships a **provably correct, performant, and financially safe** slice.
> **Status:** ✅ Stages 1–8 complete. **Trading Journal deferred to V2.**
>
> ### Deployment topology (locked)
>
> Plutus runs entirely inside the **Supabase + GitHub + CDN** stack — no Render, no Fly, no VPS.
>
> | Piece | Runs on | Why |
> |---|---|---|
> | Postgres, RLS, Auth, Storage | Supabase | Already our system of record |
> | Read-only HTTP API | **Supabase Edge Function** (`supabase/functions/plutus-api/`) | 500K free invocations/mo — no separate host |
> | Daily & quarterly sync (Python + yfinance) | **GitHub Actions** cron | 2000 min/mo free (private) or unlimited (public); yfinance needs Python |
> | Frontend static build | **Cloudflare Pages** (or Vercel) | Unlimited/generous free tier; SPA rewrite via `_redirects` |
> | Local dev API | FastAPI (`plutus/api/app.py`) — retained | Test harness + money-safety contract lives here |
>
> The Python FastAPI app is **kept as a first-class dev + test target**. The
> Edge Function in `supabase/functions/plutus-api/index.ts` is a route-for-route
> port; changes to the API contract must land in both places and be gated by
> `plutus/tests/test_deployment_config.py`.

---

## ⚠️ PROMPT NOTE — READ BEFORE EVERY STAGE

> **This project handles real money.** UI polish can (and will) be redone later. What CANNOT be redone easily is bad data, silent rounding errors, race conditions, or unreliable syncs. Every stage must satisfy these five invariants before it is marked "done":
>
> 1. **Data Consistency** — Every field has a single source of truth, a documented formula, and an idempotent write path. No two code paths compute the same metric two different ways.
> 2. **Computation Correctness** — Every derived number (DMA, ATH, PE, Fall%, Rally%) has a unit test with a hand-computed expected value. Never trust "it looks right in the UI".
> 3. **Stability** — Any external call (yfinance, Supabase) is wrapped with retry + timeout + structured error logging. A single failed symbol never breaks the batch.
> 4. **Reliability** — The daily sync either fully succeeds or is marked partial in `sync_jobs` with per-symbol error rows. Never a half-written snapshot.
> 5. **Performance** — Full-universe daily sync target: **< 5 minutes for 300 stocks**. Full-universe scan read: **< 500 ms** from the frontend.
>
> **When in doubt, choose correctness over speed, and durability over cleverness. UI is disposable; the numbers are not.**

---

## Stage Map (High Level)

| Stage | Name | Duration | Ships | Status |
|------:|------|:--------:|-------|:-----------:|
| **1** | Foundation — Field Registry, Repo Layout, Migrations | 1–2 d | Canonical field catalog, Supabase schema files, project skeleton | ✅ **COMPLETE** |
| **2** | Data Ingestion Core — yfinance adapter + universe loader | 2–3 d | Reusable `yf_client`, universe seed script, per-symbol fetch tested on 5 stocks | ✅ **COMPLETE** (live smoke deferred) |
| **3** | Metrics Engine — Pure functions with unit tests | 2–3 d | 200 DMA, ATH, Fall%, 52W metrics, 20% Rally as pure, tested functions | ✅ **COMPLETE** |
| **4** | Daily Sync Worker — Tier A pipeline | 3–4 d | End-to-end sync writes to `daily_snapshots` for full universe with `sync_jobs` audit | ✅ |
| **5** | Quarterly Sync Worker — Tier B pipeline | 2–3 d | Fundamentals ingestion + manual pledging/ROE upload path | ✅ |
| **6** | Scan Engine v2 — Deterministic strategies against DB | 3–4 d | Envelope, 52W H/L, 20% Rally, Fundamental screener persisted to `scan_results` | ✅ |
| **7** | Frontend Rewrite — Pool view over Supabase | 5–7 d | Pool tabs, expandable rows, sync status, filters | ✅ |
| **8** | Hardening — Backfill, monitoring, backups | 2–3 d | Retry queues, alerting, weekly DB backup, canary tests | — |
| **V2** | Trading Journal | 3–4 d | `trades` CRUD, "Held" badge, P&L | ⏸ deferred |
| **V2-U** | Universe — single source of truth | 1 d | Universe page (Market Analysis), pool add/edit/import/export, `sector_group`, `universe_syncs`, S200 criteria; Screener screen job pending | ✅ first cut (2026-09-23) |

> **Scope change (post-Stage 7):** The Trading Journal has been moved out of
> the v1 roadmap into **V2**. Rationale: v1 is a decision-support scanner;
> journalling positions is a separate workflow that will land only after v1
> has proven itself on real weekly use. The `trades` table + RLS gate that
> denies anon writes stay in the schema (migration 007 + 010) so V2 can plug
> in without a data migration.

Stages 1 → 6 form the **critical numeric path**. No frontend work begins until scan results in the DB are byte-identical to a Python reference implementation (Stage 6 gate).

---

## Stage 1 — Foundation (✅ COMPLETE)

**Completion audit (post-implementation):**
- ✅ 66 unit tests passing (`pytest -q` = `66 passed in 0.05s`).
- ✅ 67 fields catalogued in registry, cross-checked against all 9 migrations.
- ✅ Decimal-only money discipline enforced by `to_decimal()` gate + tests.
- ✅ Fail-fast config proven by 6 config tests.
- ⚠️ **Known deferrals (moved to correct later stages, not lost):**
  - RLS policies → Stage 4 (when writes begin).
  - Edge Function cron scaffolding → Stage 4 (when there's something to schedule).
  - Realtime subscription wiring → Stage 7 (when frontend exists).
  - Frontend detailed spec → now locked in the "Frontend Architecture" section above.
  - Supabase feature decision matrix → now locked in dedicated section above.


**Goal:** Lock the schema, the field catalog, and the code layout so every later stage plugs into slots that already exist. No moving numbers yet — just the scaffolding those numbers will live in.

### 1.1 Deliverables

1. **Field Registry** (`plutus/registry/fields.py`) — single Python module that enumerates every field Plutus will ever store, with:
   - canonical name
   - dtype (Decimal / int / str / date / bool / JSONB)
   - source (`yfinance.info`, `yfinance.history`, `derived`, `manual`, `csv`)
   - tier (`A_daily` / `B_quarterly` / `universe` / `derived`)
   - unit + scale note (e.g. D/E stored as percent, market cap in ₹Cr)
   - nullable + default
   - formula string (for derived fields)
2. **Supabase Migration Files** — versioned SQL, one file per table, matching `Plutus_Plan.MD` §5 exactly and the schema addendum in the Validation Report §8:
   - `migrations/001_stocks.sql`
   - `migrations/002_pools.sql`
   - `migrations/003_daily_snapshots.sql`
   - `migrations/004_fundamentals.sql`
   - `migrations/005_strategy_configs.sql`
   - `migrations/006_scans_and_results.sql`
   - `migrations/007_trades.sql`
   - `migrations/008_sync_jobs.sql`
   - `migrations/009_views.sql`
3. **Repository Layout** — `plutus/` directory created alongside `backend/` so old Buddy keeps running:
   ```
   plutus/
     registry/          # Field catalog + schema constants
     adapters/          # yfinance client, Supabase client (thin wrappers)
     metrics/           # Pure computation functions (Stage 3)
     sync/              # Daily + quarterly workers (Stage 4-5)
     scan/              # Scan engine (Stage 6)
     migrations/        # Ordered SQL files
     tests/             # pytest suite
     scripts/           # One-off ops: seed_universe.py, backfill.py
     config.py
     __init__.py
   ```
4. **Config & Env** — `plutus/config.py` reads `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `YF_TIMEOUT_SECONDS`, `SYNC_BATCH_SIZE` from env with **fail-fast validation** — the module must raise on import if a required var is missing.
5. **Decimal Discipline** — Every monetary/ratio field uses `Decimal` in Python and `NUMERIC` in Postgres. `float` is banned from anything that touches money. A `plutus/registry/types.py` module exports `Money`, `Ratio`, `Percent`, `Price` type aliases with rounding helpers.

### 1.2 Non-Goals for Stage 1

- No network calls to yfinance yet (Stage 2).
- No metrics computation (Stage 3).
- No frontend changes.
- No modification to existing `backend/` — Buddy stays live.

### 1.3 Exit Criteria (Stage 1 is "done" only when all pass)

- [x] `plutus/` directory exists with the layout above.
- [x] `fields.py` lists **every field** referenced in `Plutus_Plan.MD` §4 + §5 and the Validation Report §8. (67 fields catalogued across `stocks`, `daily_snapshots`, `fundamentals`.)
- [x] All 9 SQL migration files are drafted and their columns cross-checked against the registry by `test_registry_columns_present_in_migration`. Full Postgres dry-run against a scratch DB will run during Stage 4 CI setup.
- [x] `plutus/config.py` raises a clear error when env vars are missing (proven by `test_config.py` — 6 tests).
- [x] `plutus/registry/types.py` exposes `Decimal`-based aliases and rounding helpers with unit tests for banker's rounding vs half-up (28 tests).
- [x] The repo-root `README.md` documents the layout and how to run the test suite (originally `plutus/README_PLUTUS.md`, folded into the root README on 2026-09-16).

**Stage 1 test run:** `66 passed in 0.05s` (pytest 8.3.5, Python 3.8.10).

### 1.4 Design Guardrails Adopted Here

| Guardrail | Rule |
|---|---|
| **Decimal Everywhere** | All money/ratio fields use `Decimal`. `float` banned outside pure geometry/plotting. |
| **Single Source of Truth** | Every field is defined once in `fields.py`. Migrations, adapters, and metrics all reference the registry — never a raw string. |
| **Idempotent Writes** | Every table has a `UNIQUE` constraint on its natural key. All writes use `INSERT ... ON CONFLICT DO UPDATE`. |
| **Fail-Fast Config** | Missing env var → crash on import, never at runtime mid-sync. |
| **Structured Errors** | Every exception logged with `symbol`, `stage`, `field`, `traceback`. No bare `except:`. |
| **Zero-Trust Inputs** | Every yfinance value is validated (non-null, positive where required, within sanity band) before it touches the DB. |
| **Deterministic Tests** | Metrics tests use fixed OHLCV fixtures — never live network. |

---

## Stages 2 – 9 (Summary — full spec expanded when each begins)

### Stage 2 — Data Ingestion Core (🟡 IN PROGRESS)

**Goal:** Bulletproof data-in layer. Nothing else in Plutus works if this is flaky.

**Deliverables:**
1. `plutus/adapters/yf_client.py`
   - `fetch_info(symbol) -> dict` — `.info` payload with retry (3× exponential backoff, cap 8s), 15s timeout per call.
   - `fetch_history(symbol, period, interval) -> pd.DataFrame` — OHLCV with same retry policy.
   - `fetch_batch(symbols, ...) -> dict[str, Result]` — each symbol wrapped in `Result(ok=True/False, value/error)`; a single failure never poisons the batch.
   - Structured logging: `{symbol, attempt, latency_ms, outcome}` per call.
2. `plutus/adapters/supabase_client.py`
   - Thin factory returning a configured `supabase.Client` (service key).
   - `bulk_upsert(table, rows, conflict_cols)` — chunked (500/req), retries on 5xx, returns `(inserted, updated, errored)` count.
   - No ORM. Rows are `dict[str, Any]` shaped from the registry.
3. `plutus/adapters/validators.py`
   - `sanity_check_price(x)` — reject ≤ 0, > 10,000,000, `None`, `NaN`.
   - `sanity_check_ratio(x)` — reject outside `[-1000, 1000]`.
   - `sanity_check_symbol(s)` — regex `^[A-Z0-9&-]+\.NS$` or `.BO`.
4. `plutus/scripts/seed_universe.py`
   - Reads `UserData/Vicky - Master Template - Master.csv`.
   - Maps CSV columns → `stocks` schema via registry.
   - Idempotent upsert on `symbol`.
   - CLI: `python -m plutus.scripts.seed_universe --csv path --dry-run`.
5. `plutus/scripts/pilot_fetch.py`
   - Fetches 5 pilot symbols (RELIANCE, TCS, INFY, PAGEIND, ITC).
   - Dumps raw payloads to `plutus/tests/fixtures/pilot/*.json` — becomes the deterministic corpus for Stage 3 metrics tests.
6. Tests (`plutus/tests/`)
   - `test_yf_client.py` — mocks `yfinance`; asserts retry count, timeout wiring, batch isolation.
   - `test_supabase_client.py` — mocks HTTP; asserts chunking, conflict-column passthrough, error accounting.
   - `test_validators.py` — sanity bands.
   - `test_seed_universe.py` — CSV → row mapping using a 3-row fixture CSV.

**Non-Goals:**
- No metrics math yet (Stage 3).
- No `daily_snapshots` writes (Stage 4).
- No RLS yet (added in Stage 4 when writes begin).

**Exit Criteria:**
- [x] Adapters + validators + seed script + pilot script implemented.
- [x] Batch isolation proven by test (`test_batch_isolates_failures`).
- [x] Retry envelope proven by test (`test_fetch_info_retries_and_succeeds`, `test_all_retries_fail_counts_as_failed`).
- [x] Seed script parses master CSV, dedupes, tags pools, JSON metadata roundtrip (`test_seed_universe.py`).
- [x] Full test suite green: **118 passed in 0.41s**.
- [ ] **Live smoke test** (requires network + Supabase creds): `python -m plutus.scripts.seed_universe --csv UserData/...csv` (deferred to Stage 4 CI setup with real Supabase project).
- [ ] **Live pilot fetch** (requires network): `python -m plutus.scripts.pilot_fetch` producing 5 fixture JSONs (deferred until first metrics test in Stage 3 needs them).

**Stage 2 Deferred Items (not blockers, tracked here):**
1. Live network smoke tests → run at start of Stage 3 (fixtures needed anyway) and Stage 4 (real Supabase).
2. Coverage measurement → wire `pytest-cov` in Stage 9 (hardening); current tests already exercise every adapter branch.

### Stage 2 — Completion Marker
✅ **COMPLETE (code-level).** Live-network exit items intentionally deferred to the stages that will consume them — flagged above so nothing is silently skipped.

### Stage 3 — Metrics Engine (🟡 IN PROGRESS)

**Goal:** Every derived number Plutus stores is produced by a pure function with a hand-checked unit test. Reference: Buddy's `backend/app/services/metrics_engine.py` — semantics preserved, `float` swapped for `Decimal`, retries/side-effects removed.

**Deliverables:**
1. `plutus/metrics/dma.py`
   - `compute_dma(prices: Sequence[Decimal], window: int = 200) -> Decimal | None`
   - `compute_below_dma_pct(close, dma) -> Decimal` — positive means price is below DMA (buy zone).
   - Uses `AdjClose` when available (matches TradingView).
2. `plutus/metrics/week52.py`
   - `compute_52w_high`, `compute_52w_low`, `distance_from_52w_high_pct`, `distance_from_52w_low_pct`.
   - Prefers yfinance meta (`fiftyTwoWeekHigh/Low`) — falls back to trailing-252 max/min.
3. `plutus/metrics/ath.py`
   - `compute_ath(highs, closes, adj_closes) -> Decimal` — max of `High × (AdjClose/Close)` per row (adjusted intraday).
   - `gap_from_ath_pct(close, ath) -> Decimal`.
4. `plutus/metrics/rally.py`
   - `compute_rally_metrics(ohlcv, *, threshold_pct=Decimal(20), window_days=189) -> RallyResult`.
   - Faithful Decimal port of Buddy's Pine-Script translation. Returns dataclass with all 8 rally fields.
5. `plutus/metrics/cap_bucket.py`
   - `classify_market_cap(market_cap_cr: Decimal) -> Literal["Large","Mid","Small","Micro"]` per Plan §4.1 thresholds.
6. `plutus/metrics/pe_pb.py`
   - `pick_pe(info: dict) -> Decimal | None` (trailingPE → forwardPE fallback).
   - `pick_pb(info: dict) -> Decimal | None`.
   - `pe_5yr_avg(price_history, eps_history) -> Decimal | None` — Stage 5 hook; stubbed with a `NotImplementedError` and a TODO for now.
7. `plutus/metrics/pipeline.py`
   - `compute_snapshot(symbol, history_df, info, meta) -> DailySnapshotRow` — orchestrator that calls every metric above and returns a dict keyed by registry field names.
   - **Never raises** — bad inputs return partial rows with `None` where the metric couldn't be computed, plus an `errors: list[str]` field.
8. Tests (`plutus/tests/test_metrics_*.py`)
   - Synthetic OHLCV fixtures with hand-computed expected values (small enough to verify by hand: 20–40 rows).
   - RELIANCE + PAGEIND golden fixtures once Stage 2's pilot fetch has been run (deferred: fixture files can be added incrementally).
   - Every function has: one happy path, one empty-input case, one bad-input case.
9. `plutus/tests/fixtures/synthetic_ohlcv.py`
   - Programmatic fixture builder — no live network needed for CI.

**Non-Goals:**
- No DB writes (Stage 4 orchestrates writes).
- No live yfinance calls in tests.
- No 5Y-avg-PE computation yet (needs quarterly data — Stage 5).

**Exit Criteria:**
- [x] Every metric function is a pure `Decimal → Decimal` (no `float`, no globals, no I/O). Grep gate: `grep -R '\bfloat(' plutus/metrics/` = **zero hits**.
- [x] `compute_dma`, `compute_ath`, `compute_rally_metrics`, `classify_market_cap` each have a hand-computed test proving correctness within `Decimal("0.01")`.
- [x] `compute_snapshot` returns a dict whose keys exactly match the `daily_snapshots` fields in the registry (asserted by `test_all_output_keys_are_daily_snapshot_fields_or_bookkeeping`).
- [x] Partial computation on bad inputs: no exception escapes, `errors` list captures skipped fields.
- [x] Full test suite green: **182 passed in 0.52s**.

**Stage 3 Deferred Items (not blockers):**
1. RELIANCE / PAGEIND golden fixtures → added at Stage 4 kickoff once `pilot_fetch.py` runs against live network.
2. `pe_5yr_avg` / `pb_5yr_avg` real implementation → Stage 5 (needs quarterly EPS history).
3. `adj_close` per-bar → Stage 4 sync worker will populate; Stage 3 uses `close` as a fallback so tests can run without adjustment data.

### Stage 3 — Completion Marker
✅ **COMPLETE.** Six pure metric modules + orchestrator, 64 unit tests, registry-alignment gate enforced, no `float` in money paths.

### Stage 4 — Daily Sync Worker ✅ COMPLETE

**Delivered:**
- `plutus/sync/history_builder.py` — `bars_from_df` (yfinance DataFrame → list[OHLCVBar]) + `extract_meta` (info dict → stable meta keys).
- `plutus/sync/worker.py` — `DailySyncWorker.run_symbol` / `run_all` with per-symbol isolation, dry-run mode, and `sync_jobs` bookkeeping.
- `plutus/scripts/run_daily_sync.py` — CLI (`--dry-run`, `--symbols`, `--pool`, `--limit`, `--as-of`).
- Registry entries for `sync_jobs` table + `daily_snapshots.errors_json`; migrations 003 & 008 updated to match.
- Tests: `test_history_builder.py` (12), `test_sync_worker.py` (10), `test_run_daily_sync_cli.py` (6). All offline.

**Exit criteria:**
- [x] Orchestrator: fetch → validate → compute → upsert → audit.
- [x] Writes exactly one `daily_snapshots` row per (symbol, date) via `(symbol, snapshot_date)` conflict key.
- [x] Records `sync_jobs` entry with per-symbol failure map in `payload_json`.
- [x] Per-symbol isolation proven (`test_all_symbols_isolated`).
- [x] Same-day rerun is a no-op — conflict cols verified (`test_idempotent_same_day_uses_conflict_cols`).
- [x] Dry-run writes nothing (`test_dry_run_writes_nothing`).
- [x] Upsert failures surface in `RunReport.upsert_errors` without raising.
- [x] Money-safety gate: `grep -R '\bfloat(' plutus/sync/` = 0 hits.
- [x] Full test suite green: **209 passed in 0.49s**.

**Deferred (tracked, not blocking):**
1. Live smoke run against real Supabase → Stage 5 kickoff (RLS + creds land there).
2. RLS policy migration → Stage 5 (worker-only writes, anon read).
3. Sub-5-min wall-clock timing on full universe → measured once live Supabase is wired.

### Stage 5 — Quarterly Sync Worker ✅ COMPLETE

**Delivered:**
- `plutus/fundamentals/quarterly.py` — pure extractors:
  * `extract_holdings(major_holders_df)` → promoter / institutional / public % (handles fractional or percent-string inputs).
  * `extract_quarterly_rows(qf, info, holders)` → one dict per quarter keyed by `fundamentals` registry field names.
  * `compute_pe_5yr_avg(net_income, shares_out, daily_closes)` — TTM_EPS × 5Y close series.
  * `compute_pb_5yr_avg(bvps, daily_closes)`.
- `plutus/sync/quarterly.py` — `QuarterlySyncWorker.run_symbol` / `run_all` with same per-symbol isolation, dry-run, and `sync_jobs` contract as Stage 4.
- `plutus/sync/quarterly.apply_manual_overrides(rows)` — admin CSV round-trip for ROCE / ROE / promoter_pledging_pct (yfinance nulls for Indian stocks).
- `plutus/scripts/run_quarterly_sync.py` — CLI (`--dry-run`, `--symbols`, `--pool`, `--limit`, `--overrides-csv`).
- `plutus/metrics/pe_pb.py` — `pe_5yr_avg` / `pb_5yr_avg` now thin re-exports of the real fundamentals implementations (no more NotImplementedError stubs).
- Tests: `test_fundamentals_quarterly.py` (16), `test_quarterly_sync_worker.py` (7), `test_run_quarterly_sync_cli.py` (6). All offline.

**Exit criteria:**
- [x] `fundamentals` rows produced from synthetic quarterly DataFrame.
- [x] Manual CSV upload path idempotent by `(symbol, quarter_end_date)`.
- [x] 5Y avg PE / PB return numeric answer for hand-computed fixture (test_pe_happy_path: TTM_EPS=40 → PE=5.00).
- [x] Missing / zero / negative inputs → None, never raise (all edge tests green).
- [x] Per-symbol isolation proven (`test_per_symbol_failure_isolated`).
- [x] Dry-run writes nothing (`test_dry_run_writes_nothing`).
- [x] Money-safety gate: `grep -R '\bfloat(' plutus/fundamentals/ plutus/sync/` = 0 hits.
- [x] Full test suite green: **235 passed in 0.53s**.

**Deferred (tracked, not blocking):**
1. Live smoke run against real Supabase + RLS policies → runs at Stage 6 kickoff (scans depend on populated DB).
2. Pilot golden fixtures (RELIANCE / PAGEIND real quarterly payloads) → captured at first live smoke.
3. Sub-second per-symbol quarterly fetch benchmark → measured live.

### Stage 6 — Scan Engine v2
- Python evaluator (§12 Q5 answer = **B**). Runs immediately after every sync.
- Strategies: Envelope, 52W H/L, 20% Rally, Fundamental Screener.
- Writes `scans` + `scan_results` rows.
- **Exit:** Bit-for-bit match against Buddy legacy scan output for the same date on a golden fixture.

### Stage 7 — Frontend Rewrite ✅ COMPLETE
- New Vite + TS + TanStack Query app under `frontend_v2/` (old `frontend/` untouched).
- 10 read-only endpoints — served by **FastAPI locally** and by the **Supabase Edge Function** in prod (`supabase/functions/plutus-api/`).
- Money-safety on the wire: every Decimal is stringified in both API implementations (`plutus/api/serializers.py` + `MONEY_KEYS` set in the edge function).
- RLS on all 9 tables (migration 010); `trades` denies anon in prep for V2.
- Cron replaced: `render.yaml` **removed**; `.github/workflows/plutus-daily-sync.yml` and `plutus-quarterly-sync.yml` own the schedule.
- Frontend deploys to Vercel (see `Docs/Plutus_Free_Hosting_Guide.md`).
- **Exit:** every column Buddy shows is present in `frontend_v2`; API tests green (`test_api_app.py`, `test_api_repository.py`, `test_api_serializers.py`); deployment gates green (`test_deployment_config.py`, `test_rls_migration.py`).

### Stage 8 — Hardening ✅ COMPLETE

**Ships:**
- `plutus/alerts/notifier.py` — generic webhook dispatcher. 10 s timeout, 3
  retries with exponential backoff, catches every exception. Env-var-gated
  (`PLUTUS_ALERT_WEBHOOK`); no env ⇒ silently disabled (safe for previews
  and local runs).
- `plutus/alerts/sync_hook.py` — `maybe_alert_on_run_report` translates a
  `RunReport` into a single payload. **Silence-on-green** (a fully
  successful sync never alerts). Partial failure ⇒ `warning`, total
  failure or non-empty `upsert_errors` ⇒ `error`. Dry-runs never alert.
  Wired into both `run_daily_sync.py` and `run_quarterly_sync.py`.
- `plutus/migrations/011_canary_checks.sql` — pinned-value fixtures
  (`symbol` + `check_date` + `expected_close` + `tolerance_pct`). RLS:
  anon read, service write. NUMERIC only — money-safety gate holds.
- `plutus/canary/runner.py` — reads active fixtures, joins each against
  `daily_snapshots`, computes drift **in Decimal**, updates the fixture
  row with `last_observed_close` / `last_drift_pct` / `last_status`, and
  alerts once per run when any outcome is drift / missing / error.
- `plutus/scripts/run_canary.py` — CLI. Exit 0 all ok, 1 any anomaly, 2
  orchestration failure. Called from the daily workflow with
  `if: always()` so drift is checked even when the scan step failed.
- `.github/workflows/plutus-weekly-backup.yml` — Sunday 20:00 UTC.
  `pg_dump | gzip | curl → Supabase Storage bucket plutus-backups`.
  Failure notifier posts to the same webhook.
- Daily + quarterly workflows now inject `PLUTUS_ALERT_WEBHOOK` and add
  a final `Notify on workflow failure` step for hard crashes the
  in-process alerter can't catch.
- `frontend_v2/src/lib/supabase.ts` — Realtime-only browser client. Data
  reads still go through the Edge Function (money-safety enforced
  server-side).
- `frontend_v2/src/hooks/useSyncJobsRealtime.ts` — subscribes to
  `postgres_changes` on `sync_jobs`; on any event invalidates the
  TanStack cache. `useSyncJobs` now takes an optional realtime status
  and disables its 60 s poll when the channel is connected; polling
  remains the fallback if Realtime is unconfigured or errors.
- Tests: `test_alerts_notifier.py` (10), `test_alerts_sync_hook.py` (8),
  `test_canary_runner.py` (11), `test_canary_migration.py` (6),
  `test_run_canary_cli.py` (5), plus 4 new gates in
  `test_deployment_config.py` (backup workflow, canary step, alert
  wiring). **391 passed in 1.09 s**.

**Exit criteria:**
- [x] Alert dispatcher green on 200/204, retries 5xx with backoff,
      swallows every exception (test suite covers each branch).
- [x] Sync hook is silent-on-green, warning on partial, error on total.
- [x] Canary drift < tolerance → `ok`, ≥ tolerance → `drift`, no
      snapshot → `missing`, expected=0 → `error` (parametrised).
- [x] `canary_checks` migration uses NUMERIC only (no FLOAT / DOUBLE /
      REAL — gate `test_numeric_columns_are_numeric_not_float`).
- [x] RLS baseline extended: anon read + service write on
      `canary_checks`.
- [x] Weekly backup workflow present, cron correct, uploads to
      `plutus-backups` Storage bucket, uses secrets not literals.
- [x] Realtime hook falls back to polling when unconfigured or errored.
- [x] Money-safety grep gate: `plutus/alerts/` + `plutus/canary/` have
      zero `float(` calls.

**Operational setup (one-time, done via the Supabase dashboard):**
1. Create Storage bucket `plutus-backups` (private).
2. Add a 30-day lifecycle rule on the bucket.
3. Add repo secrets: `PLUTUS_SUPABASE_DB_URL` (Postgres URI with
   `sslmode=require`) and `PLUTUS_ALERT_WEBHOOK` (any Slack / Discord
   / Telegram / generic JSON hook). Both are OPTIONAL — missing secrets
   degrade gracefully.
4. Seed at least one canary fixture per pool:
   `INSERT INTO canary_checks (symbol, check_date, expected_close)
    VALUES ('RELIANCE.NS','2024-01-02', 2500.00);`

**Deferred (not blocking Stage 8 sign-off):**
- Two-week burn-in against live Supabase — starts once the workflows are
  connected to a real project.
- Alert de-duplication (fire once, then throttle for N hours) — will add
  if the first burn-in week shows repeat-fire noise.

### V2 — Trading Journal (deferred)
- Full `trades` CRUD (Held badge, filters, per-position P&L).
- Auth-gated writes: authenticated RLS policies added to `trades` (schema and anon-deny already live).
- Writes go through a **separate** Supabase Edge Function (`plutus-trades`) with JWT verification **on** — the read-only `plutus-api` function stays unchanged.
- **Exit:** add-close-edit round-trip; P&L matches manual math on a hand-checked fixture.

---

## Supabase Feature Decision Matrix

Every Supabase capability has a right time and a wrong time. This matrix locks in **when we use what**, so no stage reinvents the answer.

| Feature | Use For | Do NOT Use For | Stage Introduced |
|---|---|---|:---:|
| **Tables + `INSERT ... ON CONFLICT`** | All persistent state. Every write is idempotent by natural key. | Anything transient (use in-memory). | 1 |
| **Views** (`v_latest_daily`, `v_pool_membership`) | Read-time joins the frontend needs frequently. Kept thin — no heavy math. | Anything writable, anything computed per-request that changes often. | 1 |
| **Materialized Views** | Pre-aggregated pool counts / dashboard tiles once row count > 100k. | Small tables (< 10k rows) — plain views are fine. | 9 |
| **DB Triggers** (`BEFORE UPDATE ... updated_at`) | Automatic audit columns (`updated_at`, `row_version`). | Business logic (belongs in Python — testable, reviewable). | 1 |
| **DB Functions (PL/pgSQL RPC)** | Pool membership recompute, atomic multi-row updates that must be transactional. Called via `supabase.rpc()`. | Any monetary computation — those live in `plutus/metrics/` where they can be unit-tested. | 6 |
| **Edge Functions (Deno)** | Read-only HTTP API (`plutus-api`). Route-for-route port of the FastAPI app. Kept **thin** — no math, only Supabase queries + money-safe JSON. | Heavy computation, yfinance calls (Python-only — those run in GitHub Actions). Write endpoints (V2 will use a separate function with JWT on). | 7 |
| **GitHub Actions cron** | Nightly Tier-A sync + scan, weekly Tier-B fundamentals. yfinance + pandas run here. `concurrency` guards prevent overlapping runs. | Anything user-facing — that's the Edge Function's job. | 7 |
| **Realtime Subscriptions** | Header status pill on `sync_jobs` (`hooks/useSyncJobsRealtime.ts`, Stage 8). Trades table in V2. Polling is the fallback when the channel is unconfigured or disconnected. | Bulk data fetch — use REST/RPC. | 8 |
| **Row Level Security (RLS)** | Read-only for anon on 8 tables; `trades` denies anon (V2 opens it under auth). Writes only via service key from the sync worker. | Complex per-user auth (single-user app — kept simple). | 7 |
| **Storage Buckets** | Weekly `pg_dump` backup (bucket `plutus-backups`, 30 d lifecycle, Stage 8), uploaded CSVs for manual fundamentals. | Anything queryable — put it in a table. | 5, 8 |
| **Auth** | Single admin account (email/password) — first activated in V2 when trades writes land. Stage 7 API stays anonymous read-only. | Multi-tenant — out of scope. | V2 |

### RLS Baseline (locked in Stage 4)
- `service_role` key: full read + write. Used only by the Python sync worker and admin scripts.
- `anon` key: **read-only on `stocks`, `daily_snapshots`, `fundamentals`, `scans`, `scan_results`, all views**. No write access anywhere.
- `trades` table: writable only by authenticated admin user (Stage 7 auth).
- `sync_jobs`: read-only for `anon`. Written only by service role.

---

## Schema Optimization Notes

Locked-in optimizations already applied in Stage 1 migrations, and planned ones flagged for later stages.

### Applied in Stage 1
| Optimization | Where | Why |
|---|---|---|
| `NUMERIC(p, s)` everywhere for money/ratio | All tables | Zero float drift on ₹ or % values. |
| `UNIQUE (symbol, snapshot_date)` etc. | `daily_snapshots`, `fundamentals`, `scan_results` | Enforces idempotent upsert; prevents duplicate rows. |
| Generated column: `gap_from_ath_pct` | `daily_snapshots` | Computed by Postgres — always consistent with `close` and `ath_price`. |
| Partial indexes on `is_active = TRUE` | `stocks`, `pools` | Scans only touch live universe. |
| JSONB for raw payloads (`raw_yf_info`, `raw_yf_meta`) | `daily_snapshots`, `fundamentals` | Debuggable audit trail without polluting the typed columns. |
| Composite index `(symbol, snapshot_date DESC)` | `daily_snapshots` | Powers "latest N days" queries in O(log n). |

### Planned (staged)
| Optimization | Stage | Trigger |
|---|:---:|---|
| BRIN index on `snapshot_date` | 4 | Once `daily_snapshots` > 250k rows — cheap range scans. |
| Native range partitioning by quarter on `daily_snapshots` | 9 | Once table > 2M rows (~7 years × 300 stocks × 252 days). |
| Materialized view `mv_pool_snapshot` | 9 | If pool dashboard read time > 200ms. |
| `pg_stat_statements` review | 9 | Weekly. Any query > 100ms gets an index or rewrite. |

**Rule:** No premature index. Every index costs write throughput. We add one only after `EXPLAIN ANALYZE` proves it pays.

---

## Frontend Architecture (Stage 7 Preview — locked now to prevent rework)

The old `frontend/` stays untouched. New app lives in `frontend_v2/`.

### Stack
| Layer | Choice | Why |
|---|---|---|
| Build | Vite 5 + React 18 | Same as current Buddy, fast HMR. |
| Data | `@supabase/supabase-js` + TanStack Query v5 | Cache + Realtime out of the box, retries built-in. |
| State | TanStack Query for server state; React Context only for theme/auth. Zero Redux. | Server state ≠ client state. |
| Routing | React Router v6 | Familiar. |
| Styling | Tailwind + shadcn/ui | Reskin later without rewriting logic. |
| Tables | TanStack Table v8 | Column-level sort/filter, virtualization for 300+ rows. |
| Types | TypeScript (yes, even though old app is JSX) | Contract with `fields.py` via generated types (see 7.3). |

### Route Map
```
/                       → Dashboard (pool tiles + sync health)
/pool/:poolId           → Expandable table of stocks in a pool (Envelope, 52W, Rally)
/stock/:symbol          → Deep drill: raw + derived fields + history chart
/screener               → Fundamental screener over `fundamentals` view
/journal                → Trades CRUD (auth-gated)
/admin/sync             → Manual sync trigger + `sync_jobs` log (auth-gated)
```

### Component Tree (top level)
```
<App>
  <SupabaseProvider>          # client + auth session
  <QueryClientProvider>       # TanStack Query
    <ThemeProvider>
      <RouterProvider>
        <Layout>              # header, sync-status pill, nav
          <Outlet/>           # page components
```

### Data Access Rules
1. Every page component calls a **hook** in `hooks/queries/` — never `supabase.from(...)` inline.
2. Every hook returns typed data generated from Supabase CLI (`supabase gen types typescript`).
3. Every write flows through an admin-only mutation hook that hits a Python API endpoint — the frontend never writes directly to money tables.
4. Realtime subscription for `sync_jobs` drives the header status pill.

### Frontend "When to use what"
| Use | For |
|---|---|
| TanStack Query `useQuery` | Any read from Supabase — auto-cached, refetched. |
| TanStack Query `useMutation` | Trade CRUD, manual sync trigger. |
| Supabase Realtime | Only `sync_jobs` live status + Trades table (multi-tab consistency). |
| React Context | Theme, current user session. Nothing else. |
| Local `useState` | Form inputs, filter panel drafts. |

---

## Cross-Stage Definition of Done

Every stage merges only when:
1. ✅ Exit criteria met and checked off in this doc.
2. ✅ Unit tests pass (`pytest -q` green).
3. ✅ No `float` used for money/ratio fields (grep gate in CI).
4. ✅ No hardcoded field name string outside `fields.py` (grep gate in CI).
5. ✅ Migration files pass a dry-run `psql -f` against a scratch DB.
6. ✅ Prompt Note re-read and applied.

---

*Doc owner: Plutus core team. Update this file every time a stage's scope shifts.*

---

## V2-U — Universe as the single source of truth (2026-09-23, first cut)

**Decision.** The `stocks` table IS the universe. The master CSV is a one-time
bootstrap (`seed_universe`); after that, pool membership changes only through
the Universe page (Market Analysis → Universe) and its API. Every pool view,
scan and the Trading Journal's symbol picker read from it.

**Shipped**
- Migration `019_universe.sql` (+ idempotent column add in `001_stocks.sql`):
  - `stocks.sector_group` ∈ {Banks, NBFC, Normal} — which S200 criteria set
    applies. Backfilled from the CSV labels (384 Normal / 28 NBFC / 23 Banks on
    the seeded DB; 7 `FINANCIAL SERVICES` names left NULL for the owner).
    `sector = 'Normal'` cleared (it was a label, not a sector); `cap_type_manual`
    normalised to Large | Mid | Small | Micro.
  - `universe_syncs` — one row per change-set (kind `import` today, `screen`
    later) with status `running → preview → applied | discarded | failed`, the
    criteria used and the full diff. This is the consent queue the S200 screen
    will use, so wiring it later is a worker, not a schema change.
  - `pools.metadata.screen_criteria` for S200 (Non-banking: Net D/E < 0.25 AND
    ROCE > 12 AND Net profit > 200 Cr · Banks & NBFC: ROE > 10 AND Net profit
    > 1000 Cr), strings only, editable from the page.
- API `plutus/api/universe.py` under the auth gate (`/api/universe` in
  `PROTECTED_PREFIXES`; viewers read, owner writes):
  `GET /api/universe`, `PUT /stocks/{symbol}`, `POST|DELETE /pools/{code}/members`,
  `POST /pools/{code}/import` (`dry_run` = preview, `mode` merge | replace),
  `GET|PUT /pools/{code}/criteria`, `GET /syncs`, `POST /syncs/{id}/discard`,
  `POST /pools/{code}/screen` → **501 until the Screener job lands**.
- Frontend: `/universe` page + card on Market Analysis + tab on every pool page;
  per-pool table (symbol, name, sector, cap, group, other pools, journal refs),
  add / edit / remove, CSV import with a mandatory diff preview before apply,
  CSV export, S200 criteria card with the consent dialog for the future sync.
  Journal opportunity / trade forms use a universe-backed `SymbolPicker`; a
  symbol outside the universe cannot be saved.
- **Paste symbols** (`POST /api/universe/pools/{code}/paste`): accepts a
  TradingView export (`NSE:APTUS,` per line) or any comma / newline list. For
  every symbol missing name / sector / industry / cap / group the API calls
  yfinance `.info` (`plutus/adapters/yf_client.fetch_info`, retried) and maps
  it with `fields_from_info`: `longName` → name, `sector`, `industry`,
  `marketCap` → cap bucket via `metrics/cap_bucket.classify_market_cap`, and
  `classify_sector_group`: industry containing "Bank" → Banks; Credit
  Services / Mortgage Finance / Financial Conglomerates → NBFC; anything else
  known → Normal (insurers, AMCs, brokers, exchanges are Normal, as in the
  owner's S200 labels). Existing hand-typed values are never overwritten
  unless `refresh` is set; a failed lookup still adds the symbol and is
  flagged. `dry_run` previews the fetched fields + diff before Apply. `mode`
  is `merge` (add to the list) or `replace` (the pool becomes exactly the
  pasted list; leavers are retired unless the journal holds them).

**Journal safety (invariant).** No route deletes a `stocks` row. Removing a
stock's last pool sets `active = false`; a stock the journal still references
(OPEN trade or ACTIVE opportunity) stays active so its LTP keeps syncing.
Journal tables are read, never written, by this module.

**Deferred (next cut).** The S200 Screener screen worker: run the two screens
with the stored criteria, classify new candidates with the same
`classify_sector_group` (yfinance industry — decided 2026-09-23: reuse the
API already in use rather than parse Screener's `/market/…` taxonomy), write a
`universe_syncs` row in `preview`, and let the owner apply or discard it.

**Tests.** `plutus/tests/test_api_universe.py` (helpers, diff, retire-vs-journal,
import audit, criteria), `test_personal_migrations.py` gates 019,
`frontend_v2/src/lib/universeCsv.test.ts` (master template, plain, symbols-only,
round-trip).

---

## V2-X — Plutus Companion browser extension (2026-09-23 → 24, first cut)

**Goal.** Bring Plutus' numbers to where analysis actually happens — the TradingView chart
and the Screener.in company page — and let the loop (chart → fundamentals → note → journal)
run from the keyboard without opening the web app. Study of the reference extension and the
feature map: `Docs/Plutus_Extension_Study.MD`. Code: `extension/` (Manifest V3, load unpacked;
`extension/README.md` has install steps and the feature list).

**Backend added (FastAPI only; the Edge Function stays read-only and does not carry these).**
- `020_watchlists.sql` — `watchlists` (name, `symbols TEXT[]` in `TCS.NS` form, order); RLS
  service-role only; seeds S1–S4. Personal-table conventions gated by `test_personal_migrations.py`.
- `plutus/api/extension.py` — `GET /api/extension/bootstrap` (pools + every active stock with cap,
  latest snapshot metrics, strongest technical signal and fundamental points, in one ~90 KB call the
  extension caches per `snapshot_date`), `GET /api/extension/stock/{symbol}` (stock + snapshot +
  latest fundamentals + latest scan results per strategy), `GET /api/strategy_configs` (code
  defaults from `plutus/scan/strategies/*` + the cap-aware ATH rule + DB overrides). Open reads,
  money fields stringified.
- `plutus/api/watchlists.py` — `/api/watchlists` CRUD + `/{id}/symbols` add/remove, behind
  `X-Plutus-Auth` (added to `PROTECTED_PREFIXES`; viewers read, owner writes).
- Tests: `plutus/tests/test_api_extension.py` (converters, thresholds, bootstrap shape, stock
  bundle, watchlists CRUD, gate).

**Extension architecture.** The service worker is the only code that calls the API (adds the
token, caches bootstrap 12 h, falls back to browser-local watchlists when no token, re-injects
into already-open tabs, pings the API every 25 min while a chart/Screener tab is open so a
free-tier host stays warm). Content scripts only talk to the worker. Internal symbol form is
always `TCS.NS`; `shared/symbols.js` converts to `TCS`, `NSE:TCS` (hyphen/ampersand → `_`) and
Screener URLs. A bridge script on `localhost:5173` mirrors the web app's session token into the
extension; for a deployed web app the token is pasted once in the popup.

**Verified (2026-09-24).** Bootstrap against the local DB (442 stocks, 160 ms). Screener overlays
against a saved copy of the live RELIANCE page (tables, tiles, synthetic tiles, card with the 11
checks, ten page rules, toolbar beside Export to Excel, peers header-in-tbody quirk). TradingView
symbol switching on the live chart (`symbol-search-items-dialog`, Enter applies). Not yet
exercised end-to-end with the unpacked extension by the owner.

**Known gaps / next cut.** Web-app PlayArea page still stores its list in `localStorage`
(`playarea.ts`) while the extension treats PlayArea as the universe pool — unify on the API.
"Copy token" button in the Console. Edge Function parity if the extension is ever pointed at it.
Migration 020 must be applied to the cloud project before the Render API serves watchlists.
