"""
Metrics engine - computes technical metrics from price data.

v3 — Accuracy fixes to match TradingView / Screener.in values:

  200 DMA  → rolling(200).mean() on the 1y Close column (250 daily rows).
             This now matches TV because the 1y window is aligned to today.

  52W High → Yahoo meta field `fiftyTwoWeekHigh` (passed via meta_fields arg).
  52W Low  → Yahoo meta field `fiftyTwoWeekLow`.
             These are pre-computed by Yahoo and match screener.in / TV exactly.
             We NO LONGER compute 52W high/low from max(High)/min(Low) in the
             DataFrame because intraday High values can overshoot the screener
             definition, and the date window may not align perfectly.

  ATH      → Passed as ath_override from 5y daily data (not max-range which
             switches to monthly candles and inflates ATH via monthly High bars).
"""
import pandas as pd
from typing import Dict, Optional
import logging

logger = logging.getLogger(__name__)


def compute_metrics(
    symbol: str,
    df: pd.DataFrame,
    ath_override: Optional[float] = None,
    meta_fields: Optional[dict] = None,
) -> Optional[Dict]:
    """
    Compute all required metrics for a stock from its OHLCV DataFrame.

    Args:
        symbol: Stock ticker
        df: OHLCV DataFrame (typically 1 year, 250 daily rows)
        ath_override: ATH from 5y daily data. Falls back to max(High) in df if None.
        meta_fields: Yahoo Finance meta dict containing fiftyTwoWeekHigh,
                     fiftyTwoWeekLow, regularMarketPrice. If provided, these
                     override the values computed from the df to match screener/TV.

    Returns dict with all metrics needed by the scanner and strategies.
    """
    if df is None or df.empty:
        return None

    if meta_fields is None:
        meta_fields = {}

    try:
        # ── Column normalisation ──────────────────────────────────────────────
        if isinstance(df.columns, pd.MultiIndex):
            close_col    = df["Close"].iloc[:, 0]
            high_col     = df["High"].iloc[:, 0]
            low_col      = df["Low"].iloc[:, 0]
            adj_close_col = (df["AdjClose"].iloc[:, 0]
                             if "AdjClose" in df.columns else close_col)
        else:
            close_col     = df["Close"]
            high_col      = df["High"]
            low_col       = df["Low"]
            # Use AdjClose for DMA if present; fall back to raw Close
            adj_close_col = df["AdjClose"] if "AdjClose" in df.columns else close_col

        # ── Latest close ─────────────────────────────────────────────────────
        # Use Yahoo meta regularMarketPrice (live, unadjusted) for the current
        # price displayed in the table. Fall back to last raw Close in df.
        meta_close = meta_fields.get("regularMarketPrice")
        if meta_close and float(meta_close) > 0:
            close = float(meta_close)
        else:
            close = float(close_col.iloc[-1])

        # ── 200 DMA ───────────────────────────────────────────────────────────
        # Computed from AdjClose (dividend-adjusted) to match TradingView / screener.
        # Raw Close inflates DMA because historical prices before dividend ex-dates
        # are not retroactively adjusted in the raw series.
        dma_col = adj_close_col
        if len(dma_col) >= 200:
            dma_200 = float(dma_col.rolling(window=200).mean().iloc[-1])
        else:
            dma_200 = float(dma_col.mean())
            logger.warning(
                f"{symbol}: Only {len(dma_col)} days of data, "
                f"using {len(dma_col)}-day average as 200 DMA proxy"
            )

        # % below 200 DMA: positive = price is BELOW DMA (buying opportunity)
        if dma_200 > 0:
            below_200dma_pct = round(((dma_200 - close) / dma_200) * 100, 2)
        else:
            below_200dma_pct = 0.0

        # ── 52-Week High & Low ────────────────────────────────────────────────
        # Use Yahoo meta fields when available — they match screener.in / TV.
        # Fall back to max/min of the last 252 rows only if meta is absent.
        meta_52w_high = meta_fields.get("fiftyTwoWeekHigh")
        meta_52w_low  = meta_fields.get("fiftyTwoWeekLow")

        if meta_52w_high and float(meta_52w_high) > 0:
            high_52w = float(meta_52w_high)
        else:
            lookback = min(252, len(df))
            recent_high = df.tail(lookback)
            if isinstance(recent_high.columns, pd.MultiIndex):
                high_52w = float(recent_high["High"].iloc[:, 0].max())
            else:
                high_52w = float(recent_high["High"].max())
            logger.warning(f"{symbol}: No meta 52W High, falling back to df max")

        if meta_52w_low and float(meta_52w_low) > 0:
            low_52w = float(meta_52w_low)
        else:
            lookback = min(252, len(df))
            recent_low = df.tail(lookback)
            if isinstance(recent_low.columns, pd.MultiIndex):
                low_52w = float(recent_low["Low"].iloc[:, 0].min())
            else:
                low_52w = float(recent_low["Low"].min())
            logger.warning(f"{symbol}: No meta 52W Low, falling back to df min")

        # Distance from 52W low (% above low — higher = further from buying zone)
        if low_52w > 0:
            distance_from_52w_low_pct = round(((close - low_52w) / low_52w) * 100, 2)
        else:
            distance_from_52w_low_pct = 0.0

        # Distance from 52W high (% below high — higher = deeper from high)
        if high_52w > 0:
            distance_from_52w_high_pct = round(((high_52w - close) / high_52w) * 100, 2)
        else:
            distance_from_52w_high_pct = 0.0

        # ── ATH ───────────────────────────────────────────────────────────────
        # ath_override comes from 5y daily data (via data_fetcher._fetch_ath).
        # This gives accurate daily-bar ATH. Falls back to max(High) in 1y df.
        if ath_override is not None and float(ath_override) > 0:
            ath = float(ath_override)
        else:
            ath = float(high_col.max())
            logger.warning(f"{symbol}: No ATH override, using 1y max High as ATH fallback")

        # % down from ATH
        if ath > 0:
            down_from_ath_pct = round(((ath - close) / ath) * 100, 2)
        else:
            down_from_ath_pct = 0.0

        return {
            "symbol": symbol,
            "close": round(close, 2),
            "dma_200": round(dma_200, 2),
            "below_200dma_pct": below_200dma_pct,
            "high_52w": round(high_52w, 2),
            "low_52w": round(low_52w, 2),
            "distance_from_52w_high_pct": distance_from_52w_high_pct,
            "distance_from_52w_low_pct": distance_from_52w_low_pct,
            "ath": round(ath, 2),
            "down_from_ath_pct": down_from_ath_pct,
        }

    except Exception as e:
        logger.error(f"Error computing metrics for {symbol}: {e}")
        return None
