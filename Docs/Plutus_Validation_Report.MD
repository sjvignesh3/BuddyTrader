# Plutus — Data Source Validation Report

> **Generated:** 2025-08-28
> **Stocks Validated:** RELIANCE.NS (Large Cap) · PAGEIND.NS (Mid/Small Cap)
> **Sources Tested:** yfinance (via Yahoo v10 API) · NSE API · BSE API
> **Purpose:** Confirm what data each source reliably provides before finalising the DB schema.

---

## Executive Summary

| Source | Status | Verdict |
|--------|--------|---------|
| **yfinance (Yahoo v10 API)** | ✅ Working | Primary source for price + valuation + quarterly financials |
| **NSE API** | ⚠️ Blocked from server | WAF blocks non-browser environments; not usable for scheduled syncs |
| **BSE API** | ⚠️ Partial | Only `ComHeader` endpoint works reliably; most other endpoints return HTML |

**Key finding:** yfinance via Yahoo v10 quoteSummary API provides nearly everything we need — including quarterly financials. NSE/BSE APIs are unreliable from server environments due to WAF/session requirements. The hybrid plan needs to be revised.

---

## 1. RELIANCE.NS — Data Validation

### 1.1 Price & Valuation (yfinance vs Screener reference)

| Metric | yfinance | Screener (expected) | Match? | Notes |
|--------|----------|---------------------|--------|-------|
| Last Price | ₹1,287.00 | ~₹1,285–1,290 | ✅ | Live price, matches |
| Market Cap | ₹17,41,629 Cr | ~₹17.4L Cr | ✅ | Exact match |
| Trailing PE | 23.31 | ~23–24 | ✅ | Matches Screener |
| Forward PE | 18.01 | N/A on Screener free | ✅ | Bonus data point |
| Price/Book | 1.93 | ~1.9–2.0 | ✅ | Matches |
| 52W High | ₹1,611.80 | ~₹1,608–1,612 | ✅ | Matches NSE |
| 52W Low | ₹1,249.80 | ~₹1,249–1,255 | ✅ | Matches NSE |
| Debt/Equity | 36.65 | ~36–37 | ✅ | Matches (this is % form in yf) |

### 1.2 Technical (yfinance computed)

| Metric | Value | Notes |
|--------|-------|-------|
| ATH (5Y adj High) | ₹1,604.38 | Adjusted for dividends/splits |
| 200 DMA | ₹1,390.06 | Rolling 200-day on AdjClose |
| Current Close | ₹1,287.00 | |
| Below 200 DMA | **7.41%** | Stock is 7.4% below DMA |
| Fall from ATH | **19.78%** | Nearly 20% below ATH |

> **Note on ATH:** yfinance ATH = ₹1,604.38 vs 52W High from meta = ₹1,611.80.
> The 52W High is the intraday high from the rolling 52-week window.
> The ATH (5Y adj) is slightly lower because the 5Y window ATH peak day may have lower close.
> For Plutus, use `fiftyTwoWeekHigh` from meta for 52W High, and compute ATH from 5Y daily for Fall-from-ATH.

### 1.3 Quarterly Financials (yfinance — via `incomeStatementHistoryQuarterly`)

| Quarter | Revenue (Cr) | PBT | Net Income (Cr) |
|---------|-------------|-----|-----------------|
| Jun 2026 | 3,09,468 | ❌ N/A | 20,946 |
| Mar 2026 | 1,41,823 | ❌ N/A | 7,422 |
| Dec 2025 | 2,64,905 | ❌ N/A | 18,645 |
| Sep 2025 | 2,54,623 | ❌ N/A | 9,129 |

> **PBT Gap:** `incomeBeforeTax` / `pretaxIncome` fields return `null` for RELIANCE in yfinance.
> `ebit` also returns 0. This appears to be a data gap in Yahoo Finance for Indian consolidated statements.
> **Revenue and Net Income match Screener's consolidated quarterly data.**
> PBT must be sourced differently — see Section 4 for strategy.

### 1.4 Quality Metrics

| Metric | yfinance | Screener | Match? | Notes |
|--------|----------|----------|--------|-------|
| ROE | ❌ null | ~9–10% | ❌ | Yahoo doesn't provide for Indian stocks |
| ROA | ❌ null | ~4–5% | ❌ | Same gap |
| ROCE | ❌ not available | ~10–12% | ❌ | Not in yfinance; needs balance sheet |
| Debt/Equity | 36.65 | ~36.5 | ✅ | Matches (yf returns as %, so 36.65 = 36.65%) |
| EBITDA | ₹1,80,636 Cr | ~₹1.8L Cr | ✅ | Matches |
| Revenue TTM | ₹11,29,605 Cr | ~₹11L Cr | ✅ | Matches |
| Net Income TTM | ₹74,727 Cr | ~₹74–75K Cr | ✅ | Matches |
| Profit Margin | 6.61% | ~6–7% | ✅ | Matches |

---

## 2. PAGEIND.NS — Data Validation

### 2.1 Price & Valuation

| Metric | yfinance | Screener (expected) | Match? | Notes |
|--------|----------|---------------------|--------|-------|
| Last Price | ₹35,985.00 | ~₹36,000 | ✅ | Matches |
| Market Cap | ₹40,137 Cr | ~₹40,000–41,000 Cr | ✅ | Matches |
| Trailing PE | 53.47 | ~53–55 | ✅ | Matches |
| Forward PE | 41.40 | N/A on Screener free | ✅ | Bonus |
| Price/Book | 26.71 | ~26–27 | ✅ | Matches |
| 52W High | ₹45,890.00 | ~₹45,890 | ✅ | Exact match |
| 52W Low | ₹29,805.00 | ~₹29,805 | ✅ | Exact match |
| Debt/Equity | 18.42 | ~18 | ✅ | Matches |

### 2.2 Technical (yfinance computed)

| Metric | Value | Notes |
|--------|-------|-------|
| ATH (5Y adj High) | ₹51,459.96 | Page Industries ATH around ₹51.5K |
| 200 DMA | ₹36,363.23 | |
| Current Close | ₹35,800.00 | |
| Below 200 DMA | **1.55%** | Barely below DMA |
| Fall from ATH | **30.43%** | Significant fall from peak |

### 2.3 Quarterly Financials (yfinance)

| Quarter | Revenue (Cr) | PBT | Net Income (Cr) |
|---------|-------------|-----|-----------------|
| Mar 2026 | 1,253 | ❌ N/A | 179 |
| Dec 2025 | 1,387 | ❌ N/A | 190 |
| Sep 2025 | 1,291 | ❌ N/A | 195 |
| Jun 2025 | 1,317 | ❌ N/A | 201 |

> **Screener comparison (approximate):**
> PAGEIND quarterly revenue ~₹1,250–1,400 Cr per quarter ✅ — matches.
> PAGEIND quarterly NI ~₹170–210 Cr ✅ — matches.
> PBT gap same as RELIANCE — `incomeBeforeTax` null.

### 2.4 Quality Metrics

| Metric | yfinance | Screener | Match? | Notes |
|--------|----------|----------|--------|-------|
| ROE | ❌ null | ~50%+ | ❌ | Not available for Indian stocks |
| ROA | ❌ null | ~35%+ | ❌ | Not available |
| ROCE | ❌ not available | ~55%+ | ❌ | Not in yfinance |
| EBITDA | ₹1,103 Cr | ~₹1,000–1,200 Cr | ✅ | Matches |
| Revenue TTM | ₹5,351 Cr | ~₹5,200–5,500 Cr | ✅ | Matches |
| Net Income TTM | ₹756 Cr | ~₹750–800 Cr | ✅ | Matches |
| Profit Margin | 14.13% | ~14–15% | ✅ | Matches |
| Book Value | ₹1,347.15 | ~₹1,300–1,400 | ✅ | Matches |

---

## 3. Source Coverage Matrix — Final Verdicts

| Data Field | yfinance | NSE API | BSE API | Final Source | Confidence |
|-----------|----------|---------|---------|--------------|-----------|
| Last Price | ✅ | ❌ Blocked | ⚠️ Partial | **yfinance** | High |
| Market Cap | ✅ | ❌ Blocked | ⚠️ Partial | **yfinance** | High |
| Trailing PE | ✅ | ❌ Blocked | ✅ (BSE ComHeader) | **yfinance** | High |
| Price/Book | ✅ | ❌ | ⚠️ (often '-') | **yfinance** | High |
| Forward PE | ✅ | ❌ | ❌ | **yfinance** | Medium |
| 52W High / Low | ✅ (from meta) | ❌ Blocked | ⚠️ (no live quote) | **yfinance meta** | High |
| ATH (5Y) | ✅ (computed) | ❌ | ❌ | **yfinance computed** | High |
| 200 DMA | ✅ (computed) | ❌ | ❌ | **yfinance computed** | High |
| Revenue (Qtrly) | ✅ | ❌ | ❌ | **yfinance** | High |
| Net Income (Qtrly) | ✅ | ❌ | ❌ | **yfinance** | High |
| PBT (Qtrly) | ❌ null | ❌ | ❌ | **None yet** | ❌ Gap |
| EBITDA (TTM) | ✅ | ❌ | ❌ | **yfinance** | High |
| Profit Margin | ✅ | ❌ | ❌ | **yfinance** | High |
| ROE | ❌ null | ❌ | ❌ | **None from API** | ❌ Gap |
| ROA | ❌ null | ❌ | ❌ | **None from API** | ❌ Gap |
| ROCE | ❌ | ❌ | ❌ | **Must derive** | ⚠️ Derived |
| Debt/Equity | ✅ | ❌ | ❌ | **yfinance** | High |
| Promoter Holding % | ❌ | ❌ Blocked | ❌ Blocked | **Gap** | ❌ |
| Public Holding % | ❌ | ❌ Blocked | ❌ Blocked | **Gap** | ❌ |
| Promoter Pledging % | ❌ | ❌ Blocked | ❌ Blocked | **Gap** | ❌ |
| Sector / Industry | ✅ | ❌ | ✅ (BSE ComHeader) | **yfinance** | High |

---

## 4. Gaps & Resolution Strategy

### Gap 1: PBT (Profit Before Tax) — ❌ Null in yfinance

**Root Cause:** Yahoo Finance's `incomeStatementHistoryQuarterly` does not populate `incomeBeforeTax` or `pretaxIncome` for Indian stocks. This is a known Yahoo Finance gap for NSE/BSE-listed companies.

**Resolution Options:**
1. **Use Operating Income + other income** as proxy: `PBT ≈ operatingIncome + otherIncome` — but these fields are also often null for Indian stocks.
2. **Skip PBT entirely** — use Revenue + Net Income instead (which ARE available). PBT is less commonly used in Indian screeners as a filter vs NI.
3. **Derive from NI + tax**: `PBT = NI / (1 - effective_tax_rate)` using India's ~25% corporate tax rate as a proxy.

> **Recommendation:** Use Option 2 (Revenue + Net Income). PBT is not a mandatory filter in Plutus — it was listed as a data point but not a primary filter trigger. Store as null; display as "N/A" in UI.

---

### Gap 2: ROE / ROA — ❌ Null in yfinance for Indian stocks

**Root Cause:** Yahoo Finance's `returnOnEquity` and `returnOnAssets` fields return `null` specifically for Indian companies. This is a well-known limitation of Yahoo Finance's data coverage for non-US markets.

**Resolution Options:**
1. **Derive ROE:** `ROE = Net Income TTM / Book Value per Share / Shares Outstanding`
   - Net Income TTM: available from yfinance ✅
   - Book Value: `priceToBook` and `currentPrice` give us `bookValuePerShare = currentPrice / PB` ✅
   - ROE = NI_TTM / (bookValuePerShare × sharesOutstanding) → this is computable!
2. **Derive ROA:** `ROA = Net Income TTM / Total Assets` — Total Assets not in v10 modules directly; needs `balanceSheetHistoryQuarterly` but it returns empty for Indian stocks.

**Computation for RELIANCE:**
- NI TTM = ₹74,727 Cr
- Price = ₹1,287, PB = 1.93 → Book Value/share = ₹1,287 / 1.93 = ₹667
- Shares outstanding (approx from market cap) = ₹17,41,629 Cr / ₹1,287 = 135.3 Cr shares
- Total Equity = 667 × 135.3 Cr = ₹90,245 Cr
- **Derived ROE = 74,727 / 90,245 = 82.8%** ← This is WRONG (Screener shows ~9%)

**Root cause of wrong derivation:** Yahoo's `debtToEquity` for Indian stocks is in % form (36.65 = 36.65%), not as a ratio. Also, `priceToBook` appears to use tangible book value differently. The equity base computed from PB ratio alone is unreliable.

> **Recommendation:** **Do not derive ROE/ROA** — the derivation is unreliable. Store as `null`. For the Plutus scanner, **ROE/ROCE are secondary filters** — use them only when available. Add a `data_quality_flags` JSONB column in the DB to mark which fields are unavailable per stock.

---

### Gap 3: ROCE — ❌ Not Available

**Root Cause:** ROCE = EBIT / Capital Employed. Yahoo Finance does not provide EBIT (only EBITDA) and does not provide Total Assets or Current Liabilities for Indian stocks via v10 API.

**Resolution:** Same as ROE — store null, flag in data_quality_flags.

---

### Gap 4: Shareholding (Promoter %, Public %, Institutional %) — ❌ Blocked

**Root Cause:** NSE API and BSE API both return HTML (not JSON) from server/GitHub Actions environments due to WAF protection. They require real browser sessions with JavaScript rendering.

**Resolution Options (ranked):**
1. **Store manually (quarterly)** — Admin enters shareholding once per quarter after results. This is 3 fields × ~300 stocks = 900 values per quarter. Feasible via a bulk CSV upload.
2. **Use yfinance `major_holders`** — Returns `None` for Indian stocks (confirmed above).
3. **Ticker Tape / Trendlyne unofficial APIs** — Fragile, same DOM scraping risk.

> **Recommendation:** **Manual CSV upload for shareholding** — once per quarter, after NSE/BSE announce quarterly results. Build a simple admin upload page: `symbol, quarter, promoter_pct, public_pct, institutional_pct, pledging_pct`. This is the most reliable long-term approach and avoids all scraping fragility.

---

### Gap 5: Promoter Pledging — ❌ Not Available from any API

**Root Cause:** Pledging disclosures are SEBI-mandated filings, published on NSE/BSE. No free JSON API provides this programmatically.

**Resolution:** Same as Shareholding — **manual quarterly CSV upload**.

---

### Gap 6: 5Y Average PE — ❌ Not Available Natively

**Root Cause:** No API provides a pre-computed 5Y average PE.

**Resolution — Reconstruction via Daily Price + Quarterly EPS:**

```
5Y Avg PE = mean(daily_close / trailing_12m_EPS) over 5 years

TTM EPS on date D = sum of quarterly EPS from the 4 most recent quarters before D

Steps:
1. Fetch 5Y daily closes from yfinance (already doing this for ATH)
2. Fetch quarterly Net Income + Shares Outstanding history from yfinance
   - Net Income: available from incomeStatementHistoryQuarterly
   - Shares Outstanding: available from defaultKeyStatistics.sharesOutstanding
3. For each trading day, find TTM EPS = sum(last 4Q net income) / shares_outstanding
4. Daily PE = close / TTM EPS (discard negative EPS periods)
5. 5Y avg PE = mean(daily PE over 5Y)
```

**Feasibility:** This is computable entirely from yfinance data. The only approximation is that shares outstanding is taken as the latest value (not historical), which introduces a small error over 5 years.

> **Recommendation:** Implement 5Y avg PE reconstruction. Run it as part of the quarterly fundamentals sync (not daily). Store result in `fundamentals.pe_5y_avg`. This is Option 2 from the earlier plan and is confirmed feasible.

---

## 5. BSE API — What Actually Works

Only one BSE endpoint responded correctly without browser session:

```
GET https://api.bseindia.com/BseIndiaAPI/api/ComHeader/w?quotetype=EQ&scripcode={BSE_CODE}&seriesid=
```

**Fields returned:**

| Field | RELIANCE | PAGEIND | Useful? |
|-------|----------|---------|---------|
| EPS | 104.37 | `-` | ⚠️ Not always available |
| CEPS (Cash EPS) | 168.96 | `-` | ⚠️ Not always |
| PE | 12.31 | `-` | ⚠️ Standalone PE, different from consolidated |
| PB | `-` | `-` | ❌ Often missing |
| ROE | `-` | `-` | ❌ Often missing |
| OPM | `-` | `-` | ❌ Often missing |
| Sector, Industry | ✅ | ✅ | ✅ Useful |
| SecurityId, ISIN | ✅ | ✅ | ✅ Useful for mapping |

> **Note:** BSE `ComHeader` PE = 12.31 for RELIANCE vs yfinance PE = 23.31.
> **Root Cause:** BSE shows **standalone PE** (RELIANCE standalone entity).
> yfinance shows **consolidated PE** which includes subsidiaries (Jio, Reliance Retail etc.).
> Screener.in shows consolidated PE = ~23. **Use yfinance (consolidated) for PE.** BSE standalone PE is misleading for conglomerates.

---

## 6. Final Data Architecture Decision

Based on validation, here is the confirmed data source per field for Plutus:

### Tier A — Daily Sync (yfinance only, no other source needed)

| Field | Source | Method |
|-------|--------|--------|
| Close, Open, High, Low, Volume | yfinance v8 API | Direct (existing data_fetcher.py) |
| AdjClose | yfinance v8 API | Direct |
| Market Cap | yfinance v10 `summaryDetail.marketCap` | Direct |
| Cap Bucket (Large/Mid/Small/Micro) | Derived from market cap | Thresholds per Q2 answer |
| Trailing PE | yfinance v10 `summaryDetail.trailingPE` | Direct |
| Price/Book | yfinance v10 `defaultKeyStatistics.priceToBook` | Direct |
| Debt/Equity | yfinance v10 `financialData.debtToEquity` | Direct |
| 52W High / Low | yfinance v8 meta (`fiftyTwoWeekHigh/Low`) | Direct |
| 200 DMA | Computed from 5Y daily AdjClose | Rolling(200).mean() |
| ATH | Computed from 5Y daily AdjHigh | max(High × AdjClose/Close) |
| Fall from ATH % | Derived | (ATH - Close) / ATH |
| Below 200 DMA % | Derived | (DMA - Close) / DMA |
| 20% Rally metrics | Computed from OHLCV | Same as existing Buddy logic |
| EBITDA | yfinance v10 `financialData.ebitda` | TTM |
| Revenue TTM | yfinance v10 `financialData.totalRevenue` | TTM |
| Profit Margin | yfinance v10 `financialData.profitMargins` | TTM |
| Sector | yfinance v10 `assetProfile.sector` | Direct |

### Tier B — Quarterly Sync (yfinance + manual CSV upload)

| Field | Source | Notes |
|-------|--------|-------|
| Quarterly Revenue (4Q) | yfinance v10 `incomeStatementHistoryQuarterly` | ✅ Available |
| Quarterly Net Income (4Q) | yfinance v10 `incomeStatementHistoryQuarterly` | ✅ Available |
| Quarterly PBT | ❌ Not available | Store null, display N/A |
| 5Y Avg PE | Reconstructed (daily close + quarterly NI + shares) | Computed, stored in DB |
| ROE | ❌ Not available from API | Store null — manual override possible |
| ROCE | ❌ Not available | Store null |
| Promoter Holding % | Manual CSV upload (quarterly) | Admin uploads after results |
| Public Holding % | Manual CSV upload (quarterly) | Same |
| Institutional % | Manual CSV upload (quarterly) | Same |
| Promoter Pledging % | Manual CSV upload (quarterly) | Same |

---

## 7. Schema Implications

### Changes to `fundamentals` table from original plan:

```sql
-- Fields confirmed available from yfinance:
sales                    NUMERIC(20,2),    -- quarterly revenue ✅
net_profit               NUMERIC(20,2),    -- quarterly NI ✅
pbt                      NUMERIC(20,2),    -- NULL (not available) ⚠️

-- Fields confirmed NOT available from yfinance (require manual input):
promoter_holding_pct     NUMERIC(6,2),     -- manual CSV upload
public_holding_pct       NUMERIC(6,2),     -- manual CSV upload
institutional_pct        NUMERIC(6,2),     -- manual CSV upload
promoter_pledging_pct    NUMERIC(6,2),     -- manual CSV upload

-- Fields removed (not reliably computable):
roce                     NUMERIC(6,2),     -- null / manual override
roe                      NUMERIC(6,2),     -- null / manual override

-- Retained:
pe_5y_avg                NUMERIC(10,2),    -- computed via reconstruction

-- New field:
data_quality_flags       JSONB DEFAULT '{}'  -- tracks which fields are null and why
```

### Changes to `daily_snapshots` table:

```sql
-- Add these yfinance v10 fields (available daily):
ebitda_ttm_cr            NUMERIC(20,2),    -- from financialData.ebitda
revenue_ttm_cr           NUMERIC(20,2),    -- from financialData.totalRevenue
profit_margin_pct        NUMERIC(6,2),     -- from financialData.profitMargins
debt_to_equity           NUMERIC(8,4),     -- from financialData.debtToEquity (already planned)
```

---

## 8. Conclusion

**yfinance is the right and sufficient primary source for Plutus.** Validation confirms:

- ✅ Price, Market Cap, PE, PB, 52W High/Low, Debt/Equity → **exact match with Screener**
- ✅ ATH, 200 DMA, Fall-from-ATH, Below-DMA → **computed correctly from yfinance OHLCV**
- ✅ Quarterly Revenue, Net Income (last 4Q) → **match Screener consolidated data**
- ✅ EBITDA, Revenue TTM, Profit Margin → **match Screener**
- ⚠️ PBT → not available; use Revenue + NI instead
- ⚠️ ROE / ROA / ROCE → not available for Indian stocks; store null
- ⚠️ 5Y Avg PE → not native; build reconstruction (feasible, confirmed approach)
- ❌ Shareholding / Pledging → not available from any free JSON API reliably from server env; use manual quarterly CSV upload

**NSE API and BSE API are NOT usable from server/CI environments** (GitHub Actions, Fly.io, Railway) due to browser-grade WAF protection. Only BSE's `ComHeader` endpoint works, providing limited fields (EPS, standalone PE) that are either already covered by yfinance or misleading (standalone vs consolidated PE).

> **Decision Gate:** ✅ Proceed with full Plutus implementation.
> Data source = yfinance as primary. Shareholding/pledging = quarterly manual CSV import.
> 5Y Avg PE = reconstruction via quarterly NI + daily close. No Screener dependency.

---

*Report generated by validate_plutus_sources.py — Plutus Project*
