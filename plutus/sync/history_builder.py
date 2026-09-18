"""
Convert a raw yfinance history DataFrame into typed OHLCV bars.

Stage 4 sync worker calls `bars_from_df(df)` once per symbol; the resulting
list feeds `compute_snapshot`. All prices become Decimals — zero float leaks
into the metrics engine.

Also exposes `extract_meta(info)` which lifts the small set of `.info` keys
we care about into a stable dict shape (regularMarketPrice, 52W high/low),
so the pipeline never depends on yfinance-specific key naming, and
`quote_bar(info)` / `merge_quote_bar(...)` which stand the QUOTE in for the
last session's daily bar while Yahoo's chart feed still lags overnight.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from plutus.metrics.rally import OHLCVBar
from plutus.registry.types import to_decimal


_REQUIRED_COLS = ("Open", "High", "Low", "Close")


def _is_nan(value: Any) -> bool:
    return isinstance(value, float) and math.isnan(value)


def _coerce_date(value: Any) -> Optional[date]:
    """DataFrame index rows come as pandas.Timestamp; normalise to date.

    NOTE: pandas.Timestamp subclasses datetime (and datetime subclasses
    date), so a plain `isinstance(value, date)` check would return the
    Timestamp UNCONVERTED — which later breaks `bar.d <= snapshot_date`
    comparisons. Only a bare `date` passes through as-is.
    """
    if value is None:
        return None
    if isinstance(value, date) and not hasattr(value, "hour"):
        return value  # a true datetime.date (datetimes/Timestamps have .hour)
    to_date = getattr(value, "date", None)
    if callable(to_date):
        try:
            return to_date()
        except Exception:
            return None
    return None


def bars_from_df(df: Any) -> List[OHLCVBar]:
    """
    Turn a yfinance `.history()` DataFrame into a chronologically-sorted list
    of `OHLCVBar`. Rows with any NaN in the required OHLC columns are dropped.

    Empty / None input returns an empty list — no exception. The Stage 4
    worker treats an empty history as "skip this symbol".
    """
    if df is None:
        return []
    # Duck-type check for DataFrame-ness so tests can pass any iterable-of-rows.
    if not hasattr(df, "iterrows") or not hasattr(df, "columns"):
        return []
    if len(df) == 0:
        return []

    cols = list(df.columns)
    for c in _REQUIRED_COLS:
        if c not in cols:
            return []

    # Sort by index ascending so the newest bar is always at the end.
    try:
        df = df.sort_index()
    except Exception:
        pass

    has_adj = "Adj Close" in cols
    has_vol = "Volume" in cols

    bars: List[OHLCVBar] = []
    for idx, row in df.iterrows():
        d = _coerce_date(idx)
        if d is None:
            continue
        o = row.get("Open") if hasattr(row, "get") else row["Open"]
        h = row.get("High") if hasattr(row, "get") else row["High"]
        low = row.get("Low") if hasattr(row, "get") else row["Low"]
        c = row.get("Close") if hasattr(row, "get") else row["Close"]
        if any(v is None or _is_nan(v) for v in (o, h, low, c)):
            continue
        adj = row.get("Adj Close") if has_adj else None
        if adj is None or _is_nan(adj):
            adj = c  # no adjustment data -> adjusted == raw
        vol_raw = row.get("Volume") if has_vol else None
        try:
            vol = int(vol_raw) if vol_raw is not None and not _is_nan(vol_raw) else None
        except (TypeError, ValueError):
            vol = None
        try:
            bars.append(OHLCVBar.make(d, o, h, low, c, adj_c=adj, volume=vol))
        except Exception:
            # Individual row conversion problem — skip that row, keep rest.
            continue
    return bars


# -----------------------------------------------------------------------------
# .info -> stable meta dict
# -----------------------------------------------------------------------------
_META_PRICE_KEYS = ("regularMarketPrice", "currentPrice", "previousClose")
_META_52W_HIGH = ("fiftyTwoWeekHigh",)
_META_52W_LOW = ("fiftyTwoWeekLow",)


def _first_positive(info: Dict[str, Any], keys) -> Optional[Decimal]:
    if not info:
        return None
    for k in keys:
        v = info.get(k)
        if v is None:
            continue
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            continue
        try:
            d = to_decimal(v)
        except Exception:
            continue
        if d is not None and d > 0:
            return d
    return None


def extract_meta(info: Dict[str, Any]) -> Dict[str, Any]:
    """
    Build the tiny 'meta' dict the metrics pipeline expects.

    Keys produced (all optional):
      - regularMarketPrice
      - fiftyTwoWeekHigh
      - fiftyTwoWeekLow
      - marketState        (Yahoo's "REGULAR" / "CLOSED" / "PRE" / ...)
      - quoteSessionDate   (IST date of regularMarketTime)
    """
    if not info:
        return {}
    out: Dict[str, Any] = {}
    px = _first_positive(info, _META_PRICE_KEYS)
    if px is not None:
        out["regularMarketPrice"] = px
    hi = _first_positive(info, _META_52W_HIGH)
    if hi is not None:
        out["fiftyTwoWeekHigh"] = hi
    lo = _first_positive(info, _META_52W_LOW)
    if lo is not None:
        out["fiftyTwoWeekLow"] = lo
    state = info.get("marketState")
    if state:
        out["marketState"] = str(state)
    qd = quote_session_date(info)
    if qd is not None:
        out["quoteSessionDate"] = qd
    return out


# -----------------------------------------------------------------------------
# Quote -> session bar
#
# Yahoo serves two feeds that finalise at very different times. The daily-bar
# chart lags: from midnight IST until some time the next morning the previous
# session's row comes back NaN (and is dropped by bars_from_df), while the
# QUOTE (regularMarketPrice + regularMarketTime) carries that session's close
# within minutes of 15:30. Standing the quote in for the missing bar makes an
# off-hours run describe the LAST session instead of silently falling back to
# the one before it (2026-09-18 diagnosis: a 07:26 IST run wrote Sep-16 closes
# for 27 of 64 journal symbols).
# -----------------------------------------------------------------------------
IST = timezone(timedelta(hours=5, minutes=30))

# During the regular session history already carries a live bar for today, so
# the quote adds nothing; in pre-open the quote may be today's indicative price,
# which is never a settled close.
_LIVE_MARKET_STATES = frozenset({"REGULAR"})
_PRE_MARKET_STATES = frozenset({"PRE", "PREPRE"})


def quote_session_date(info: Dict[str, Any], tz: timezone = IST) -> Optional[date]:
    """IST calendar date of the quote's `regularMarketTime` (epoch seconds)."""
    ts = info.get("regularMarketTime") if info else None
    if ts is None or _is_nan(ts):
        return None
    try:
        return datetime.fromtimestamp(int(ts), tz).date()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def quote_bar(info: Dict[str, Any], *, today: Optional[date] = None,
              tz: timezone = IST) -> Optional[OHLCVBar]:
    """
    The latest session as an `OHLCVBar` built from the quote fields of `.info`.

    Returns None when the quote cannot stand in for a settled session bar:
      * no `regularMarketTime` or non-positive `regularMarketPrice`;
      * `marketState` REGULAR — the history bar is live and authoritative;
      * pre-open (PRE / PREPRE) with the quote already dated today.
    Open / High / Low fall back to the price when Yahoo omits them (and are
    widened so High >= Open, Close >= Low); volume is optional.
    """
    if not info:
        return None
    d = quote_session_date(info, tz)
    if d is None:
        return None
    state = str(info.get("marketState") or "").upper()
    if state in _LIVE_MARKET_STATES:
        return None
    today = today or datetime.now(tz).date()
    if state in _PRE_MARKET_STATES and d >= today:
        return None
    px = _first_positive(info, ("regularMarketPrice",))
    if px is None:
        return None
    o = _first_positive(info, ("regularMarketOpen", "open")) or px
    h = _first_positive(info, ("regularMarketDayHigh", "dayHigh")) or px
    lo = _first_positive(info, ("regularMarketDayLow", "dayLow")) or px
    h = max(h, o, px)
    lo = min(lo, o, px)
    vol_raw = info.get("regularMarketVolume", info.get("volume"))
    try:
        vol = int(vol_raw) if vol_raw is not None and not _is_nan(vol_raw) else None
    except (TypeError, ValueError):
        vol = None
    try:
        return OHLCVBar.make(d, o, h, lo, px, adj_c=px, volume=vol)
    except Exception:
        return None


def merge_quote_bar(bars: List[OHLCVBar],
                    qbar: Optional[OHLCVBar]) -> Tuple[List[OHLCVBar], bool]:
    """
    Append `qbar` when it is NEWER than the last history bar.

    Same date -> the history bar wins (it is the session's real OHLCV and the
    two agree on close anyway); older -> ignored. Returns (bars, appended).
    """
    if qbar is None:
        return list(bars), False
    if bars and bars[-1].d >= qbar.d:
        return list(bars), False
    return [*bars, qbar], True
