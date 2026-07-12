"""
Metrics engine - computes technical metrics from price data.

v5 — ATH now uses adjusted intraday High (not AdjClose) to capture true peaks.
     ATH = max(High * AdjClose/Close) over 5y daily — matches TradingView.
     Fallback (no 5y data) also uses adjusted High from 1y df instead of raw High.

v4 — Added 20% Rally metrics computation (compute_rally_metrics).

v3 — Accuracy fixes to match TradingView / Screener.in values:

  200 DMA  → rolling(200).mean() on AdjClose column (dividend-adjusted).
  52W High → Yahoo meta `fiftyTwoWeekHigh` (matches screener.in / TV exactly).
  52W Low  → Yahoo meta `fiftyTwoWeekLow`.
  ATH      → ath_override from 5y daily adjusted High (data_fetcher._fetch_ath).
"""
import pandas as pd
from typing import Dict, Optional
import logging

logger = logging.getLogger(__name__)


def compute_rally_metrics(
    symbol: str,
    df: pd.DataFrame,
    movement_threshold_pct: float = 20.0,
    validity_window_days: int = 189,
) -> Dict:
    """
    Translate the V20 Pine Script to Python.

    Scans the OHLCV DataFrame for completed consecutive green-candle streaks
    where the rally from the streak's lowest Low to highest High is >= threshold%.

    Algorithm (mirrors Pine Script exactly):
      1. Identify green candles: close > open.
      2. Group consecutive green candles into "streaks".
      3. For each completed streak (followed by a non-green candle):
           - lowest_low  = min(Low)  across the streak
           - highest_high = max(High) across the streak
           - rally_pct   = ((highest_high - lowest_low) / lowest_low) * 100
           - If rally_pct >= threshold → mark as valid rally
      4. Filter to streaks whose END DATE falls within the last
         `validity_window_days` trading days.
      5. Return the most recent valid rally's details.

    Args:
        symbol               : ticker (for logging)
        df                   : OHLCV DataFrame — needs Open, High, Low, Close columns
                               Should be at least `validity_window_days` rows long.
        movement_threshold_pct: minimum rally % to qualify (default 20.0)
        validity_window_days : how many trading days back to consider (default 189 ≈ 9 months)

    Returns:
        Dict of rally metrics (prefixed with rally_ for scanner clarity).
    """
    default = {
        "has_valid_20pct_rally":          False,
        "last_rally_pct":                 0.0,
        "last_rally_low":                 0.0,
        "last_rally_high":                0.0,
        "last_rally_start_date":          None,
        "last_rally_end_date":            None,
        "days_since_last_rally":          None,
        "total_valid_rallies_in_window":  0,
    }

    if df is None or df.empty:
        return default

    try:
        # ── Normalise columns ────────────────────────────────────────────────
        if isinstance(df.columns, pd.MultiIndex):
            close_col = df["Close"].iloc[:, 0]
            open_col  = df["Open"].iloc[:, 0]
            high_col  = df["High"].iloc[:, 0]
            low_col   = df["Low"].iloc[:, 0]
        else:
            close_col = df["Close"]
            open_col  = df["Open"]
            high_col  = df["High"]
            low_col   = df["Low"]

        # ── Use only the lookback window of data ─────────────────────────────
        # We look back `validity_window_days` rows to find streaks.
        # We scan the full available window but only accept streaks whose
        # END DATE falls within the last `validity_window_days` rows.
        n = len(df)
        window_start_idx = max(0, n - validity_window_days)

        dates    = df.index
        closes   = close_col.values
        opens    = open_col.values
        highs    = high_col.values
        lows     = low_col.values

        # ── Identify green candles across the FULL dataset (needed to find
        #    streak boundaries even before the validity window) ───────────────
        is_green = closes > opens   # bool array, length = n

        # ── Scan for completed streaks in the FULL dataset ───────────────────
        valid_rallies = []  # list of dicts for each qualifying streak

        streak_start = None
        streak_low   = None
        streak_high  = None

        for i in range(n):
            if is_green[i]:
                # Start or continue a streak
                if streak_start is None:
                    streak_start = i
                    streak_low   = lows[i]
                    streak_high  = highs[i]
                else:
                    streak_low   = min(streak_low, lows[i])
                    streak_high  = max(streak_high, highs[i])
            else:
                # Non-green candle → streak closes (if one was running)
                if streak_start is not None:
                    streak_end = i - 1  # last green candle index
                    # Compute rally %
                    if streak_low and streak_low > 0:
                        rally_pct = ((streak_high - streak_low) / streak_low) * 100
                        if rally_pct >= movement_threshold_pct:
                            # Only count if the streak END is within the validity window
                            if streak_end >= window_start_idx:
                                valid_rallies.append({
                                    "rally_pct":    round(rally_pct, 2),
                                    "rally_low":    round(streak_low, 2),
                                    "rally_high":   round(streak_high, 2),
                                    "start_idx":    streak_start,
                                    "end_idx":      streak_end,
                                    "start_date":   str(dates[streak_start].date()),
                                    "end_date":     str(dates[streak_end].date()),
                                    "days_since":   n - 1 - streak_end,  # trading days from streak end to latest bar
                                })
                # Reset streak
                streak_start = None
                streak_low   = None
                streak_high  = None

        # NOTE: If a streak is STILL running at bar[-1] we intentionally skip it
        # (mirrors Pine Script — the label fires only when the streak breaks).

        if not valid_rallies:
            return default

        # ── Most recent valid rally ──────────────────────────────────────────
        # Sort by end_idx descending → first element = most recent
        valid_rallies.sort(key=lambda x: x["end_idx"], reverse=True)
        latest = valid_rallies[0]

        return {
            "has_valid_20pct_rally":          True,
            "last_rally_pct":                 latest["rally_pct"],
            "last_rally_low":                 latest["rally_low"],
            "last_rally_high":                latest["rally_high"],
            "last_rally_start_date":          latest["start_date"],
            "last_rally_end_date":            latest["end_date"],
            "days_since_last_rally":          latest["days_since"],
            "total_valid_rallies_in_window":  len(valid_rallies),
        }

    except Exception as e:
        logger.error(f"compute_rally_metrics error for {symbol}: {e}")
        return default


def compute_metrics(
    symbol: str,
    df: pd.DataFrame,
    ath_override: Optional[float] = None,
    meta_fields: Optional[dict] = None,
    rally_threshold: float = 20.0,
    rally_window_days: int = 189,
) -> Optional[Dict]:
    """
    Compute all required metrics for a stock from its OHLCV DataFrame.

    Args:
        symbol           : Stock ticker
        df               : OHLCV DataFrame (typically 1 year, 250 daily rows)
        ath_override     : ATH from 5y daily data. Falls back to max(High) in df if None.
        meta_fields      : Yahoo Finance meta dict containing fiftyTwoWeekHigh,
                           fiftyTwoWeekLow, regularMarketPrice. If provided, these
                           override the values computed from the df to match screener/TV.
        rally_threshold  : Minimum % move for a streak to qualify as a 20% rally.
        rally_window_days: Trading days back to look for valid rallies (default 189 ≈ 9M).

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
        # ath_override = max(AdjustedHigh) from 5y daily data, computed in
        # data_fetcher._fetch_ath using: High * (AdjClose / Close) per row.
        # This gives the true adjusted intraday ATH, matching TradingView.
        #
        # Fallback (ath_override is None): use max(AdjustedHigh) from the 1y df.
        # This is less accurate (misses peaks > 1y ago) but is still correct
        # in using the adjusted High rather than the raw High for the 1y window.
        if ath_override is not None and float(ath_override) > 0:
            ath = float(ath_override)
        else:
            # Derive adjusted high from the 1y df as a best-effort fallback
            close_vals = close_col.replace(0, float("nan"))
            adj_factors = adj_close_col / close_vals
            adjusted_high_fallback = high_col * adj_factors
            adjusted_high_fallback = adjusted_high_fallback.dropna()
            if not adjusted_high_fallback.empty:
                ath = float(adjusted_high_fallback.max())
            else:
                ath = float(high_col.max())
            logger.warning(
                f"{symbol}: No ATH override — using 1y adjusted High max as fallback: {ath:.2f}. "
                f"This may miss peaks older than 1 year."
            )

        # % down from ATH
        if ath > 0:
            down_from_ath_pct = round(((ath - close) / ath) * 100, 2)
        else:
            down_from_ath_pct = 0.0

        # ── 20% Rally metrics ─────────────────────────────────────────────
        # Always compute so PlayArea and multi-pool scans also get these fields.
        # The strategy itself decides relevance via applies_to_pools.
        rally_metrics = compute_rally_metrics(
            symbol, df,
            movement_threshold_pct=rally_threshold,
            validity_window_days=rally_window_days,
        )

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
            # 20% Rally fields (computed from full available df)
            **rally_metrics,
        }

    except Exception as e:
        logger.error(f"Error computing metrics for {symbol}: {e}")
        return None
