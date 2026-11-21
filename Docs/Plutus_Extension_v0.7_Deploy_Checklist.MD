# Plutus Companion v0.7.0: deploy checklist

> **Date:** 2026-11-21 · **Code:** `main` at `191702e`. It is merged locally but **not pushed** (8 commits ahead of `origin/main`).
> **Why the order matters:** a push to `main` auto-deploys the API on Render. It also means the next Sunday 02:00 UTC `plutus-quarterly-sync` run uses the new code, and that code writes new `fundamentals` columns. Apply the migrations **first**.

---

## 1. Database: what changed

| Migration | Table | Change | Needed by | Order |
|---|---|---|---|---|
| `028_watchlist_color.sql` | `watchlists` | `+ color VARCHAR(7)` (`#rrggbb` or NULL, CHECK) | label colours in the extension | **before** the push (the new API selects and writes `color`) |
| `029_fundamentals_pe_medians.sql` | `fundamentals` | `+ pe_median_3y, pe_median_5y, pe_median_10y, pe_low_10y, pe_high_10y` | Valuation box, Screener P/E tiles | before the push (the quarterly sync writes them) |
| `030_fundamentals_leverage.sql` | `fundamentals` | `+ operating_profit_ttm, depreciation_ttm, interest_ttm, borrowings` | interest coverage, debt / EBITDA | before the push (same reason) |

- **No new tables.**
- All three migrations are nullable `ADD COLUMN IF NOT EXISTS` and are safe to re-run.
- `004_fundamentals.sql` got the same columns appended, so a fresh database built from 001→030 is consistent. On the existing database, only run 028–030.

### 1.1 Check what the cloud database already has

Some earlier migrations were also still listed as pending on cloud (021–027). Paste this into **Supabase → SQL Editor** and run it. Every column should read `true`; any `false` is a migration still to apply, **in number order**:

```sql
select
  exists (select 1 from information_schema.columns where table_name = 'fundamentals'    and column_name = 'gross_npa_pct')         as m021_bank_fundamentals,
  exists (select 1 from information_schema.columns where table_name = 'daily_snapshots' and column_name = 'price_change_1d_pct')   as m022_day_change,
  exists (select 1 from pg_proc where proname = 'plutus_reset_sequences')                                                          as m023_reset_sequences,
  to_regclass('public.ipo_applications') is not null                                                                               as m024_ipo_journal,
  to_regclass('public.notebook_items')   is not null                                                                               as m025_notebook,
  exists (select 1 from information_schema.columns where table_name = 'pools'           and column_name = 'market')                as m026_markets,
  exists (select 1 from information_schema.columns where table_name = 'journal_trades'  and column_name = 'market')                as m027_journal_markets,
  exists (select 1 from information_schema.columns where table_name = 'watchlists'      and column_name = 'color')                 as m028_watchlist_color,
  exists (select 1 from information_schema.columns where table_name = 'fundamentals'    and column_name = 'pe_median_3y')          as m029_pe_medians,
  exists (select 1 from information_schema.columns where table_name = 'fundamentals'    and column_name = 'operating_profit_ttm')  as m030_leverage;
```

### 1.2 Apply the missing ones

Supabase → **SQL Editor** → New query → paste the **whole file** → Run, one file at a time in number order:

1. `BuddyTrader/plutus/migrations/028_watchlist_color.sql`
2. `BuddyTrader/plutus/migrations/029_fundamentals_pe_medians.sql`
3. `BuddyTrader/plutus/migrations/030_fundamentals_leverage.sql`

Run the check query again; all ten columns should now read `true`. (With psql the equivalent is `psql "$PLUTUS_SUPABASE_DB_URL" -f <file>`, but the SQL Editor needs nothing installed.)

> ⚠ If **m027** reads `false`: the US-journal deploy rule still applies. Deploy the backend first, **then** apply 027, then 028–030. 027 changes journal `qty` from INT to NUMERIC, and an older backend would break on it. The current `main` backend already handles both. So the safe sequence in that case is: 028–030 → push → wait for Render → 027.

### 1.3 Local stack (optional, for the backup-based test environment)

The same three files go into the local database (port 56322) the same way, or with `psql` against it. See `Plutus_Extension_Implementation_Plan_v0.3.MD` §1.

---

## 2. Backend

| Step | What | How |
|---|---|---|
| 2.1 | Push `main` | `git push origin main`. Render rebuilds the FastAPI service. The Vercel web app also rebuilds, but it has **no** changes in this release |
| 2.2 | Wait for Render | Dashboard shows *Live*, or open `https://plutus-api-2zyu.onrender.com/api/health` |
| 2.3 | Check the new payload | `https://plutus-api-2zyu.onrender.com/api/extension/bootstrap` should show `"version": 2`, a `check_labels` object, a `checks` map on each stock, and `"market"` on each pool |
| 2.4 | Edge Function (only if the web app reads from it) | `MONEY_KEYS` gained the new column names, so the Edge Function sends them as strings: `supabase functions deploy plutus-api --no-verify-jwt`. The extension talks to Render only, so it does not need this |
| 2.5 | Fill the new columns | GitHub → **Actions** → `plutus-quarterly-sync` → **Run workflow**. Run it first with `pool = F40` (about 15 minutes) to check, then with the pool left blank for everything (about 2 hours). Or wait for the Sunday 02:00 UTC run |
| 2.6 | Check the fill | SQL Editor: `select symbol, pe_median_10y, pe_low_10y, pe_high_10y, operating_profit_ttm, interest_ttm, borrowings from fundamentals where pe_median_10y is not null order by quarter_end_date desc limit 10;` |

No new environment variables, secrets or cron jobs.

---

## 3. Extension (unpacked)

| Step | What |
|---|---|
| 3.1 | `chrome://extensions` → **Plutus Companion** → **Reload** (↻). The version should read **0.7.0** |
| 3.2 | New site access: the manifest now lists stockanalysis.com, roic.ai, vcpscanner.com and stockresearch.app. Unpacked extensions get them on reload. If Chrome shows "This extension requires new permissions", accept |
| 3.3 | Reload every open TradingView, Screener and web-app tab once (old content scripts stay in a tab until it reloads) |
| 3.4 | Popup → **Test connection**. It should show `connected` and the token line `owner token · valid until …`. If it says the token is rejected, click **Allow token bridge on this site** and sign in on the web app again |
| 3.5 | Popup settings to look at (all on by default): *Live Last / Chg%* with the 15 / 30 / 60 s interval, *Hover a row: Plutus checks card*, and *US research sites* |

---

## 4. Smoke test (about 10 minutes)

| Where | Check |
|---|---|
| TradingView panel | `● live` badge; Last and Chg% tick during market hours; the Chg% header sorts gainers and losers |
| Panel rows | hover a row: the checks card appears; `L` or `🏷` opens the labels popover; tick a list; a coloured dot appears on the row |
| Drawer → Filters | turn on a rule chip (e.g. ROCE) and the list narrows; `⭐ All pass` keeps 11/11 only |
| Drawer → Stock | full Plutus card; **Valuation vs history** appears after step 2.5 has run for that stock |
| Drawer → Trades | open position card, closed trades with realised P&L and win rate |
| Drawer → Notes | add with Ctrl+Enter, edit, delete |
| Region | `🇺🇸 US` switches to USMEGA and US watchlists; a US holding shows its HELD chip |
| A stock outside Plutus | open any non-pool ticker on the chart: Stock tab shows the grey *provisional* card |
| Screener.in | same card above the ratios; new tiles *Median PE 3Y / 10Y*, *PE 10Y range*, *Interest coverage*, *Debt / EBITDA* (after step 2.5) |
| US sites | one stock each on stockanalysis.com (Financials), roic.ai (financials), vcpscanner.com (stock → financials), stockresearch.app (overview): tables coloured, pill bottom-right, three P/E tiles on stockresearch. **These four were tested only on a harness page**, so report any table that stays plain, with its URL |

---

## 5. Rollback

| Piece | How |
|---|---|
| Extension | `git checkout 11c304a -- extension` and reload; or keep the code and switch features off in the popup (live prices, hover card, US sites) |
| Backend | Render → *Deploys* → redeploy the previous build. The old API ignores the new columns |
| Database | Nothing to roll back. The columns are nullable and unused by older code. If you really need to drop them: `alter table watchlists drop column color;` and the matching `alter table fundamentals drop column …` |
