"""
Screener Data Fetcher — Fetches fundamental data from Screener.in for NSE stocks.

ROOT CAUSE FINDINGS (from HTML inspection):
  ─────────────────────────────────────────────────────────────────────────────
  Screener.in renders financial tables ONLY for authenticated (logged-in) users.
  Without a valid session cookie, ALL <span class="number"> tags are EMPTY and
  table <thead>/<tbody> have NO data columns — just row labels.

  This means HTML scraping without login returns NOTHING for:
    • Quarterly Sales / PBT / Net Profit
    • Key ratios (PE, ROCE, ROE, Book Value)
    • Shareholding / pledging

  However, the CHART API is publicly accessible (no login required):
    GET /api/company/{id}/chart/?q=Price+to+Earning&days=N
    GET /api/company/{id}/chart/?q=Price+to+book+value&days=N

  And the SEARCH API resolves symbol → numeric company ID (no login):
    GET /api/company/search/?q=SYMBOL

DATA STRATEGY:
  ─────────────────────────────────────────────────────────────────────────────
  TIER 1 — PUBLIC (no login required, always available):
    • Company ID lookup via search API
    • PE daily history (up to 10 years) — compute N-year average PE
    • PB daily history (up to 10 years) — compute N-year average PB
    • Current PE and current PB from the last data point

  TIER 2 — AUTHENTICATED (requires SCREENER_EMAIL + SCREENER_PASSWORD env vars):
    • Full HTML page with populated quarterly results table
    • ROCE, ROE from key ratios section
    • Promoter shareholding + pledging
    • Quarterly Sales, PBT, Net Profit

  The fetcher tries Tier 2 first if credentials are configured, falls back to
  Tier 1 data only. Rules that depend on Tier 2 data will report "not available"
  (FAIL) when running unauthenticated — this is clearly communicated in rule details.

LOGIN FLOW (Tier 2):
  1. GET https://www.screener.in/login/  →  extract csrfmiddlewaretoken
  2. POST credentials + CSRF token       →  receive sessionid cookie
  3. Reuse session for all company pages (session lasts ~2 weeks on screener.in)
  4. Re-login automatically on session expiry (HTTP 302 back to /login/)

CACHE:
  • Symbol → company ID: indefinite (never changes)
  • PE/PB chart data:     6-hour TTL
  • Full fundamental:     6-hour TTL
  • Session cookie:       persisted in memory, re-created on expiry
"""
import logging
import os
import re
import time
import json
import urllib.request
import urllib.error
import urllib.parse
import http.cookiejar
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any, Tuple

logger = logging.getLogger(__name__)

# ── Cache ────────────────────────────────────────────────────────────────────
_fundamental_cache: Dict[str, Dict] = {}   # symbol → {data, fetched_at}
_company_id_cache: Dict[str, int] = {}     # symbol → numeric ID (permanent)
CACHE_TTL = timedelta(hours=6)

# ── Screener base URL ────────────────────────────────────────────────────────
SCREENER_BASE = "https://www.screener.in"

# ── Session state (Tier 2 auth) ──────────────────────────────────────────
_session: Optional[http.cookiejar.CookieJar] = None
_session_valid: bool = False
_session_last_login: Optional[datetime] = None
SESSION_TTL = timedelta(hours=12)   # re-login after 12 hours
_login_error_reason: Optional[str] = None   # human-readable last failure cause

_HEADERS_BASE = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


# ═══════════════════════════════════════════════════════════════════════════
#  SESSION / AUTH  (Tier 2)
# ═══════════════════════════════════════════════════════════════════════════

def _get_credentials() -> Tuple[Optional[str], Optional[str]]:
    """Read screener.in credentials from environment variables."""
    email = os.environ.get("SCREENER_EMAIL", "").strip()
    password = os.environ.get("SCREENER_PASSWORD", "").strip()
    return (email or None, password or None)


def _build_opener(cj: http.cookiejar.CookieJar) -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def _login() -> bool:
    """
    Perform a full screener.in login and store the session cookie.
    Returns True on success, and populates _login_error_reason on failure.

    Failure reasons:
      "network_blocked"   — OS/firewall blocks outbound TCP to screener.in
      "wrong_credentials" — login page returned, credentials rejected
      "csrf_not_found"    — login page HTML changed, CSRF token missing
      "network_error:<e>" — other socket/connection error
      "error:<e>"         — unexpected exception
    """
    global _session, _session_valid, _session_last_login, _login_error_reason

    email, password = _get_credentials()
    if not email or not password:
        logger.debug("Screener credentials not configured — running in public-only mode")
        return False

    cj = http.cookiejar.CookieJar()
    opener = _build_opener(cj)

    try:
        # ── Step 1: GET login page → extract CSRF token ───────────────────
        login_page_req = urllib.request.Request(
            f"{SCREENER_BASE}/login/",
            headers={**_HEADERS_BASE, "Accept": "text/html,application/xhtml+xml"}
        )
        with opener.open(login_page_req, timeout=20) as r:
            html = r.read().decode("utf-8")

        csrf_m = re.search(
            r'name=["\']csrfmiddlewaretoken["\']\s+value=["\']([^"\']+)["\']',
            html
        )
        if not csrf_m:
            logger.warning("Screener login: could not find CSRF token in login page")
            _login_error_reason = "csrf_not_found"
            return False
        csrf_token = csrf_m.group(1)

        # ── Step 2: POST credentials ──────────────────────────────────────
        post_data = urllib.parse.urlencode({
            "csrfmiddlewaretoken": csrf_token,
            "username": email,
            "password": password,
            "next": "",
        }).encode("utf-8")

        login_req = urllib.request.Request(
            f"{SCREENER_BASE}/login/",
            data=post_data,
            headers={
                **_HEADERS_BASE,
                "Accept": "text/html,application/xhtml+xml",
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": f"{SCREENER_BASE}/login/",
                "X-CSRFToken": csrf_token,
            }
        )
        with opener.open(login_req, timeout=20) as r:
            final_url = r.geturl()
            resp_html = r.read().decode("utf-8")

        if "/login/" in final_url:
            # Try to extract the exact error screener.in returns
            err_m = re.search(
                r'class="errorlist".*?<li>(.*?)</li>', resp_html, re.DOTALL
            )
            site_error = ""
            if err_m:
                site_error = re.sub(r"<[^>]+>", "", err_m.group(1)).strip()

            logger.warning(
                f"Screener login FAILED — credentials rejected for {email}. "
                f"Site says: '{site_error}'. "
                "Verify email/password at https://www.screener.in/login/"
            )
            _login_error_reason = f"wrong_credentials: {site_error}" if site_error else "wrong_credentials"
            return False

        _session = cj
        _session_valid = True
        _session_last_login = datetime.now()
        _login_error_reason = None
        logger.info(f"Screener.in login successful for {email}")
        return True

    except OSError as e:
        err_str = str(e)
        if e.errno == 99 or "Cannot assign requested address" in err_str or "Connection refused" in err_str:
            logger.warning(
                "Screener login BLOCKED — network cannot reach screener.in. "
                "This environment restricts outbound connections to screener.in. "
                "Run the backend locally where screener.in is reachable."
            )
            _login_error_reason = "network_blocked"
        else:
            logger.warning(f"Screener login network error: {e}")
            _login_error_reason = f"network_error: {err_str}"
        return False
    except Exception as e:
        logger.warning(f"Screener login error: {e}")
        _login_error_reason = f"error: {e}"
        return False


def _get_session() -> Optional[urllib.request.OpenerDirector]:
    """
    Return an authenticated opener, logging in if needed.
    Returns None if credentials are not configured or login fails.
    """
    global _session, _session_valid, _session_last_login

    # Check if session needs renewal
    if _session_valid and _session_last_login:
        age = datetime.now() - _session_last_login
        if age > SESSION_TTL:
            logger.info("Screener session expired — re-logging in")
            _session_valid = False

    if not _session_valid:
        if not _login():
            return None

    if _session is None:
        return None

    return _build_opener(_session)


def is_authenticated() -> bool:
    """Check whether an authenticated session is available."""
    return _session_valid


# ═══════════════════════════════════════════════════════════════════════════
#  COMPANY ID LOOKUP  (public — no login)
# ═══════════════════════════════════════════════════════════════════════════

def _get_company_id(symbol: str) -> Optional[int]:
    """
    Resolve NSE symbol → screener.in numeric company ID.
    Uses the public search API — no login required.
    Results are cached permanently (IDs never change).
    """
    if symbol in _company_id_cache:
        return _company_id_cache[symbol]

    url = f"{SCREENER_BASE}/api/company/search/?q={urllib.parse.quote(symbol)}"
    try:
        req = urllib.request.Request(
            url,
            headers={
                **_HEADERS_BASE,
                "Accept": "application/json",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": f"{SCREENER_BASE}/",
            }
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            results = json.loads(r.read().decode("utf-8"))

        # Find exact match first (symbol matches URL slug)
        for item in results:
            item_url = item.get("url", "")
            # URL is like /company/PAGEIND/ — extract symbol
            url_sym = item_url.strip("/").split("/")[-1].upper()
            if url_sym == symbol.upper():
                cid = int(item["id"])
                _company_id_cache[symbol] = cid
                return cid

        # Fallback: take first result
        if results:
            cid = int(results[0]["id"])
            _company_id_cache[symbol] = cid
            logger.debug(f"ID for {symbol} (fuzzy match): {cid} ({results[0].get('name')})")
            return cid

    except Exception as e:
        logger.debug(f"Company ID lookup failed for {symbol}: {e}")

    return None


# ═══════════════════════════════════════════════════════════════════════════
#  TIER 1 — PUBLIC CHART API  (PE / PB history)
# ═══════════════════════════════════════════════════════════════════════════

def _fetch_chart(company_id: int, metric: str, days: int = 3650) -> List[Tuple[str, float]]:
    """
    Fetch time-series data from screener's public chart API.
    Returns [(date_str, value), ...] sorted oldest → newest.
    No login required.
    """
    url = (
        f"{SCREENER_BASE}/api/company/{company_id}/chart/"
        f"?q={urllib.parse.quote(metric)}&days={days}"
    )
    try:
        req = urllib.request.Request(
            url,
            headers={
                **_HEADERS_BASE,
                "Accept": "application/json",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": f"{SCREENER_BASE}/company/",
            }
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))

        datasets = data.get("datasets", [])
        if datasets:
            raw = datasets[0].get("values", [])
            return [(row[0], float(row[1])) for row in raw if row[1] is not None and float(row[1]) > 0]
    except Exception as e:
        logger.debug(f"Chart fetch failed for ID={company_id} metric={metric}: {e}")

    return []


def _compute_avg(series: List[Tuple[str, float]], years: int) -> Optional[float]:
    """Compute the average of `years` most recent years in a daily series."""
    if not series:
        return None
    cutoff = (datetime.now() - timedelta(days=years * 365)).strftime("%Y-%m-%d")
    window = [v for d, v in series if d >= cutoff]
    return round(sum(window) / len(window), 2) if window else None


def _fetch_public_valuation(symbol: str, company_id: int) -> Dict[str, Any]:
    """
    Fetch PE and PB history from the public chart API.
    Computes current values and N-year averages.
    """
    pe_series = _fetch_chart(company_id, "Price to Earning", days=3650)
    pb_series = _fetch_chart(company_id, "Price to book value", days=3650)

    current_pe = pe_series[-1][1] if pe_series else None
    current_pb = pb_series[-1][1] if pb_series else None

    return {
        "current_pe": current_pe,
        "current_pb": current_pb,
        "pe_series": pe_series,   # [(date, value), ...]
        "pb_series": pb_series,
        # Pre-computed averages for common lookback windows
        "pe_avg_3yr": _compute_avg(pe_series, 3),
        "pe_avg_5yr": _compute_avg(pe_series, 5),
        "pe_avg_10yr": _compute_avg(pe_series, 10),
        "pb_avg_3yr": _compute_avg(pb_series, 3),
        "pb_avg_5yr": _compute_avg(pb_series, 5),
        "pb_avg_10yr": _compute_avg(pb_series, 10),
    }


# ═══════════════════════════════════════════════════════════════════════════
#  TIER 2 — AUTHENTICATED HTML PARSING
# ═══════════════════════════════════════════════════════════════════════════

def _fetch_company_page(symbol: str, opener: urllib.request.OpenerDirector) -> Optional[str]:
    """Fetch the full authenticated company page HTML."""
    for path in [
        f"/company/{urllib.parse.quote(symbol)}/consolidated/",
        f"/company/{urllib.parse.quote(symbol)}/",
    ]:
        url = f"{SCREENER_BASE}{path}"
        try:
            req = urllib.request.Request(
                url,
                headers={
                    **_HEADERS_BASE,
                    "Accept": "text/html,application/xhtml+xml",
                    "Referer": f"{SCREENER_BASE}/",
                }
            )
            with opener.open(req, timeout=25) as r:
                final_url = r.geturl()
                html = r.read().decode("utf-8")

            # Redirected back to login = session expired
            if "/login/" in final_url:
                logger.info(f"Session expired fetching {symbol} — will re-login")
                return None

            # Verify numbers are populated (not empty spans)
            sample_numbers = re.findall(r'<span class="number">([^<]+)</span>', html)
            populated = [n for n in sample_numbers if n.strip()]
            if populated:
                logger.debug(f"{symbol}: authenticated page loaded ({len(populated)} values)")
                return html

            logger.debug(f"{symbol}: page loaded but numbers empty on {path}")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            logger.debug(f"HTTP {e.code} fetching {symbol} from {path}")
        except Exception as e:
            logger.debug(f"Error fetching {symbol}: {e}")

    return None


def _parse_number(text: str) -> Optional[float]:
    """Parse a number string, handling commas and % signs."""
    if not text:
        return None
    text = text.strip().replace(",", "").replace("%", "").replace("\xa0", "")
    if text in ("", "—", "-", "NA", "N/A"):
        return None
    try:
        return float(text)
    except (ValueError, TypeError):
        return None


def _parse_section_table(html: str, section_id: str) -> List[List[str]]:
    """
    Parse a section's data table into a list of rows (each row = list of cell strings).
    Handles screener.in's standard: <section id="..."><table class="data-table">...
    """
    rows: List[List[str]] = []
    m = re.search(rf'<section[^>]*id="{section_id}"[^>]*>(.*?)</section>', html, re.DOTALL)
    if not m:
        return rows

    section_html = m.group(1)

    # Extract header row
    thead_m = re.search(r'<thead>(.*?)</thead>', section_html, re.DOTALL)
    if thead_m:
        ths = re.findall(r'<th[^>]*>(.*?)</th>', thead_m.group(1), re.DOTALL)
        header = [re.sub(r'<[^>]+>', '', h).strip() for h in ths]
        if header:
            rows.append(header)

    # Extract body rows
    tbody_m = re.search(r'<tbody>(.*?)</tbody>', section_html, re.DOTALL)
    if tbody_m:
        for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', tbody_m.group(1), re.DOTALL):
            cells = re.findall(r'<td[^>]*>(.*?)</td>', tr, re.DOTALL)
            cleaned = []
            for c in cells:
                text = re.sub(r'<[^>]+>', '', c)
                text = re.sub(r'\s+', ' ', text).strip()
                cleaned.append(text)
            if cleaned:
                rows.append(cleaned)

    return rows


def _extract_quarterly_results(html: str) -> List[Dict]:
    """
    Extract quarterly Sales, PBT, Net Profit from the #quarters section.
    Requires authenticated HTML (data populated by server).
    """
    quarters: List[Dict] = []
    rows = _parse_section_table(html, "quarters")
    if not rows:
        return quarters

    headers = rows[0]  # e.g. ['', 'Sep 2023', 'Dec 2023', ...]
    if len(headers) < 2:
        return quarters

    sales_row = pbt_row = net_profit_row = None

    for row in rows[1:]:
        if not row:
            continue
        label = row[0].lower()
        # "Sales +" or "Revenue +"
        if (label.startswith("sales") or label.startswith("revenue")) and sales_row is None:
            sales_row = row
        # "Profit before tax"
        elif ("profit before tax" in label or label.strip() == "pbt") and pbt_row is None:
            pbt_row = row
        # "Net Profit +" — not "profit before tax", not "other income"
        elif "net profit" in label and "before" not in label and net_profit_row is None:
            net_profit_row = row

    for i in range(1, len(headers)):
        quarters.append({
            "quarter": headers[i].strip(),
            "sales": _parse_number(sales_row[i]) if sales_row and i < len(sales_row) else None,
            "pbt": _parse_number(pbt_row[i]) if pbt_row and i < len(pbt_row) else None,
            "net_profit": _parse_number(net_profit_row[i]) if net_profit_row and i < len(net_profit_row) else None,
        })

    return quarters


def _extract_ratios(html: str) -> Dict[str, Any]:
    """
    Extract key ratios from the authenticated company page.
    Parses each <li> in the #top-ratios section individually.
    Returns: {current_pe, current_pb, roce, roe}
    """
    ratios: Dict[str, Any] = {
        "current_pe": None, "current_pb": None,
        "roce": None, "roe": None,
    }

    # Parse each <li> into {label: value}
    ratio_map: Dict[str, float] = {}
    for li in re.findall(r'<li[^>]*>(.*?)</li>', html, re.DOTALL):
        name_m = re.search(r'class="name"[^>]*>(.*?)</span>', li, re.DOTALL)
        num_m = re.search(r'class="number">([\d,.\-]+)</span>', li)
        if name_m and num_m:
            label = re.sub(r'<[^>]+>', '', name_m.group(1)).strip()
            value = _parse_number(num_m.group(1))
            if label and value is not None:
                ratio_map[label] = value

    ratios["current_pe"] = ratio_map.get("Stock P/E")
    ratios["roce"] = ratio_map.get("ROCE")
    ratios["roe"] = ratio_map.get("ROE")

    # PB = Current Price / Book Value
    price = ratio_map.get("Current Price")
    book = ratio_map.get("Book Value")
    if price and book and book > 0:
        ratios["current_pb"] = round(price / book, 2)

    return ratios


def _extract_shareholding(html: str) -> Dict[str, Any]:
    """
    Extract promoter holding % and pledging % from the shareholding section.
    Returns defaults (None / 0.0) when section or data is absent.
    """
    result = {"promoter_holding_pct": None, "promoter_pledging_pct": None}

    rows = _parse_section_table(html, "shareholding")
    for row in rows:
        if not row:
            continue
        label = row[0].lower().replace("\xa0", " ").strip()
        if "promoter" in label and "pledge" not in label and result["promoter_holding_pct"] is None:
            for val in reversed(row[1:]):
                v = _parse_number(val)
                if v is not None:
                    result["promoter_holding_pct"] = v
                    break
        if "pledge" in label and result["promoter_pledging_pct"] is None:
            for val in reversed(row[1:]):
                v = _parse_number(val)
                if v is not None:
                    result["promoter_pledging_pct"] = v
                    break

    # Regex fallback for pledging (sometimes in a sub-row not captured by table parser)
    if result["promoter_pledging_pct"] is None:
        sh_m = re.search(r'id="shareholding".*?</section>', html, re.DOTALL)
        if sh_m:
            pledge_m = re.search(
                r'[Pp]ledg(?:ed?|ing)[^<]*?(?:<[^>]*>)*\s*([\d.,]+)\s*%',
                sh_m.group(), re.DOTALL
            )
            if pledge_m:
                result["promoter_pledging_pct"] = _parse_number(pledge_m.group(1))

    # Default 0 when no pledging row exists (common for zero-pledge companies)
    if result["promoter_pledging_pct"] is None:
        result["promoter_pledging_pct"] = 0.0

    return result


# ═══════════════════════════════════════════════════════════════════════════
#  PRIMARY PUBLIC API
# ═══════════════════════════════════════════════════════════════════════════

def fetch_fundamental_data(symbol: str) -> Optional[Dict]:
    """
    Fetch and parse all fundamental data for one NSE stock.

    Data availability depends on authentication:
      ┌──────────────────────────┬──────────────────────────────────────────┐
      │ Field                    │ Source                                   │
      ├──────────────────────────┼──────────────────────────────────────────┤
      │ current_pe, current_pb   │ Tier 1 (public chart API) — always       │
      │ pe_avg_Xyr, pb_avg_Xyr   │ Tier 1 (public chart API) — always       │
      │ roce, roe                │ Tier 2 (auth HTML) — needs credentials   │
      │ quarterly Sales/PBT/NP   │ Tier 2 (auth HTML) — needs credentials   │
      │ promoter pledging        │ Tier 2 (auth HTML) — needs credentials   │
      └──────────────────────────┴──────────────────────────────────────────┘

    Returns None only if the company is not found at all.
    """
    # Cache check
    if symbol in _fundamental_cache:
        cached = _fundamental_cache[symbol]
        if datetime.now() - cached["fetched_at"] < CACHE_TTL:
            return cached["data"]

    # ── TIER 1: Company ID + public chart data ────────────────────────────
    company_id = _get_company_id(symbol)
    if company_id is None:
        logger.warning(f"{symbol}: not found on screener.in")
        return None

    valuation = _fetch_public_valuation(symbol, company_id)

    # ── TIER 2: Authenticated page (quarterly + ratios + shareholding) ────
    quarterly: List[Dict] = []
    ratios: Dict = {
        "current_pe": valuation["current_pe"],   # prefer chart-derived (more up-to-date)
        "current_pb": valuation["current_pb"],
        "roce": None,
        "roe": None,
    }
    shareholding: Dict = {"promoter_holding_pct": None, "promoter_pledging_pct": None}
    auth_available = False

    opener = _get_session()
    if opener:
        html = _fetch_company_page(symbol, opener)
        if html is None:
            # Session may have expired — try one re-login
            global _session_valid
            _session_valid = False
            opener2 = _get_session()
            if opener2:
                html = _fetch_company_page(symbol, opener2)

        if html:
            quarterly = _extract_quarterly_results(html)
            page_ratios = _extract_ratios(html)
            shareholding = _extract_shareholding(html)
            auth_available = True

            # Use page ratios for ROCE/ROE; keep chart PE/PB (more accurate)
            ratios["roce"] = page_ratios.get("roce")
            ratios["roe"] = page_ratios.get("roe")
            # Fallback: if chart PE/PB failed, use page values
            if ratios["current_pe"] is None:
                ratios["current_pe"] = page_ratios.get("current_pe")
            if ratios["current_pb"] is None:
                ratios["current_pb"] = page_ratios.get("current_pb")

    data = {
        "symbol": symbol,
        "company_id": company_id,
        "auth_available": auth_available,
        "quarterly_results": quarterly,
        "ratios": ratios,
        "shareholding": shareholding,
        # Valuation time series (for PE/PB average calculations in screener engine)
        "valuation": valuation,
        "fetched_at": datetime.now().isoformat(),
    }

    _fundamental_cache[symbol] = {"data": data, "fetched_at": datetime.now()}

    logger.info(
        f"{symbol} (ID={company_id}): "
        f"auth={auth_available}, "
        f"quarters={len(quarterly)}, "
        f"PE={ratios.get('current_pe')}, "
        f"PB={ratios.get('current_pb')}, "
        f"ROCE={ratios.get('roce')}, "
        f"ROE={ratios.get('roe')}, "
        f"pledging={shareholding.get('promoter_pledging_pct')}%"
    )

    return data


def fetch_fundamental_data_batch(symbols: List[str]) -> Dict[str, Dict]:
    """
    Fetch fundamental data for multiple symbols.
    Returns {symbol: data_dict} for all symbols found.
    Rate-limited to be polite to screener.in (~1 req/sec for Tier 2).
    """
    results: Dict[str, Dict] = {}
    to_fetch: List[str] = []

    for sym in symbols:
        if sym in _fundamental_cache:
            cached = _fundamental_cache[sym]
            if datetime.now() - cached["fetched_at"] < CACHE_TTL:
                results[sym] = cached["data"]
                continue
        to_fetch.append(sym)

    if not to_fetch:
        logger.info(f"All {len(symbols)} symbols served from fundamental cache")
        return results

    logger.info(
        f"Fetching fundamentals for {len(to_fetch)} stocks "
        f"({len(symbols) - len(to_fetch)} from cache) | "
        f"auth={'YES' if is_authenticated() else 'NO — set SCREENER_EMAIL + SCREENER_PASSWORD'}"
    )

    for i, sym in enumerate(to_fetch):
        data = fetch_fundamental_data(sym)
        if data:
            results[sym] = data

        if (i + 1) % 5 == 0:
            logger.info(f"  Fundamentals: {i + 1}/{len(to_fetch)}")

        # Rate limit: Tier 1 is fast (just chart API), Tier 2 adds HTML fetch
        if i < len(to_fetch) - 1:
            time.sleep(0.5 if is_authenticated() else 0.3)

    logger.info(f"Fundamentals loaded: {len(results)}/{len(symbols)} stocks")
    return results


def clear_fundamental_cache():
    """Clear the in-memory fundamental data cache."""
    global _fundamental_cache
    _fundamental_cache = {}
    logger.info("Fundamental data cache cleared")


def get_auth_status() -> Dict[str, Any]:
    """
    Return current authentication status for API exposure.
    If credentials are configured but login hasn't been attempted yet,
    attempt it now so the status is always accurate on first page load.
    """
    global _session_valid, _login_error_reason

    email, _ = _get_credentials()

    # ── Eagerly attempt login if credentials exist but no attempt yet ──────
    # This covers the "just started the backend" case — the UI hits /auth-status
    # before any scan is run, so _login() has never been called.
    if email and not _session_valid and _login_error_reason is None:
        logger.info("Auth-status: credentials present, attempting login now...")
        _login()  # populates _session_valid and _login_error_reason

    network_blocked   = _login_error_reason == "network_blocked"
    wrong_credentials = (
        _login_error_reason is not None
        and str(_login_error_reason).startswith("wrong_credentials")
    )

    if _session_valid:
        mode = "full"
        note = "Authenticated — all data available."
    elif not email:
        mode = "public_only"
        note = "Set SCREENER_EMAIL and SCREENER_PASSWORD to enable full data."
    elif network_blocked:
        mode = "network_blocked"
        note = (
            "Credentials are correct, but this server's network blocks screener.in. "
            "Run the backend on your local machine where screener.in is accessible."
        )
    elif wrong_credentials:
        # Extract site message after "wrong_credentials: "
        site_msg = str(_login_error_reason).replace("wrong_credentials:", "").strip()
        mode = "wrong_credentials"
        note = (
            f"Login rejected by screener.in — {site_msg}. "
            "Verify your email and password at https://www.screener.in/login/"
        )
    else:
        mode = "credentials_configured"
        note = (
            f"Login failed with an unexpected error: {_login_error_reason or 'unknown'}. "
            "Check backend logs for details."
        )

    return {
        "authenticated": _session_valid,
        "email_configured": bool(email),
        "network_blocked": network_blocked,
        "wrong_credentials": wrong_credentials,
        "last_login": _session_last_login.isoformat() if _session_last_login else None,
        "mode": mode,
        "note": note,
        # Expose raw reason for debug scripts — redacted in production UI
        "login_error": _login_error_reason,
    }
