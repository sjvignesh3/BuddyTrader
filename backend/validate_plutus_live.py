"""
PLUTUS Data Source Validation Script
Tests RELIANCE.NS and PAGEIND.NS across yfinance, NSE API, and BSE API.
Reports all raw results faithfully.
"""

import json
import time
import traceback
from datetime import datetime

import pandas as pd
import requests
import yfinance as yf

RESULTS = {}

def section(title):
    print("\n" + "=" * 80)
    print(f"  {title}")
    print("=" * 80)

def subsection(title):
    print(f"\n--- {title} ---")

# ============================================================================
# 1. YFINANCE VALIDATION
# ============================================================================

def validate_yfinance(symbol):
    section(f"YFINANCE: {symbol}")
    result = {}

    # --- .info ---
    subsection(f"{symbol} .info")
    try:
        ticker = yf.Ticker(symbol)
        info = ticker.info
        result["info_all_keys"] = sorted(list(info.keys()))
        print(f"Total keys in .info: {len(info)}")
        print(f"All keys: {result['info_all_keys']}")

        target_keys = [
            "trailingPE", "forwardPE", "priceToBook", "marketCap",
            "returnOnEquity", "returnOnAssets", "debtToEquity",
            "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "sector", "industry",
            "ebitda", "totalRevenue", "profitMargins", "currentPrice",
            "bookValue", "dividendYield"
        ]
        info_subset = {}
        for k in target_keys:
            val = info.get(k, "__MISSING__")
            info_subset[k] = val
            status = "✓" if val != "__MISSING__" else "✗ MISSING"
            print(f"  {k}: {val}  [{status}]")
        result["info_target"] = info_subset

        # Print ALL info values for inspection
        print(f"\n  Full .info dump (all {len(info)} keys):")
        for k in sorted(info.keys()):
            v = info[k]
            print(f"    {k}: {v}")
        result["info_full"] = {k: str(v) for k, v in info.items()}
    except Exception as e:
        result["info_error"] = f"{type(e).__name__}: {e}"
        print(f"ERROR: {result['info_error']}")
        traceback.print_exc()

    # --- .history ---
    subsection(f"{symbol} .history(period='5y')")
    try:
        hist = ticker.history(period="5y")
        result["history_shape"] = list(hist.shape)
        result["history_columns"] = list(hist.columns)
        result["history_date_range"] = [str(hist.index.min()), str(hist.index.max())]
        print(f"Shape: {hist.shape}")
        print(f"Columns: {list(hist.columns)}")
        print(f"Date range: {hist.index.min()} to {hist.index.max()}")

        if not hist.empty and "High" in hist.columns and "Close" in hist.columns:
            ath = float(hist["High"].max())
            current_close = float(hist["Close"].iloc[-1])
            dma200 = float(hist["Close"].rolling(200).mean().iloc[-1])
            below_200dma_pct = round((current_close - dma200) / dma200 * 100, 2)
            fall_from_ath_pct = round((current_close - ath) / ath * 100, 2)

            derived = {
                "ATH": ath,
                "current_close": current_close,
                "200_DMA": round(dma200, 2),
                "below_200dma_pct": below_200dma_pct,
                "fall_from_ath_pct": fall_from_ath_pct,
            }
            result["history_derived"] = derived
            for k, v in derived.items():
                print(f"  {k}: {v}")
        else:
            result["history_derived"] = "empty or missing columns"
            print("  History empty or missing columns")

        # Print last 5 rows
        print(f"\n  Last 5 rows:")
        print(hist.tail().to_string())
    except Exception as e:
        result["history_error"] = f"{type(e).__name__}: {e}"
        print(f"ERROR: {result['history_error']}")
        traceback.print_exc()

    # --- .quarterly_financials ---
    subsection(f"{symbol} .quarterly_financials")
    try:
        qf = ticker.quarterly_financials
        result["quarterly_financials_shape"] = list(qf.shape) if qf is not None else None
        if qf is not None and not qf.empty:
            print(f"Shape: {qf.shape}")
            print(f"Index (row labels): {list(qf.index)}")
            print(f"Columns (quarters): {[str(c) for c in qf.columns]}")

            target_rows = ["Total Revenue", "Pretax Income", "Income Before Tax", "EBIT", "Net Income"]
            qf_data = {}
            for row in target_rows:
                if row in qf.index:
                    vals = qf.loc[row]
                    vals_cr = {str(c): round(v / 1e7, 2) if pd.notna(v) else None for c, v in vals.items()}
                    qf_data[row] = vals_cr
                    print(f"  {row} (₹ Cr): {vals_cr}")
                else:
                    print(f"  {row}: ✗ NOT FOUND in index")

            result["quarterly_financials_data"] = qf_data
            result["quarterly_financials_all_rows"] = list(qf.index)

            # Print full dataframe
            print(f"\n  Full quarterly_financials (in ₹ Cr):")
            print((qf / 1e7).round(2).to_string())
        else:
            result["quarterly_financials_data"] = "empty or None"
            print("  quarterly_financials is empty or None")
    except Exception as e:
        result["quarterly_financials_error"] = f"{type(e).__name__}: {e}"
        print(f"ERROR: {result['quarterly_financials_error']}")
        traceback.print_exc()

    # --- .quarterly_income_stmt (newer API) ---
    subsection(f"{symbol} .quarterly_income_stmt")
    try:
        qis = ticker.quarterly_income_stmt
        result["quarterly_income_stmt_shape"] = list(qis.shape) if qis is not None else None
        if qis is not None and not qis.empty:
            print(f"Shape: {qis.shape}")
            print(f"Index (row labels): {list(qis.index)}")
            print(f"Columns (quarters): {[str(c) for c in qis.columns]}")

            target_rows = ["Total Revenue", "Pretax Income", "Income Before Tax", "EBIT", "Net Income",
                           "Net Income Common Stockholders", "Operating Income", "Gross Profit"]
            qis_data = {}
            for row in target_rows:
                if row in qis.index:
                    vals = qis.loc[row]
                    vals_cr = {str(c): round(v / 1e7, 2) if pd.notna(v) else None for c, v in vals.items()}
                    qis_data[row] = vals_cr
                    print(f"  {row} (₹ Cr): {vals_cr}")
                else:
                    print(f"  {row}: ✗ NOT FOUND in index")
            result["quarterly_income_stmt_data"] = qis_data
            result["quarterly_income_stmt_all_rows"] = list(qis.index)
        else:
            result["quarterly_income_stmt_data"] = "empty or None"
            print("  quarterly_income_stmt is empty or None")
    except Exception as e:
        result["quarterly_income_stmt_error"] = f"{type(e).__name__}: {e}"
        print(f"ERROR: {result['quarterly_income_stmt_error']}")
        traceback.print_exc()

    # --- .quarterly_balance_sheet ---
    subsection(f"{symbol} .quarterly_balance_sheet")
    try:
        qbs = ticker.quarterly_balance_sheet
        result["quarterly_balance_sheet_shape"] = list(qbs.shape) if qbs is not None else None
        if qbs is not None and not qbs.empty:
            print(f"Shape: {qbs.shape}")
            print(f"Index (row labels): {list(qbs.index)}")
            print(f"Columns (quarters): {[str(c) for c in qbs.columns]}")

            target_rows = ["Total Assets", "Total Current Liabilities", "Total Debt",
                           "Stockholders Equity", "Total Capitalization",
                           "totalAssets", "totalCurrentLiabilities"]
            for row in target_rows:
                if row in qbs.index:
                    vals = qbs.loc[row]
                    vals_cr = {str(c): round(v / 1e7, 2) if pd.notna(v) else None for c, v in vals.items()}
                    print(f"  {row} (₹ Cr): {vals_cr}")
                else:
                    print(f"  {row}: ✗ NOT FOUND in index")
            result["quarterly_balance_sheet_all_rows"] = list(qbs.index)
        else:
            result["quarterly_balance_sheet_data"] = "empty or None"
            print("  quarterly_balance_sheet is empty or None")
    except Exception as e:
        result["quarterly_balance_sheet_error"] = f"{type(e).__name__}: {e}"
        print(f"ERROR: {result['quarterly_balance_sheet_error']}")
        traceback.print_exc()

    # --- .major_holders ---
    subsection(f"{symbol} .major_holders")
    try:
        mh = ticker.major_holders
        result["major_holders_shape"] = list(mh.shape) if mh is not None else None
        if mh is not None and not mh.empty:
            print(f"Shape: {mh.shape}")
            print(mh.to_string())
            result["major_holders_data"] = mh.to_dict()
        else:
            result["major_holders_data"] = "empty or None"
            print("  major_holders is empty or None")
    except Exception as e:
        result["major_holders_error"] = f"{type(e).__name__}: {e}"
        print(f"ERROR: {result['major_holders_error']}")
        traceback.print_exc()

    return result


# ============================================================================
# 2. NSE API VALIDATION
# ============================================================================

def validate_nse(symbol):
    section(f"NSE API: {symbol}")
    result = {}

    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
    })

    # Step 1: Hit homepage to get cookies
    subsection("NSE Homepage (cookie grab)")
    try:
        resp = session.get('https://www.nseindia.com/', timeout=15)
        print(f"Homepage status: {resp.status_code}")
        print(f"Cookies: {dict(session.cookies)}")
        result["homepage_status"] = resp.status_code
        result["cookies"] = {k: v[:20] + "..." if len(v) > 20 else v for k, v in dict(session.cookies).items()}
        time.sleep(2)
    except Exception as e:
        result["homepage_error"] = f"{type(e).__name__}: {e}"
        print(f"ERROR: {result['homepage_error']}")
        traceback.print_exc()
        return result  # Can't proceed without cookies

    # Endpoints to test
    endpoints = {
        "quote_equity": f"https://www.nseindia.com/api/quote-equity?symbol={symbol}",
        "trade_info": f"https://www.nseindia.com/api/quote-equity?symbol={symbol}&section=trade_info",
        "shareholding": f"https://www.nseindia.com/api/corporate-share-holdings-master?symbol={symbol}",
        "pledge": f"https://www.nseindia.com/api/corporate-pledgedata?symbol={symbol}",
    }

    for name, url in endpoints.items():
        subsection(f"NSE {name}: {url}")
        try:
            time.sleep(1.5)
            resp = session.get(url, timeout=15)
            status = resp.status_code
            content_type = resp.headers.get("Content-Type", "unknown")
            is_json = "json" in content_type.lower() or "application/json" in content_type.lower()

            print(f"Status: {status}")
            print(f"Content-Type: {content_type}")
            print(f"Is JSON: {is_json}")
            print(f"Response length: {len(resp.text)}")

            ep_result = {
                "status": status,
                "content_type": content_type,
                "is_json": is_json,
                "response_length": len(resp.text),
            }

            if status == 200:
                try:
                    data = resp.json()
                    # Print first 500 chars of JSON
                    json_str = json.dumps(data, indent=2, default=str)
                    print(f"JSON data (first 1000 chars):\n{json_str[:1000]}")
                    ep_result["success"] = True
                    # Store key fields
                    if name == "quote_equity" and isinstance(data, dict):
                        price_info = data.get("priceInfo", {})
                        metadata = data.get("metadata", {})
                        ep_result["sample"] = {
                            "lastPrice": price_info.get("lastPrice"),
                            "change": price_info.get("change"),
                            "pChange": price_info.get("pChange"),
                            "open": price_info.get("open"),
                            "close": price_info.get("close"),
                            "52wHigh": price_info.get("weekHighLow", {}).get("max") if isinstance(price_info.get("weekHighLow"), dict) else None,
                            "52wLow": price_info.get("weekHighLow", {}).get("min") if isinstance(price_info.get("weekHighLow"), dict) else None,
                            "industry": metadata.get("industry"),
                            "sector": metadata.get("sector") if "sector" in metadata else metadata.get("industryInfo", {}).get("sector") if isinstance(metadata.get("industryInfo"), dict) else None,
                            "pdSymbolPe": metadata.get("pdSymbolPe"),
                            "pdSectorPe": metadata.get("pdSectorPe"),
                        }
                        # Also grab from industryInfo if present
                        if "industryInfo" in data:
                            ep_result["industryInfo"] = data["industryInfo"]
                    elif name == "shareholding" and isinstance(data, (list, dict)):
                        ep_result["sample_keys"] = list(data.keys()) if isinstance(data, dict) else f"list of {len(data)} items"
                    ep_result["full_json_str"] = json_str[:3000]
                except (json.JSONDecodeError, ValueError):
                    print(f"Response is NOT valid JSON. First 500 chars:\n{resp.text[:500]}")
                    ep_result["success"] = False
                    ep_result["raw_text"] = resp.text[:500]
            else:
                print(f"Non-200 response. First 500 chars:\n{resp.text[:500]}")
                ep_result["success"] = False
                ep_result["raw_text"] = resp.text[:500]

            result[name] = ep_result

        except Exception as e:
            result[name] = {"error": f"{type(e).__name__}: {e}"}
            print(f"ERROR: {result[name]['error']}")
            traceback.print_exc()

    return result


# ============================================================================
# 3. BSE API VALIDATION
# ============================================================================

def validate_bse(scripcode, symbol_name):
    section(f"BSE API: {symbol_name} (scripcode={scripcode})")
    result = {}

    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.bseindia.com/',
        'Origin': 'https://www.bseindia.com',
    })

    endpoints = {
        "com_header": f"https://api.bseindia.com/BseIndiaAPI/api/ComHeader/w?quotetype=EQ&scripcode={scripcode}&seriesid=",
        "quarterly_financials": f"https://api.bseindia.com/BseIndiaAPI/api/FinancialResultNew/w?scrip_cd={scripcode}&report_type=QT&period=3M&No_of_period=4&consolidated=1",
        "shareholding": f"https://api.bseindia.com/BseIndiaAPI/api/Shareholder/w?scripcode={scripcode}&type=10",
        "pledge": f"https://api.bseindia.com/BseIndiaAPI/api/PromPledge/w?scripcode={scripcode}",
        "price_history": f"https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w?scripcode={scripcode}&flag=0&fromdate=&todate=&seriesid=",
    }

    for name, url in endpoints.items():
        subsection(f"BSE {name}: {url}")
        try:
            time.sleep(1.5)
            resp = session.get(url, timeout=15)
            status = resp.status_code
            content_type = resp.headers.get("Content-Type", "unknown")

            print(f"Status: {status}")
            print(f"Content-Type: {content_type}")
            print(f"Response length: {len(resp.text)}")

            ep_result = {
                "status": status,
                "content_type": content_type,
                "response_length": len(resp.text),
            }

            if status == 200:
                try:
                    data = resp.json()
                    json_str = json.dumps(data, indent=2, default=str)
                    print(f"JSON data (first 1500 chars):\n{json_str[:1500]}")
                    ep_result["success"] = True

                    if name == "com_header" and isinstance(data, dict):
                        ep_result["sample"] = {
                            "CurrRate": data.get("CurrRate"),
                            "Prev_Close": data.get("Prev_Close"),
                            "High": data.get("High"),
                            "Low": data.get("Low"),
                            "Fifty2WkHigh_adj": data.get("Fifty2WkHigh_adj"),
                            "Fifty2WkLow_adj": data.get("Fifty2WkLow_adj"),
                            "EPS": data.get("EPS"),
                            "PE": data.get("PE"),
                            "PB": data.get("PB"),
                            "ROE": data.get("ROE"),
                            "Sector": data.get("Sector"),
                            "Industry": data.get("Industry"),
                            "FaceValue": data.get("FaceValue"),
                            "Mktcap": data.get("Mktcap"),
                            "group": data.get("group"),
                            "ScripName": data.get("ScripName"),
                        }
                    elif name == "quarterly_financials":
                        if isinstance(data, list):
                            ep_result["num_records"] = len(data)
                            if data:
                                ep_result["first_record_keys"] = list(data[0].keys())
                        elif isinstance(data, dict):
                            ep_result["top_keys"] = list(data.keys())
                    elif name == "shareholding":
                        if isinstance(data, list):
                            ep_result["num_records"] = len(data)
                            if data:
                                ep_result["first_record_keys"] = list(data[0].keys())
                                ep_result["first_record"] = data[0]
                    elif name == "pledge":
                        if isinstance(data, list):
                            ep_result["num_records"] = len(data)
                        elif isinstance(data, dict):
                            ep_result["top_keys"] = list(data.keys())

                    ep_result["full_json_str"] = json_str[:3000]
                except (json.JSONDecodeError, ValueError):
                    print(f"Response is NOT valid JSON. First 500 chars:\n{resp.text[:500]}")
                    ep_result["success"] = False
                    ep_result["raw_text"] = resp.text[:500]
            else:
                print(f"Non-200 response. First 500 chars:\n{resp.text[:500]}")
                ep_result["success"] = False
                ep_result["raw_text"] = resp.text[:500]

            result[name] = ep_result

        except Exception as e:
            result[name] = {"error": f"{type(e).__name__}: {e}"}
            print(f"ERROR: {result[name]['error']}")
            traceback.print_exc()

    return result


# ============================================================================
# MAIN
# ============================================================================

def main():
    print(f"PLUTUS Data Source Validation - {datetime.now().isoformat()}")
    print(f"yfinance version: {yf.__version__}")
    print(f"pandas version: {pd.__version__}")
    print(f"requests version: {requests.__version__}")

    all_results = {
        "timestamp": datetime.now().isoformat(),
        "versions": {
            "yfinance": yf.__version__,
            "pandas": pd.__version__,
            "requests": requests.__version__,
        }
    }

    # === YFINANCE ===
    for symbol in ["RELIANCE.NS", "PAGEIND.NS"]:
        key = f"yfinance_{symbol.replace('.', '_')}"
        all_results[key] = validate_yfinance(symbol)

    # === NSE ===
    for symbol in ["RELIANCE", "PAGEIND"]:
        key = f"nse_{symbol}"
        all_results[key] = validate_nse(symbol)

    # === BSE ===
    bse_stocks = [
        ("500325", "RELIANCE"),
        ("532827", "PAGEIND"),
    ]
    for scripcode, name in bse_stocks:
        key = f"bse_{name}"
        all_results[key] = validate_bse(scripcode, name)

    # === SAVE JSON ===
    section("SAVING RESULTS")
    output_path = r"d:\Tools\Buddy\BuddyTrader\backend\validation_raw_results.json"
    # Clean non-serializable values
    def clean_for_json(obj):
        if isinstance(obj, dict):
            return {k: clean_for_json(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [clean_for_json(i) for i in obj]
        elif isinstance(obj, (int, float, str, bool, type(None))):
            return obj
        else:
            return str(obj)

    cleaned = clean_for_json(all_results)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(cleaned, f, indent=2, ensure_ascii=False)
    print(f"Results saved to: {output_path}")

    # === SUMMARY ===
    section("VALIDATION SUMMARY")
    print(f"Timestamp: {all_results['timestamp']}")
    print(f"Sections: {list(all_results.keys())}")
    print("\nDone!")


if __name__ == "__main__":
    main()
