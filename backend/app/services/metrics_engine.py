"""
Metrics engine - computes technical metrics from price data.
Calculates: 200 DMA, below_200dma_pct, 52W high/low, distances.
"""
import pandas as pd
from typing import Dict, Optional
import logging

logger = logging.getLogger(__name__)


def compute_metrics(symbol: str, df: pd.DataFrame) -> Optional[Dict]:
    """
    Compute all required metrics for a stock from its OHLCV DataFrame.

    Returns dict with:
        - symbol, close, dma_200, below_200dma_pct
        - high_52w, low_52w, distance_from_52w_high_pct, distance_from_52w_low_pct
    """
    if df is None or df.empty:
        return None

    try:
        # Get the latest close price
        # Handle both single-level and multi-level column DataFrames
        if isinstance(df.columns, pd.MultiIndex):
            close_col = df["Close"].iloc[:, 0] if df["Close"].shape[1] > 0 else df["Close"]
            high_col = df["High"].iloc[:, 0] if df["High"].shape[1] > 0 else df["High"]
            low_col = df["Low"].iloc[:, 0] if df["Low"].shape[1] > 0 else df["Low"]
        else:
            close_col = df["Close"]
            high_col = df["High"]
            low_col = df["Low"]

        close = float(close_col.iloc[-1])

        # 200 DMA
        if len(close_col) >= 200:
            dma_200 = float(close_col.rolling(window=200).mean().iloc[-1])
        else:
            # Use whatever data we have
            dma_200 = float(close_col.mean())
            logger.warning(f"{symbol}: Only {len(close_col)} days of data, using {len(close_col)}-day average as DMA proxy")

        # Below 200 DMA percentage: ((dma_200 - close) / dma_200) * 100
        # Positive means below DMA (good for buying)
        if dma_200 > 0:
            below_200dma_pct = round(((dma_200 - close) / dma_200) * 100, 2)
        else:
            below_200dma_pct = 0.0

        # 52-week (252 trading days) high and low
        lookback = min(252, len(df))
        recent_data = df.tail(lookback)

        if isinstance(recent_data.columns, pd.MultiIndex):
            high_52w = float(recent_data["High"].iloc[:, 0].max())
            low_52w = float(recent_data["Low"].iloc[:, 0].min())
        else:
            high_52w = float(recent_data["High"].max())
            low_52w = float(recent_data["Low"].min())

        # Distance from 52W low: ((close - low_52w) / low_52w) * 100
        if low_52w > 0:
            distance_from_52w_low_pct = round(((close - low_52w) / low_52w) * 100, 2)
        else:
            distance_from_52w_low_pct = 0.0

        # Distance from 52W high: ((high_52w - close) / high_52w) * 100
        if high_52w > 0:
            distance_from_52w_high_pct = round(((high_52w - close) / high_52w) * 100, 2)
        else:
            distance_from_52w_high_pct = 0.0

        return {
            "symbol": symbol,
            "close": round(close, 2),
            "dma_200": round(dma_200, 2),
            "below_200dma_pct": below_200dma_pct,
            "high_52w": round(high_52w, 2),
            "low_52w": round(low_52w, 2),
            "distance_from_52w_high_pct": distance_from_52w_high_pct,
            "distance_from_52w_low_pct": distance_from_52w_low_pct,
        }

    except Exception as e:
        logger.error(f"Error computing metrics for {symbol}: {e}")
        return None
