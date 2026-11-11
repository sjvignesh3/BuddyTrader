"""
Markets — the ONE place that knows how India (IN) and the US differ.

A stock's market is never stored: it is read off the symbol. Indian symbols
are kept in yfinance form with an exchange suffix (``TCS.NS`` / ``500325.BO``);
US symbols are the plain Yahoo ticker (``NVDA``, ``BRK-B``). The two forms can
never collide, so every existing IN row and code path keeps working unchanged.

A POOL does carry a market (``pools.market``, migration 026) — it decides how
a bare ticker typed into that pool is read ('NVDA' in a US pool stays 'NVDA';
in an IN pool it becomes 'NVDA.NS', as before). A pool row without the column
(DB not migrated yet) is IN.

Per-market facts kept here:
  * the exchange calendar's time zone (session dates, "today"),
  * the currency (display only — nothing is converted),
  * the daily-sync job type (sync_jobs upserts on (job_type, as_of_date), so
    the US run needs its own or it would overwrite the Indian run's row),
  * whether valuation / fundamentals come from Screener.in (IN only).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any, Dict, Iterable, List, Optional, Tuple

IN = "IN"
US = "US"
MARKETS: Tuple[str, ...] = (IN, US)

_IST = timezone(timedelta(hours=5, minutes=30))


def _new_york() -> tzinfo:
    # DST-aware. Falls back to EST (UTC-5) on a box without tz data — one
    # hour off in summer, which never moves a 16:00 close across midnight.
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo("America/New_York")
    except Exception:  # noqa: BLE001
        return timezone(timedelta(hours=-5))


@dataclass(frozen=True)
class Market:
    code: str
    currency: str
    tz: tzinfo
    daily_job_type: str
    # Screener.in covers Indian companies only: valuation ratios, quarterly
    # fundamentals and the fundamental score exist for IN and nothing else.
    uses_screener: bool
    # When the last session's data is normally published (for log hints).
    settle_hint: str


_MARKETS: Dict[str, Market] = {
    IN: Market(IN, "INR", _IST, "daily_sync", True, "~16:00 IST"),
    US: Market(US, "USD", _new_york(), "daily_sync_us", False, "~17:00 New York"),
}


def normalize_market(raw: Any, default: str = IN) -> str:
    """'us' / ' US ' -> 'US'. Blank / None -> ``default``. Raises on junk."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return default
    code = str(raw).strip().upper()
    if code not in _MARKETS:
        raise ValueError(f"market must be one of {', '.join(MARKETS)}")
    return code


def get_market(code: Any = IN) -> Market:
    return _MARKETS[normalize_market(code)]


def pool_market(pool_row: Optional[Dict[str, Any]]) -> str:
    """Market of a `pools` row; IN when the column is absent or blank."""
    try:
        return normalize_market((pool_row or {}).get("market"))
    except ValueError:
        return IN


# ---------------------------------------------------------------------------
# Symbols
# ---------------------------------------------------------------------------
_IN_SUFFIX_RE = re.compile(r"\.(NS|BO)$", re.IGNORECASE)
_IN_BODY_RE = re.compile(r"^[A-Z0-9&\-]{1,20}$")
# 1-5 letters, optionally a share class: BRK-B / BRK.B / BF-B.
_US_RE = re.compile(r"^[A-Z]{1,5}(?:[.\-][A-Z]{1,2})?$")


def market_of(symbol: Any) -> str:
    """'TCS.NS' / '500325.BO' -> IN; anything else ('NVDA') -> US."""
    return IN if isinstance(symbol, str) and _IN_SUFFIX_RE.search(symbol.strip()) else US


def canonical_symbol(raw: Any, market: str = IN) -> Optional[str]:
    """Any spelling of a ticker -> the stored (yfinance) form, or None.

    IN: 'tcs' / 'TCS' / 'TCS.NS' -> 'TCS.NS'; 'XYZ.BO' passes through.
    US: 'nvda' -> 'NVDA'; 'BRK.B' -> 'BRK-B' (Yahoo's share-class form). A
        symbol carrying an Indian suffix is refused — it is not a US ticker.
    """
    if not isinstance(raw, str):
        return None
    s = raw.strip().upper()
    if not s:
        return None
    if market == US:
        if _IN_SUFFIX_RE.search(s) or not _US_RE.match(s):
            return None
        return s.replace(".", "-")
    m = _IN_SUFFIX_RE.search(s)
    suffix = m.group(0).upper() if m else ".NS"
    body = _IN_SUFFIX_RE.sub("", s)
    if not _IN_BODY_RE.match(body):
        return None
    return f"{body}{suffix}"


def is_valid_symbol(symbol: Any) -> bool:
    """True for a symbol already in stored form, in either market."""
    if not isinstance(symbol, str):
        return False
    return canonical_symbol(symbol, market_of(symbol)) == symbol


def split_by_market(symbols: Iterable[str]) -> Dict[str, List[str]]:
    """Stored symbols -> {'IN': [...], 'US': [...]}, order kept."""
    out: Dict[str, List[str]] = {IN: [], US: []}
    for s in symbols:
        if s:
            out[market_of(s)].append(s)
    return out


def filter_market(symbols: Iterable[str], market: str) -> List[str]:
    return [s for s in symbols if s and market_of(s) == market]


# ---------------------------------------------------------------------------
# Exchanges (US) — Yahoo codes -> the names TradingView uses
# ---------------------------------------------------------------------------
_YAHOO_EXCHANGE = {
    "NMS": "NASDAQ", "NGM": "NASDAQ", "NCM": "NASDAQ", "NAS": "NASDAQ",
    "NYQ": "NYSE", "NYS": "NYSE",
    "ASE": "AMEX", "PCX": "AMEX", "BTS": "AMEX",
}
US_EXCHANGES = ("NASDAQ", "NYSE", "AMEX")
_US_PREFIX_ALIASES = {"NASDAQ": "NASDAQ", "NYSE": "NYSE", "AMEX": "AMEX",
                      "ARCA": "AMEX", "NYSEARCA": "AMEX", "BATS": "AMEX"}


def us_exchange(raw: Any) -> Optional[str]:
    """Yahoo's 'NMS' / 'NYQ', or a TradingView prefix ('nasdaq') -> 'NASDAQ' /
    'NYSE' / 'AMEX'. None when unknown."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    code = raw.strip().upper()
    return _YAHOO_EXCHANGE.get(code) or _US_PREFIX_ALIASES.get(code)


def default_exchange(symbol: str) -> str:
    """Exchange for a NEW stock row when nothing better is known."""
    if market_of(symbol) == US:
        return "NASDAQ"
    return "BSE" if symbol.upper().endswith(".BO") else "NSE"


# ---------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------
def today_in(market: Any = IN, now: Optional[datetime] = None) -> date:
    """Today's date on the market's own calendar, whatever the runner's TZ."""
    tz = get_market(market).tz
    return (now.astimezone(tz) if now is not None else datetime.now(tz)).date()
