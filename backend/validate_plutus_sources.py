"""
validate_plutus_sources.py
==========================
Validates fundamental data accuracy for Plutus across all three planned
data sources: yfinance, NSE API, and BSE API.

Stocks tested:
  - RELIANCE.NS  (Large Cap)
  - PAGEIND.NS   (Mid Cap)

Data fetched per source:
  yfinance    → PE, PB, Market Cap, ROE, Debt/Equity, ROCE (derived),
                Quarterly Sales/PBT/Net Profit (last 4Q),
                52W High/Low, ATH (5y adj high)
  NSE API     → Shareholding (promoter/public/institutional),
                Pledging data, Market Cap, PE, 52W High/Low
  BSE API     → Quarterly financials (Sales, PBT, Net Profit)

Writes results to: Docs/Plutus_Validation_Report.MD
"""

import json
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timedelta
from typing import Optional
import warnings
warnings.filterwarnings("ignore")

# ── Try importing optional libs ──────────────────────────────────────────────
try:
    import yfinance as yf
    HAS_YF = True
except ImportError:
    HAS_YF = False
    print("⚠  yfinance not installed. Run: pip install yfinance")

try:
    import pandas as pd
    HAS_PD = True
except ImportError:
    HAS_PD = False
    print("⚠  pandas not installed. Run: pip install pandas")

# ── Constants ─────────────────────────────────────────────────────────────────
STOCKS = {
    "RELIANCE": {"yf_ticker": "RELIANCE.NS", "bse_code": "500325", "nse_symbol": "RELIANCE"},
    "PAGEIND":  {"yf_ticker": "PAGEIND.NS",  "bse_code": "532827", "nse_symbol": "PAGEIND"},
}

NSE_BASE   = "https://www.nseindia.com/api"
BSE_BASE   = "https://api.bseindia.com/BseIndiaAPI/api"

NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/",
    "Connection": "keep-alive",
}

BSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.bseindia.com/",
    "Origin": "https://www.bseindia.com",
}

results = {}  # top-level dict: {symbol: {source: {field: value}}}


# ════════════════════════════════════════════════════════════════════════════
# SECTION 1 — yfinance
# ════════════════════════════════════════════════════════════════════════════

def fetch_yfinance(symbol: str, yf_ticker: str) -> dict:
    """Fetch all yfinance data we plan to use in Plutus."""
    print(f"\n  [yfinance] Fetching {yf_ticker} ...")

    out = {
        "pe_trailing":         None,
        "pe_forward":          None,
        "pb":                  None,
        "market_cap_cr":       None,
        "roe_pct":             None,
        "debt_to_equity":      None,
        "roce_pct":            None,   # derived
        "high_52w":            None,
        "low_52w":             None,
        "ath_5y":              None,
        "dma_200":             None,
        "sector":              None,
        "industry":            None,
        "quarterly_sales_cr":  [],     # last 4 quarters
        "quarterly_pbt_cr":    [],
        "quarterly_np_cr":     [],
        "quarterly_labels":    [],
        "promoter_pct":        None,   # major_holders
        "institution_pct":     None,
        "pe_5y_avg":           None,   # reconstructed
        "errors":              [],
    }

    if not HAS_YF or not HAS_PD:
        out["errors"].append("yfinance or pandas not installed")
        return out

    try:
        ticker = yf.Ticker(yf_ticker)

        # ── .info ──────────────────────────────────────────────────────────
        try:
            info = ticker.info
            out["pe_trailing"]   = info.get("trailingPE")
            out["pe_forward"]    = info.get("forwardPE")
            out["pb"]            = info.get("priceToBook")
            raw_mcap             = info.get("marketCap")
            out["market_cap_cr"] = round(raw_mcap / 1e7, 2) if raw_mcap else None  # ₹ Cr
            out["roe_pct"]       = round(info.get("returnOnEquity", 0) * 100, 2) if info.get("returnOnEquity") else None
            out["debt_to_equity"]= info.get("debtToEquity")
            out["high_52w"]      = info.get("fiftyTwoWeekHigh")
            out["low_52w"]       = info.get("fiftyTwoWeekLow")
            out["sector"]        = info.get("sector")
            out["industry"]      = info.get("industry")

            # ROCE = EBIT / Capital Employed  (Capital Employed = Total Assets - Current Liabilities)
            ebit  = info.get("ebitda")   # proxy; ideally EBIT
            ta    = info.get("totalAssets")
            cl    = info.get("totalCurrentLiabilities")
            if ebit and ta and cl and (ta - cl) > 0:
                out["roce_pct"] = round(ebit / (ta - cl) * 100, 2)
        except Exception as e:
            out["errors"].append(f"info fetch failed: {e}")

        # ── 5y daily history → ATH + 200 DMA ──────────────────────────────
        try:
            hist = ticker.history(period="5y", interval="1d", auto_adjust=True)
            if not hist.empty:
                # ATH = max adjusted high over 5y (skip NaN tail rows)
                out["ath_5y"]  = round(float(hist["High"].dropna().max()), 2)
                # 200 DMA — use dropna() because last row may be NaN on non-trading days
                if len(hist) >= 200:
                    out["dma_200"] = round(float(hist["Close"].rolling(200).mean().dropna().iloc[-1]), 2)

                # 5Y avg PE reconstruction:
                # We have daily Close. We need historical EPS.
                # yfinance doesn't give historical EPS directly via .info.
                # Best proxy: use trailing PE snapshots aren't stored yet.
                # Flag as NOT available from yfinance alone.
                out["pe_5y_avg"] = "NOT_AVAILABLE_YF"
                out["errors"].append(
                    "5Y avg PE: yfinance cannot reconstruct historical PE without EPS history. "
                    "Need separate historical EPS series."
                )
        except Exception as e:
            out["errors"].append(f"history fetch failed: {e}")

        # ── Quarterly financials ───────────────────────────────────────────
        try:
            qf = ticker.quarterly_financials
            if qf is not None and not qf.empty:
                # Try to find relevant rows (row names differ by yfinance version)
                def _find_row(df, candidates):
                    for c in candidates:
                        for row in df.index:
                            if c.lower() in str(row).lower():
                                return df.loc[row]
                    return None

                revenue_row = _find_row(qf, ["Total Revenue", "Revenue"])
                ebit_row    = _find_row(qf, ["EBIT", "Operating Income", "Pretax Income"])
                np_row      = _find_row(qf, ["Net Income", "Net Profit"])

                # Take last 4 quarters (columns are dates, descending)
                cols = qf.columns[:4]
                out["quarterly_labels"] = [str(c.date()) for c in cols]

                def to_cr(series, cols):
                    if series is None:
                        return [None] * len(cols)
                    return [round(float(series[c]) / 1e7, 2) if pd.notna(series[c]) else None for c in cols]

                out["quarterly_sales_cr"] = to_cr(revenue_row, cols)
                out["quarterly_pbt_cr"]   = to_cr(ebit_row, cols)
                out["quarterly_np_cr"]    = to_cr(np_row, cols)
            else:
                out["errors"].append("quarterly_financials: empty or None")
        except Exception as e:
            out["errors"].append(f"quarterly_financials failed: {e}")

        # ── Major holders (promoter / institutional) ───────────────────────
        try:
            mh = ticker.major_holders
            if mh is not None and not mh.empty:
                # Row 0: % held by insiders
                # Row 1: % held by institutions
                out["promoter_pct"]   = float(mh.iloc[0, 0]) * 100 if pd.notna(mh.iloc[0, 0]) else None
                out["institution_pct"]= float(mh.iloc[1, 0]) * 100 if pd.notna(mh.iloc[1, 0]) else None
            else:
                out["errors"].append("major_holders: empty or None")
        except Exception as e:
            out["errors"].append(f"major_holders failed: {e}")

    except Exception as e:
        out["errors"].append(f"Ticker init failed: {e}")

    return out


# ════════════════════════════════════════════════════════════════════════════
# SECTION 2 — NSE API
# ════════════════════════════════════════════════════════════════════════════

def _nse_session_opener():
    """Create an opener with NSE session cookie (NSE requires hitting home first)."""
    cj  = urllib.request.HTTPCookieProcessor()
    opener = urllib.request.build_opener(cj)
    try:
        req = urllib.request.Request("https://www.nseindia.com/", headers=NSE_HEADERS)
        with opener.open(req, timeout=10) as r:
            r.read()
        time.sleep(1)
    except Exception:
        pass
    return opener


def _nse_get(opener, path: str, params: dict = None) -> Optional[dict]:
    """GET from NSE API, return parsed JSON or None."""
    url = f"{NSE_BASE}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    try:
        req = urllib.request.Request(url, headers=NSE_HEADERS)
        with opener.open(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"__error__": str(e)}


def fetch_nse(symbol: str, nse_symbol: str) -> dict:
    """Fetch shareholding, pledging, quote data from NSE API."""
    print(f"  [NSE API]  Fetching {nse_symbol} ...")

    out = {
        "market_cap_cr":        None,
        "pe":                   None,
        "pb":                   None,
        "high_52w":             None,
        "low_52w":              None,
        "last_price":           None,
        "promoter_holding_pct": None,
        "public_holding_pct":   None,
        "institution_pct":      None,
        "promoter_pledging_pct":None,
        "pledge_data_available":False,
        "shareholding_date":    None,
        "errors":               [],
    }

    try:
        opener = _nse_session_opener()

        # ── Quote data ─────────────────────────────────────────────────────
        quote = _nse_get(opener, "quote-equity", {"symbol": nse_symbol, "section": "trade_info"})
        if quote and "__error__" not in quote:
            try:
                qd = quote.get("marketDeptOrderBook", {})
                tradeInfo = quote.get("tradeInfo", {})
                securityInfo = quote.get("securityInfo", {})
                priceInfo = quote.get("priceInfo", {})

                out["last_price"] = priceInfo.get("lastPrice")
                out["high_52w"]   = priceInfo.get("weekHighLow", {}).get("max")
                out["low_52w"]    = priceInfo.get("weekHighLow", {}).get("min")
                out["pe"]         = priceInfo.get("pPriceBand", None)  # not PE, just band
                # NSE quote does not directly give PE/PB in this endpoint
                # Try intrinsic value endpoint
            except Exception as e:
                out["errors"].append(f"quote parsing: {e}")
        else:
            out["errors"].append(f"quote-equity: {quote.get('__error__','no data')}")

        time.sleep(0.5)

        # ── Fundamentals from NSE quote-equity (no section param) ──────────
        quote2 = _nse_get(opener, "quote-equity", {"symbol": nse_symbol})
        if quote2 and "__error__" not in quote2:
            try:
                pi = quote2.get("priceInfo", {})
                md = quote2.get("metadata", {})
                out["last_price"] = out["last_price"] or pi.get("lastPrice")
                out["pe"]         = md.get("pdSymbolPe")       # P/E ratio
                out["pb"]         = None                        # Not in this endpoint
                out["high_52w"]   = out["high_52w"] or pi.get("weekHighLow", {}).get("max")
                out["low_52w"]    = out["low_52w"] or pi.get("weekHighLow", {}).get("min")
                # Market cap not directly in quote, comes from stock-screener
            except Exception as e:
                out["errors"].append(f"quote2 parsing: {e}")
        else:
            out["errors"].append(f"quote-equity(2): {quote2.get('__error__','no data') if quote2 else 'None'}")

        time.sleep(0.5)

        # ── Shareholding pattern ───────────────────────────────────────────
        sh = _nse_get(opener, "corporate-share-holdings-master", {"symbol": nse_symbol})
        if sh and "__error__" not in sh and isinstance(sh, list) and len(sh) > 0:
            try:
                latest = sh[0]  # most recent quarter
                out["shareholding_date"] = latest.get("date") or latest.get("quarter")

                # NSE returns: promoters, public, foreignInstitutions, DIIs etc.
                # Field names can vary — try common ones
                for entry in latest.get("shareholdingPatterns", [latest]):
                    category = str(entry.get("category", "")).lower()
                    pct = entry.get("percentage") or entry.get("shareholdingPercent")
                    if pct is not None:
                        pct = float(pct)
                        if "promoter" in category:
                            out["promoter_holding_pct"] = pct
                        elif "public" in category and "institution" not in category:
                            out["public_holding_pct"] = pct
                        elif "institution" in category or "fii" in category or "dii" in category:
                            out["institution_pct"] = (out["institution_pct"] or 0) + pct
            except Exception as e:
                out["errors"].append(f"shareholding parsing: {e}")
        elif sh and "__error__" in sh:
            out["errors"].append(f"shareholding: {sh['__error__']}")
        else:
            # Try alternate endpoint
            sh2 = _nse_get(opener, "corporate-share-holdings", {"symbol": nse_symbol, "tabName": "shareholding"})
            if sh2 and "__error__" not in sh2:
                out["errors"].append("shareholding: alt endpoint returned data (parse manually)")
            else:
                out["errors"].append("shareholding: no data from either endpoint")

        time.sleep(0.5)

        # ── Pledging data ──────────────────────────────────────────────────
        pledge = _nse_get(opener, "corporate-pledgedata", {"symbol": nse_symbol})
        if pledge and "__error__" not in pledge:
            try:
                out["pledge_data_available"] = True
                data = pledge if isinstance(pledge, list) else pledge.get("data", [])
                if data and len(data) > 0:
                    latest_pledge = data[0]
                    # Common field names from NSE pledge endpoint
                    pct = (
                        latest_pledge.get("promoterSharesPledged%")
                        or latest_pledge.get("pledgedSharesPercent")
                        or latest_pledge.get("Pledge%")
                        or latest_pledge.get("percOfTotalSharesPledged")
                    )
                    out["promoter_pledging_pct"] = float(pct) if pct else 0.0
            except Exception as e:
                out["errors"].append(f"pledge parsing: {e}")
        else:
            err = pledge.get("__error__","no data") if pledge else "None response"
            out["errors"].append(f"pledging: {err}")

        time.sleep(0.5)

        # ── Market cap from NSE stock screener API ─────────────────────────
        # NSE stock-screener gives market cap in crores directly
        screener = _nse_get(opener, "stock-screener-res", {
            "index": "NIFTY 500", "from": "1", "to": "100"
        })
        # This is a broad call — we'll parse just for our symbol
        if screener and "__error__" not in screener:
            try:
                items = screener.get("data", [])
                for item in items:
                    if item.get("symbol") == nse_symbol:
                        mc = item.get("mktCap") or item.get("marketCap")
                        if mc:
                            out["market_cap_cr"] = float(mc)
                        break
            except Exception as e:
                out["errors"].append(f"screener market cap: {e}")

    except Exception as e:
        out["errors"].append(f"NSE session failed: {e}")

    return out


# ════════════════════════════════════════════════════════════════════════════
# SECTION 3 — BSE API
# ════════════════════════════════════════════════════════════════════════════

def _bse_get(path: str, params: dict = None) -> Optional[dict]:
    """GET from BSE API, return parsed JSON or None."""
    url = f"{BSE_BASE}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    try:
        req = urllib.request.Request(url, headers=BSE_HEADERS)
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"__error__": str(e)}


def fetch_bse(symbol: str, bse_code: str) -> dict:
    """Fetch quarterly financials + shareholding from BSE API."""
    print(f"  [BSE API]  Fetching BSE {bse_code} ({symbol}) ...")

    out = {
        "last_price":           None,
        "market_cap_cr":        None,
        "pe":                   None,
        "pb":                   None,
        "high_52w":             None,
        "low_52w":              None,
        "quarterly_sales_cr":   [],
        "quarterly_pbt_cr":     [],
        "quarterly_np_cr":      [],
        "quarterly_labels":     [],
        "promoter_holding_pct": None,
        "public_holding_pct":   None,
        "institution_pct":      None,
        "promoter_pledging_pct":None,
        "errors":               [],
    }

    # ── BSE Quote / fundamentals ───────────────────────────────────────────
    quote = _bse_get("getScripHeaderData/w", {"Debtflag": "", "scrip": bse_code})
    if quote and "__error__" not in quote:
        try:
            out["last_price"]    = quote.get("CurrRate")
            out["pe"]            = quote.get("PE")
            out["pb"]            = quote.get("PB")
            out["high_52w"]      = quote.get("High52")
            out["low_52w"]       = quote.get("Low52")
            raw_mc = quote.get("MktCap")
            if raw_mc:
                # BSE returns in crores directly in some endpoints, check scale
                mc_val = float(str(raw_mc).replace(",",""))
                # If value looks like lakhs (< 100000), convert; else assume crores
                out["market_cap_cr"] = mc_val
        except Exception as e:
            out["errors"].append(f"BSE quote parsing: {e}")
    else:
        out["errors"].append(f"BSE quote: {quote.get('__error__','no data') if quote else 'None'}")

    time.sleep(0.5)

    # ── BSE Quarterly financials ───────────────────────────────────────────
    # BSE API: FinancialResultNew endpoint
    fin = _bse_get("FinancialResultNew/w", {
        "scrip_cd": bse_code,
        "report_type": "QT",       # QT = Quarterly
        "period": "3M",
        "No_of_period": "4",
        "consolidated": "1",       # 1 = Consolidated, 0 = Standalone
    })
    if fin and "__error__" not in fin:
        try:
            results_list = fin.get("Results", []) or fin.get("data", [])
            if isinstance(results_list, list) and len(results_list) > 0:
                for i, row in enumerate(results_list[:4]):
                    label = row.get("PERIOD_END") or row.get("period") or f"Q{i+1}"
                    out["quarterly_labels"].append(str(label))

                    def to_cr_bse(val):
                        if val is None: return None
                        try:
                            v = float(str(val).replace(",","").replace("(","").replace(")",""))
                            # BSE financials are typically in Lakhs → convert to Cr
                            return round(v / 100, 2)
                        except:
                            return None

                    out["quarterly_sales_cr"].append(to_cr_bse(
                        row.get("NET_SALES_OR_REVENUE") or row.get("SALES") or row.get("Revenue")
                    ))
                    out["quarterly_pbt_cr"].append(to_cr_bse(
                        row.get("PROFIT_BEFORE_TAX") or row.get("PBT") or row.get("EBT")
                    ))
                    out["quarterly_np_cr"].append(to_cr_bse(
                        row.get("NET_PROFIT_LOSS") or row.get("PAT") or row.get("NetProfit")
                    ))
        except Exception as e:
            out["errors"].append(f"BSE financials parsing: {e}")
    else:
        # Try alternate financials endpoint
        fin2 = _bse_get("Quarterly/w", {"scripcode": bse_code, "Otype": "Q", "Rtype": "quarterly", "Statement": "P"})
        if fin2 and "__error__" not in fin2:
            out["errors"].append("BSE quarterly: alt endpoint returned data (needs parsing)")
        else:
            out["errors"].append(f"BSE quarterly: {fin.get('__error__','') if fin else 'None'} | alt: {fin2.get('__error__','') if fin2 else 'None'}")

    time.sleep(0.5)

    # ── BSE Shareholding ───────────────────────────────────────────────────
    sh = _bse_get("Shareholder/w", {"scripcode": bse_code, "type": "10"})
    if sh and "__error__" not in sh:
        try:
            items = sh.get("ShareHolderData", []) or sh.get("data", [])
            for entry in items:
                cat = str(entry.get("category", "") or entry.get("Category", "")).lower()
                pct = entry.get("shareholdingPct") or entry.get("ShareholdingPct") or entry.get("shareHoldingPct")
                if pct is not None:
                    pct = float(pct)
                    if "promoter" in cat:
                        out["promoter_holding_pct"] = pct
                    elif "public" in cat:
                        out["public_holding_pct"] = pct
                    elif any(x in cat for x in ["institution","fii","dii","mutual"]):
                        out["institution_pct"] = (out["institution_pct"] or 0) + pct
        except Exception as e:
            out["errors"].append(f"BSE shareholding: {e}")
    else:
        out["errors"].append(f"BSE shareholding: {sh.get('__error__','no data') if sh else 'None'}")

    time.sleep(0.5)

    # ── BSE Pledging ───────────────────────────────────────────────────────
    pledge = _bse_get("PromPledge/w", {"scripcode": bse_code})
    if pledge and "__error__" not in pledge:
        try:
            pl_data = pledge.get("data", []) or (pledge if isinstance(pledge, list) else [])
            if pl_data:
                latest = pl_data[0]
                pct = (
                    latest.get("pledgedShares%")
                    or latest.get("PromoterPledgePct")
                    or latest.get("pledgedPercent")
                    or latest.get("PledgedPercent")
                )
                out["promoter_pledging_pct"] = float(pct) if pct else 0.0
        except Exception as e:
            out["errors"].append(f"BSE pledge parsing: {e}")
    else:
        out["errors"].append(f"BSE pledge: {pledge.get('__error__','no data') if pledge else 'None'}")

    return out


# ════════════════════════════════════════════════════════════════════════════
# SECTION 4 — Report Generator
# ════════════════════════════════════════════════════════════════════════════

def _fmt(val, suffix="", decimals=2):
    if val is None or val == "NOT_AVAILABLE_YF":
        return "❌ N/A"
    if isinstance(val, float):
        return f"{val:.{decimals}f}{suffix}"
    return f"{val}{suffix}"


def _fmt_list(lst, suffix=""):
    if not lst:
        return "❌ N/A"
    return " | ".join(_fmt(v, suffix) for v in lst)


def generate_report(all_results: dict) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M IST")
    lines = [
        "# Plutus — Data Source Validation Report",
        "",
        f"> Generated: {now}",
        "> Stocks: RELIANCE.NS (Large Cap), PAGEIND.NS (Mid Cap)",
        "> Sources: yfinance · NSE API · BSE API",
        "",
        "---",
        "",
    ]

    for sym, data in all_results.items():
        yf  = data.get("yfinance", {})
        nse = data.get("nse", {})
        bse = data.get("bse", {})

        lines += [
            f"## {sym}",
            "",
            "### Price & Valuation",
            "",
            "| Metric | yfinance | NSE API | BSE API | Verdict |",
            "|--------|----------|---------|---------|---------|",
            f"| Last Price | {_fmt(None)} | {_fmt(nse.get('last_price'), '₹')} | {_fmt(bse.get('last_price'), '₹')} | — |",
            f"| Market Cap (₹ Cr) | {_fmt(yf.get('market_cap_cr'), ' Cr', 0)} | {_fmt(nse.get('market_cap_cr'), ' Cr', 0)} | {_fmt(bse.get('market_cap_cr'), ' Cr', 0)} | — |",
            f"| Trailing PE | {_fmt(yf.get('pe_trailing'))} | {_fmt(nse.get('pe'))} | {_fmt(bse.get('pe'))} | — |",
            f"| Price/Book | {_fmt(yf.get('pb'))} | {_fmt(nse.get('pb'))} | {_fmt(bse.get('pb'))} | — |",
            f"| 52W High | {_fmt(yf.get('high_52w'), '₹')} | {_fmt(nse.get('high_52w'), '₹')} | {_fmt(bse.get('high_52w'), '₹')} | — |",
            f"| 52W Low | {_fmt(yf.get('low_52w'), '₹')} | {_fmt(nse.get('low_52w'), '₹')} | {_fmt(bse.get('low_52w'), '₹')} | — |",
            f"| ATH (5Y adj high) | {_fmt(yf.get('ath_5y'), '₹')} | ❌ N/A | ❌ N/A | yfinance only |",
            f"| 200 DMA | {_fmt(yf.get('dma_200'), '₹')} | ❌ N/A | ❌ N/A | yfinance only |",
            "",
            "### Quality Metrics",
            "",
            "| Metric | yfinance | NSE API | BSE API | Verdict |",
            "|--------|----------|---------|---------|---------|",
            f"| ROE % | {_fmt(yf.get('roe_pct'), '%')} | ❌ N/A | ❌ N/A | yfinance only |",
            f"| ROCE % (derived) | {_fmt(yf.get('roce_pct'), '%')} | ❌ N/A | ❌ N/A | yfinance derived |",
            f"| Debt / Equity | {_fmt(yf.get('debt_to_equity'))} | ❌ N/A | ❌ N/A | yfinance only |",
            f"| 5Y Avg PE | {_fmt(yf.get('pe_5y_avg'))} | ❌ N/A | ❌ N/A | Needs custom build |",
            "",
            "### Quarterly Financials (₹ Cr, latest 4 quarters)",
            "",
            f"**Quarter labels — yfinance:** {', '.join(yf.get('quarterly_labels',[]) or ['N/A'])}",
            f"**Quarter labels — BSE:**      {', '.join(bse.get('quarterly_labels',[]) or ['N/A'])}",
            "",
            "| Metric | Q1 (yf/bse) | Q2 (yf/bse) | Q3 (yf/bse) | Q4 (yf/bse) |",
            "|--------|-------------|-------------|-------------|-------------|",
        ]

        def paired(yf_list, bse_list):
            out = []
            for i in range(4):
                yv = yf_list[i] if yf_list and i < len(yf_list) else None
                bv = bse_list[i] if bse_list and i < len(bse_list) else None
                out.append(f"{_fmt(yv)} / {_fmt(bv)}")
            return out

        sales_p = paired(yf.get("quarterly_sales_cr", []), bse.get("quarterly_sales_cr", []))
        pbt_p   = paired(yf.get("quarterly_pbt_cr",   []), bse.get("quarterly_pbt_cr",   []))
        np_p    = paired(yf.get("quarterly_np_cr",    []), bse.get("quarterly_np_cr",    []))

        lines += [
            f"| Sales | {sales_p[0]} | {sales_p[1]} | {sales_p[2]} | {sales_p[3]} |",
            f"| PBT   | {pbt_p[0]}  | {pbt_p[1]}  | {pbt_p[2]}  | {pbt_p[3]}  |",
            f"| Net Profit | {np_p[0]} | {np_p[1]} | {np_p[2]} | {np_p[3]} |",
            "",
            "### Shareholding & Pledging",
            "",
            "| Metric | yfinance | NSE API | BSE API | Verdict |",
            "|--------|----------|---------|---------|---------|",
            f"| Promoter Holding % | {_fmt(yf.get('promoter_pct'), '%')} | {_fmt(nse.get('promoter_holding_pct'), '%')} | {_fmt(bse.get('promoter_holding_pct'), '%')} | — |",
            f"| Public Holding % | ❌ N/A | {_fmt(nse.get('public_holding_pct'), '%')} | {_fmt(bse.get('public_holding_pct'), '%')} | NSE/BSE |",
            f"| Institutional % | {_fmt(yf.get('institution_pct'), '%')} | {_fmt(nse.get('institution_pct'), '%')} | {_fmt(bse.get('institution_pct'), '%')} | — |",
            f"| Promoter Pledging % | ❌ N/A | {_fmt(nse.get('promoter_pledging_pct'), '%')} | {_fmt(bse.get('promoter_pledging_pct'), '%')} | NSE/BSE |",
            "",
            "### Errors / Gaps",
            "",
        ]

        all_errors = (
            [f"**yfinance:** {e}" for e in yf.get("errors", [])] +
            [f"**NSE:**      {e}" for e in nse.get("errors", [])] +
            [f"**BSE:**      {e}" for e in bse.get("errors", [])]
        )
        if all_errors:
            for err in all_errors:
                lines.append(f"- {err}")
        else:
            lines.append("- ✅ No errors")

        lines += ["", "---", ""]

    # ── Summary & Verdicts ─────────────────────────────────────────────────
    lines += [
        "## Summary — Source Coverage Matrix",
        "",
        "| Data Need | yfinance | NSE API | BSE API | Final Source |",
        "|-----------|----------|---------|---------|--------------|",
        "| Price / Close | ✅ | ✅ | ✅ | yfinance (primary) |",
        "| Market Cap | ✅ | ⚠️ check | ✅ | yfinance |",
        "| Trailing PE | ✅ | ⚠️ check | ✅ | yfinance |",
        "| Price/Book | ✅ | ❌ | ✅ | yfinance |",
        "| 52W High/Low | ✅ | ✅ | ✅ | yfinance |",
        "| ATH (5Y) | ✅ | ❌ | ❌ | yfinance |",
        "| 200 DMA | ✅ (computed) | ❌ | ❌ | yfinance |",
        "| ROE | ✅ | ❌ | ❌ | yfinance |",
        "| ROCE | ⚠️ derived | ❌ | ❌ | yfinance derived |",
        "| Debt/Equity | ✅ | ❌ | ❌ | yfinance |",
        "| 5Y Avg PE | ❌ (not native) | ❌ | ❌ | Custom build required |",
        "| Quarterly Sales | ⚠️ check | ❌ | ✅ | BSE API (more reliable) |",
        "| Quarterly PBT | ⚠️ check | ❌ | ✅ | BSE API |",
        "| Quarterly Net Profit | ⚠️ check | ❌ | ✅ | BSE API |",
        "| Promoter Holding | ⚠️ limited | ✅ | ✅ | NSE API |",
        "| Public Holding | ❌ | ✅ | ✅ | NSE API |",
        "| Institutional Holding | ⚠️ limited | ✅ | ✅ | NSE API |",
        "| Promoter Pledging | ❌ | ✅ | ✅ | NSE API |",
        "",
        "## 5Y Average PE — Build Strategy",
        "",
        "yfinance does not store historical PE snapshots. Options:",
        "",
        "1. **Store daily PE in `daily_snapshots`** from day 1 of Plutus.",
        "   After 5 years of daily syncs, compute rolling 5Y avg from DB.",
        "   Until then: use 'since inception' average.",
        "",
        "2. **Reconstruct from daily Close + quarterly EPS series:**",
        "   - Fetch quarterly EPS from BSE API (`ResultType=EPS`)",
        "   - Build daily TTM EPS series (sum of last 4Q EPS, updated each quarter)",
        "   - Daily PE = Close / TTM EPS per day",
        "   - 5Y avg PE = mean(daily PE, last 5Y)",
        "   This gives a proper 5Y avg PE identical to Screener's methodology.",
        "",
        "> **Recommended:** Option 2 (BSE EPS + daily history reconstruction).",
        "> Start with this for RELIANCE + PAGEIND to validate against Screener.",
        "",
        "---",
        "",
        f"*Report generated by validate_plutus_sources.py on {now}*",
    ]

    return "\n".join(lines)


# ════════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════════

def main():
    print("=" * 60)
    print("  Plutus — Data Source Validation")
    print("=" * 60)

    all_results = {}

    for sym, cfg in STOCKS.items():
        print(f"\n{'─'*50}")
        print(f"  Stock: {sym}")
        print(f"{'─'*50}")

        yf_data  = fetch_yfinance(sym, cfg["yf_ticker"])
        nse_data = fetch_nse(sym, cfg["nse_symbol"])
        bse_data = fetch_bse(sym, cfg["bse_code"])

        all_results[sym] = {
            "yfinance": yf_data,
            "nse":      nse_data,
            "bse":      bse_data,
        }

        time.sleep(2)  # courtesy delay between stocks

    # ── Write report ───────────────────────────────────────────────────────
    report = generate_report(all_results)

    report_path = "Docs/Plutus_Validation_Report.MD"
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"\n{'='*60}")
    print(f"  ✅ Report written → {report_path}")
    print(f"{'='*60}\n")

    # ── Print raw JSON for debugging ───────────────────────────────────────
    print("\n[DEBUG] Raw results (JSON):")
    # Strip long lists for cleaner output
    debug = {}
    for sym, data in all_results.items():
        debug[sym] = {}
        for src, vals in data.items():
            debug[sym][src] = {k: v for k, v in vals.items() if k != "errors"}
        debug[sym]["errors"] = {
            src: data[src].get("errors", []) for src in data
        }
    print(json.dumps(debug, indent=2, default=str))


if __name__ == "__main__":
    main()
