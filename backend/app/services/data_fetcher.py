"""
Data fetcher - fetches OHLCV data for NSE stocks.
Uses Yahoo Finance v8 API directly (bypasses yfinance library issues).
Falls back to sample data when live data is unavailable.
"""
import pandas as pd
from typing import Dict, List, Optional
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
_price_cache: Dict[str, Dict] = {}
CACHE_TTL = timedelta(hours=1)

# Yahoo Finance API v8 URL
YF_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"


def _nse_ticker(symbol: str) -> str:
    """Convert symbol to Yahoo Finance NSE ticker."""
    return f"{symbol}.NS"


def _fetch_from_yahoo_api(symbol: str, period: str = "1y") -> Optional[pd.DataFrame]:
    """
    Fetch data directly from Yahoo Finance REST API.
    This bypasses yfinance library and works in more environments.
    """
    if not HAS_URLLIB:
        return None

    ticker = _nse_ticker(symbol)
    # Map period to interval params
    period_map = {"1y": "1y", "6mo": "6mo", "1mo": "1mo", "5d": "5d"}
    yf_range = period_map.get(period, "1y")

    url = f"{YF_BASE_URL}{ticker}?range={yf_range}&interval=1d"

    try:
        req = urllib.request.Request(url)
        req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

        with urllib.request.urlopen(req, timeout=15) as response:
            data = json.loads(response.read().decode())

        chart = data.get("chart", {}).get("result", [])
        if not chart:
            return None

        result = chart[0]
        timestamps = result.get("timestamp", [])
        quote = result.get("indicators", {}).get("quote", [{}])[0]

        if not timestamps or not quote:
            return None

        df = pd.DataFrame({
            "Open": quote.get("open", []),
            "High": quote.get("high", []),
            "Low": quote.get("low", []),
            "Close": quote.get("close", []),
            "Volume": quote.get("volume", []),
        }, index=pd.to_datetime(timestamps, unit="s"))

        df = df.dropna(subset=["Close"])
        df.index.name = "Date"

        return df if not df.empty else None

    except urllib.error.HTTPError as e:
        logger.warning(f"Yahoo API HTTP error for {symbol}: {e.code}")
    except urllib.error.URLError as e:
        logger.warning(f"Yahoo API URL error for {symbol}: {e.reason}")
    except Exception as e:
        logger.warning(f"Yahoo API error for {symbol}: {e}")

    return None


def _try_yfinance(symbol: str, period: str = "1y") -> Optional[pd.DataFrame]:
    """Try using yfinance library as backup."""
    try:
        import yfinance as yf
        ticker = yf.Ticker(_nse_ticker(symbol))
        df = ticker.history(period=period)
        if not df.empty:
            return df
    except Exception as e:
        logger.debug(f"yfinance failed for {symbol}: {e}")
    return None


def fetch_stock_data(symbol: str, period: str = "1y") -> Optional[pd.DataFrame]:
    """
    Fetch daily OHLCV data for a single NSE stock.
    Tries: Yahoo API direct → yfinance library → None
    """
    # Check cache
    if symbol in _price_cache:
        cached = _price_cache[symbol]
        if datetime.now() - cached["fetched_at"] < CACHE_TTL:
            return cached["data"]

    # Try Yahoo API directly
    df = _fetch_from_yahoo_api(symbol, period)

    # Fallback to yfinance
    if df is None:
        df = _try_yfinance(symbol, period)

    if df is not None:
        _price_cache[symbol] = {"data": df, "fetched_at": datetime.now()}
        return df

    return None


def fetch_multiple_stocks(symbols: List[str], period: str = "1y") -> Dict[str, pd.DataFrame]:
    """Fetch data for multiple stocks."""
    results = {}
    symbols_to_fetch = []

    # Check cache
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

        # Progress logging
        if (i + 1) % 10 == 0:
            logger.info(f"  Progress: {i+1}/{total} attempted, {success} successful")

        # Rate limit
        if i > 0 and i % 5 == 0:
            time.sleep(0.3)

    logger.info(f"Fetched data for {len(results)}/{len(symbols)} stocks")
    return results


def load_sample_data(symbols: List[str]) -> Dict[str, pd.DataFrame]:
    """
    Generate realistic sample data for testing when live data is unavailable.
    Uses realistic price ranges for known NSE F40 stocks.
    """
    import numpy as np
    np.random.seed(42)

    # Realistic price ranges for F40 stocks (approximate as of mid-2025)
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
    dates = pd.bdate_range(end=end_date, periods=252)  # 1 year of trading days

    for sym in symbols:
        price_range = known_prices.get(sym, (500, 1000))
        base_price = (price_range[0] + price_range[1]) / 2
        volatility = base_price * 0.015  # 1.5% daily volatility

        # Generate price path with realistic characteristics
        returns = np.random.normal(0, 0.015, len(dates))

        # Add some stocks with significant drops for testing buy signals
        # Make some stocks deeply below their DMA to test strategies
        if sym in ["ASIANPAINT", "DABUR", "BERGEPAINT", "BATAINDIA", "PAGEIND"]:
            # Recent drop pattern: stock was higher, then dropped
            returns[:180] = np.random.normal(0.001, 0.012, 180)  # Slightly positive first 9 months
            returns[180:] = np.random.normal(-0.005, 0.02, len(dates) - 180)  # Drop last 3 months
        elif sym in ["HINDUNILVR", "NESTLEIND", "PGHH", "COLPAL"]:
            # Near 52-week low pattern
            returns[:200] = np.random.normal(0.0005, 0.01, 200)
            returns[200:] = np.random.normal(-0.008, 0.015, len(dates) - 200)
        elif sym in ["PFIZER", "SANOFI", "GLAXO", "ABBOTINDIA"]:
            # Deep correction
            returns[:150] = np.random.normal(0.002, 0.01, 150)
            returns[150:] = np.random.normal(-0.006, 0.018, len(dates) - 150)

        prices = [base_price]
        for r in returns[1:]:
            prices.append(prices[-1] * (1 + r))
        prices = np.array(prices)

        highs = prices * (1 + np.abs(np.random.normal(0, 0.005, len(dates))))
        lows = prices * (1 - np.abs(np.random.normal(0, 0.005, len(dates))))
        opens = prices * (1 + np.random.normal(0, 0.003, len(dates)))
        volumes = np.random.randint(100000, 5000000, len(dates))

        df = pd.DataFrame({
            "Open": opens,
            "High": highs,
            "Low": lows,
            "Close": prices,
            "Volume": volumes,
        }, index=dates)

        results[sym] = df
        _price_cache[sym] = {"data": df, "fetched_at": datetime.now()}

    logger.info(f"Generated sample data for {len(results)} stocks")
    return results


def clear_cache():
    """Clear the price cache."""
    global _price_cache
    _price_cache = {}
    logger.info("Price cache cleared")
