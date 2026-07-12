"""
Data fetcher - fetches OHLCV data for NSE stocks.
Uses Yahoo Finance v8 API directly (bypasses yfinance library issues).

KEY DESIGN DECISIONS (v4 — accuracy fix):

  Column used for 200 DMA  → AdjClose (dividend-adjusted close)
  Column used for ATH      → AdjClose max from 5y daily data
  52W High / 52W Low       → Yahoo meta `fiftyTwoWeekHigh` / `fiftyTwoWeekLow`
  Latest close             → meta `regularMarketPrice` (unadjusted, live)

WHY ADJUSTED CLOSE:
  Yahoo Finance stores raw (unadjusted) OHLC prices. Whenever a stock pays a
  dividend or does a split, all historical closes are retroactively adjusted
  downward so the price series is comparable across time. The `adjclose` field
  is this adjusted series.

  TradingView and most screeners (including screener.in) compute the 200 DMA
  and ATH from the adjusted close series — which is why:
    - Raw Close 200 DMA = 2736  (wrong, inflated by pre-dividend historical closes)
    - AdjClose 200 DMA  = 2681  (matches TV ~2694, small residual gap from
                                  different dividend adjustment factors)
    - Raw High ATH      = 4592  (unadjusted intraday high, not what TV shows)
    - AdjClose ATH      = 4253  (close to TV's 4289.85; tiny difference is
                                  Yahoo vs TV using slightly different adj factors)

ROOT CAUSE SUMMARY (all 3 bugs fixed):
  BUG 1 — 200 DMA was 2736 (ours) vs 2694 (TV):
    CAUSE: Used raw Close instead of AdjClose.
    FIX:   rolling(200) on AdjClose. Delta shrinks to <15 pts (~0.5%).

  BUG 2 — 52W High was 3399 (ours) vs 3350 (screener):
    CAUSE: max(raw High column) over 252 rows; intraday High > screener definition.
    FIX:   Use Yahoo meta `fiftyTwoWeekHigh` — pre-computed by Yahoo, matches
           screener/TV exactly.

  BUG 3 — ATH was 4592 (ours) vs 4289 (TV):
    CAUSE: `range=max` returns monthly candles → monthly High = entire month's
           intraday extreme, severely inflated. Even 5y raw High = 4592 because
           Yahoo's raw High is unadjusted.
    FIX:   Use max(AdjClose) from 5y daily data. AdjClose on Aug-30-2024 = 4253,
           which is the correct comparable-series high matching TV.
"""
import pandas as pd
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timedelta
import logging
import json
import time

try:
    import urllib.request
    import urllib.error
    HAS_URLLIB = True
except ImportError:
    HAS_URLLIB = False

logger = logging.getLogger(__name__)

# In-memory cache
_price_cache: Dict[str, Dict] = {}   # symbol -> {data: df, meta: dict, fetched_at: dt}
_ath_cache:   Dict[str, float] = {}  # symbol -> ATH (max adjclose from 5y daily)
CACHE_TTL = timedelta(hours=1)

YF_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"


def _nse_ticker(symbol: str) -> str:
    return f"{symbol}.NS"


def _fetch_from_yahoo_api(symbol: str, period: str = "1y") -> Optional[Tuple[pd.DataFrame, dict]]:
    """
    Fetch OHLCV + AdjClose + meta fields from Yahoo Finance v8 API.

    DataFrame columns: Open, High, Low, Close, Volume, AdjClose
    meta dict keys of interest: fiftyTwoWeekHigh, fiftyTwoWeekLow, regularMarketPrice

    Returns (df, meta) or None on failure.
    """
    if not HAS_URLLIB:
        return None

    ticker = _nse_ticker(symbol)
    period_map = {"5y": "5y", "2y": "2y", "1y": "1y", "6mo": "6mo", "1mo": "1mo", "5d": "5d"}
    yf_range = period_map.get(period, "1y")

    url = f"{YF_BASE_URL}{ticker}?range={yf_range}&interval=1d&includePrePost=false"

    try:
        req = urllib.request.Request(url)
        req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

        with urllib.request.urlopen(req, timeout=15) as response:
            data = json.loads(response.read().decode())

        chart = data.get("chart", {}).get("result", [])
        if not chart:
            return None

        result    = chart[0]
        meta      = result.get("meta", {})
        timestamps = result.get("timestamp", [])
        quote     = result.get("indicators", {}).get("quote", [{}])[0]
        adj_list  = result.get("indicators", {}).get("adjclose", [{}])
        adj_closes = adj_list[0].get("adjclose", []) if adj_list else []

        if not timestamps or not quote:
            return None

        df_data = {
            "Open":  quote.get("open", []),
            "High":  quote.get("high", []),
            "Low":   quote.get("low", []),
            "Close": quote.get("close", []),
            "Volume": quote.get("volume", []),
        }

        # Add AdjClose — fall back to raw Close if not present
        if adj_closes and len(adj_closes) == len(timestamps):
            df_data["AdjClose"] = adj_closes
        else:
            df_data["AdjClose"] = quote.get("close", [])
            logger.warning(f"{symbol}: AdjClose not in response, using raw Close")

        df = pd.DataFrame(df_data, index=pd.to_datetime(timestamps, unit="s"))
        df = df.dropna(subset=["Close"])
        df.index.name = "Date"

        if df.empty:
            return None

        return df, meta

    except urllib.error.HTTPError as e:
        logger.warning(f"Yahoo API HTTP error for {symbol} (period={period}): {e.code}")
    except urllib.error.URLError as e:
        logger.warning(f"Yahoo API URL error for {symbol}: {e.reason}")
    except Exception as e:
        logger.warning(f"Yahoo API error for {symbol}: {e}")

    return None


def _try_yfinance(symbol: str, period: str = "1y") -> Optional[Tuple[pd.DataFrame, dict]]:
    """Try yfinance library as backup. Returns (df, meta) or None."""
    try:
        import yfinance as yf
        ticker = yf.Ticker(_nse_ticker(symbol))
        df = ticker.history(period=period, auto_adjust=True)  # gives adjclose as Close
        if not df.empty:
            # In auto_adjust mode, Close IS the adjusted close
            df["AdjClose"] = df["Close"]
            meta = {}
            try:
                info = ticker.fast_info
                meta = {
                    "fiftyTwoWeekHigh":  getattr(info, "year_high", None),
                    "fiftyTwoWeekLow":   getattr(info, "year_low", None),
                    "regularMarketPrice": getattr(info, "last_price", None),
                }
            except Exception:
                pass
            return df, meta
    except Exception as e:
        logger.debug(f"yfinance failed for {symbol}: {e}")
    return None


def _fetch_ath(symbol: str) -> Optional[float]:
    """
    Fetch All-Time High using max(AdjClose) from 5y daily data.

    WHY AdjClose for ATH:
    - Raw High is unadjusted. On dividend ex-dates, Yahoo's raw prices do NOT
      retroactively reduce the High of that day, so raw High > actual traded price.
    - AdjClose reflects the true economic value on each day, comparable across time.
    - max(AdjClose over 5y) matches what TradingView shows as the ATH candle close.
    - We use AdjClose (not AdjHigh — Yahoo doesn't provide that directly) which
      slightly understates the true intraday ATH, but is consistent and reproducible.

    WHY 5y AND NOT max:
    - `range=max&interval=1d` silently returns MONTHLY candles for long histories,
      making monthly High = entire month's intraday extreme → hugely inflated ATH.
    - 5y is the longest range that reliably returns daily candles.
    """
    if symbol in _ath_cache:
        return _ath_cache[symbol]

    result = _fetch_from_yahoo_api(symbol, period="5y")
    if result is None:
        yf_result = _try_yfinance(symbol, period="5y")
        if yf_result is not None:
            df, _ = yf_result
        else:
            return None
    else:
        df, _ = result

    if df is not None and not df.empty:
        if "AdjClose" in df.columns:
            ath = float(df["AdjClose"].max())
        else:
            ath = float(df["Close"].max())
        _ath_cache[symbol] = ath
        logger.debug(f"{symbol} ATH (5y AdjClose): {ath:.2f}")
        return ath

    return None


def fetch_stock_data(symbol: str, period: str = "1y") -> Optional[pd.DataFrame]:
    """
    Fetch 1y daily OHLCV + AdjClose for a single NSE stock.
    Caches the result and meta fields for use by the metrics engine.
    """
    if symbol in _price_cache:
        cached = _price_cache[symbol]
        if datetime.now() - cached["fetched_at"] < CACHE_TTL:
            return cached["data"]

    result = _fetch_from_yahoo_api(symbol, period)

    if result is None:
        yf_result = _try_yfinance(symbol, period)
        df, meta = (yf_result if yf_result is not None else (None, {}))
    else:
        df, meta = result

    if df is not None:
        _price_cache[symbol] = {"data": df, "meta": meta, "fetched_at": datetime.now()}
        return df

    return None


def get_meta_for_symbol(symbol: str) -> dict:
    """Return cached Yahoo meta fields for a symbol (fetched alongside OHLCV data)."""
    if symbol in _price_cache:
        return _price_cache[symbol].get("meta", {})
    return {}


def fetch_multiple_stocks(symbols: List[str], period: str = "1y") -> Dict[str, pd.DataFrame]:
    """Fetch data for multiple stocks with rate limiting and progress logging."""
    results = {}
    symbols_to_fetch = []

    for sym in symbols:
        if sym in _price_cache:
            cached = _price_cache[sym]
            if datetime.now() - cached["fetched_at"] < CACHE_TTL:
                results[sym] = cached["data"]
                continue
        symbols_to_fetch.append(sym)

    if not symbols_to_fetch:
        return results

    total = len(symbols_to_fetch)
    logger.info(f"Fetching data for {total} stocks...")
    success = 0

    for i, sym in enumerate(symbols_to_fetch):
        df = fetch_stock_data(sym, period)
        if df is not None:
            results[sym] = df
            success += 1

        if (i + 1) % 10 == 0:
            logger.info(f"  Progress: {i+1}/{total} attempted, {success} successful")

        if i > 0 and i % 5 == 0:
            time.sleep(0.3)

    logger.info(f"Fetched data for {len(results)}/{len(symbols)} stocks")
    return results


def get_ath_for_symbol(symbol: str) -> Optional[float]:
    """Get ATH (5y daily AdjClose max) for a single symbol."""
    return _fetch_ath(symbol)


def get_ath_for_symbols(symbols: List[str]) -> Dict[str, float]:
    """Fetch ATH for multiple symbols with caching."""
    ath_values = {}
    to_fetch = [s for s in symbols if s not in _ath_cache]

    logger.info(f"Fetching ATH (5y AdjClose) for {len(to_fetch)} stocks ({len(symbols) - len(to_fetch)} cached)...")

    for i, sym in enumerate(to_fetch):
        ath = _fetch_ath(sym)
        if ath is not None:
            ath_values[sym] = ath

        if (i + 1) % 10 == 0:
            logger.info(f"  ATH progress: {i+1}/{len(to_fetch)}")

        if i > 0 and i % 5 == 0:
            time.sleep(0.3)

    for sym in symbols:
        if sym in _ath_cache:
            ath_values[sym] = _ath_cache[sym]

    logger.info(f"ATH data available for {len(ath_values)}/{len(symbols)} stocks")
    return ath_values


def load_sample_data(symbols: List[str]) -> Dict[str, pd.DataFrame]:
    """Generate realistic sample data for testing when live data is unavailable."""
    import numpy as np
    np.random.seed(42)

    known_prices = {
        "RELIANCE": (1200, 1600), "HDFCBANK": (1500, 1900), "ICICIBANK": (1100, 1500),
        "SBIN": (700, 900), "BAJFINANCE": (6500, 9000), "TCS": (3500, 4500),
        "INFY": (1400, 2000), "HCLTECH": (1500, 2000), "ITC": (380, 520),
        "HINDUNILVR": (2100, 2800), "KOTAKBANK": (1700, 2100), "LT": (3200, 4000),
        "AXISBANK": (1000, 1350), "MARUTI": (10000, 14000), "TITAN": (3000, 4000),
        "BAJAJ-AUTO": (8500, 12000), "NESTLEIND": (2200, 2800), "ASIANPAINT": (2200, 3200),
        "PIDILITIND": (2500, 3400), "BAJAJFINSV": (1500, 2200), "BAJAJHLDNG": (8000, 11000),
        "HDFCAMC": (3500, 4800), "HDFCLIFE": (550, 750), "HAVELLS": (1400, 2000),
        "PAGEIND": (35000, 50000), "VOLTAS": (1300, 1900), "COLPAL": (2600, 3400),
        "DABUR": (480, 650), "MARICO": (550, 750), "PGHH": (14000, 19000),
        "ICICIGI": (1500, 2100), "NAM-INDIA": (300, 500), "ICICIPRULI": (550, 750),
        "BERGEPAINT": (450, 650), "ABBOTINDIA": (25000, 32000), "GLAXO": (2500, 3200),
        "BATAINDIA": (1200, 1600), "GILLETTE": (7000, 9500), "PFIZER": (4500, 6000),
        "SANOFI": (5500, 7500),
    }

    results = {}
    end_date = datetime.now()
    dates = pd.bdate_range(end=end_date, periods=252)

    for sym in symbols:
        price_range = known_prices.get(sym, (500, 1000))
        base_price = (price_range[0] + price_range[1]) / 2

        returns = np.random.normal(0, 0.015, len(dates))

        if sym in ["ASIANPAINT", "DABUR", "BERGEPAINT", "BATAINDIA", "PAGEIND"]:
            returns[:180] = np.random.normal(0.001, 0.012, 180)
            returns[180:] = np.random.normal(-0.005, 0.02, len(dates) - 180)
        elif sym in ["HINDUNILVR", "NESTLEIND", "PGHH", "COLPAL"]:
            returns[:200] = np.random.normal(0.0005, 0.01, 200)
            returns[200:] = np.random.normal(-0.008, 0.015, len(dates) - 200)
        elif sym in ["PFIZER", "SANOFI", "GLAXO", "ABBOTINDIA"]:
            returns[:150] = np.random.normal(0.002, 0.01, 150)
            returns[150:] = np.random.normal(-0.006, 0.018, len(dates) - 150)

        prices = [base_price]
        for r in returns[1:]:
            prices.append(prices[-1] * (1 + r))
        prices = np.array(prices)

        highs = prices * (1 + np.abs(np.random.normal(0, 0.005, len(dates))))
        lows  = prices * (1 - np.abs(np.random.normal(0, 0.005, len(dates))))
        opens = prices * (1 + np.random.normal(0, 0.003, len(dates)))
        vols  = np.random.randint(100000, 5000000, len(dates))

        df = pd.DataFrame({
            "Open": opens, "High": highs, "Low": lows,
            "Close": prices, "AdjClose": prices, "Volume": vols,
        }, index=dates)

        results[sym] = df

        meta = {
            "fiftyTwoWeekHigh":   float(highs[-252:].max()) if len(highs) >= 252 else float(highs.max()),
            "fiftyTwoWeekLow":    float(lows[-252:].min())  if len(lows)  >= 252 else float(lows.min()),
            "regularMarketPrice": float(prices[-1]),
        }
        _price_cache[sym] = {"data": df, "meta": meta, "fetched_at": datetime.now()}
        _ath_cache[sym]   = float(prices.max()) * 1.15   # simulated ATH 15% above 1y high

    logger.info(f"Generated sample data for {len(results)} stocks")
    return results


def clear_cache():
    """Clear the price cache and ATH cache."""
    global _price_cache, _ath_cache
    _price_cache = {}
    _ath_cache = {}
    logger.info("Price cache and ATH cache cleared")
