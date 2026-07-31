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
import pickle
import threading
import urllib.request
import urllib.error
import urllib.parse
import http.cookiejar
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple

logger = logging.getLogger(__name__)

# ── Cache ────────────────────────────────────────────────────────────────────
_fundamental_cache: Dict[str, Dict] = {}   # symbol → {data, fetched_at}
_company_id_cache: Dict[str, int] = {}     # symbol → numeric ID (permanent)
CACHE_TTL = timedelta(hours=6)

# ── Screener base URL ────────────────────────────────────────────────────────
SCREENER_BASE = "https://www.screener.in"

# ── Session cookie persistence ───────────────────────────────────────────────
# Stored next to the .env file: backend/screener_session.pkl
_SESSION_CACHE_FILE = Path(__file__).resolve().parents[3] / "screener_session.pkl"
SESSION_TTL = timedelta(hours=23)   # persisted session reused for up to 23 h

# ── Session state (Tier 2 auth) ──────────────────────────────────────────────
_session: Optional[http.cookiejar.CookieJar] = None
_session_valid: bool = False
_session_last_login: Optional[datetime] = None
_login_error_reason: Optional[str] = None   # human-readable last failure cause

# ── Login lock — prevents concurrent login attempts ───────────────────────────
_login_lock = threading.Lock()
_login_in_progress: bool = False

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
def _save_session() -> None:
    """Persist the current CookieJar + login timestamp to disk."""
    try:
        with open(_SESSION_CACHE_FILE, "wb") as f:
            pickle.dump({"cookies": _session, "login_time": _session_last_login}, f)
        logger.debug("Screener session saved to %s", _SESSION_CACHE_FILE)
    except Exception as e:
        logger.debug("Could not save session to disk: %s", e)


def _load_session() -> bool:
    """
    Try to restore a previously saved session from disk.
    Returns True if a valid, non-expired session was found.
    """
    global _session, _session_valid, _session_last_login, _login_error_reason

    if not _SESSION_CACHE_FILE.exists():
        return False
    try:
        with open(_SESSION_CACHE_FILE, "rb") as f:
            stored = pickle.load(f)

        cj: http.cookiejar.CookieJar = stored["cookies"]
        login_time: datetime = stored["login_time"]

        age = datetime.now() - login_time
        if age > SESSION_TTL:
            logger.info("Stored screener session expired (age=%s) — will re-login", age)
            _SESSION_CACHE_FILE.unlink(missing_ok=True)
            return False

        # Quick probe: fetch dash page with stored cookies to verify session
        opener = _build_opener(cj)
        probe_req = urllib.request.Request(
            f"{SCREENER_BASE}/dash/",
            headers={**_HEADERS_BASE, "Accept": "text/html,application/xhtml+xml"},
        )
        with opener.open(probe_req, timeout=15) as r:
            final_url = r.geturl()

        if "/login/" in final_url:
            logger.info("Stored session is no longer valid — will re-login")
            _SESSION_CACHE_FILE.unlink(missing_ok=True)
            return False

        _session = cj
        _session_valid = True
        _session_last_login = login_time
        _login_error_reason = None
        logger.info("Screener session restored from disk (age=%s)", age)
        return True

    except Exception as e:
        logger.debug("Could not restore session from disk: %s", e)
        return False


def _login() -> bool:
    """
    Perform a full screener.in login and store the session cookie in memory + disk.
    Returns True on success, and populates _login_error_reason on failure.

    Guards:
      • Uses _login_lock so only ONE login attempt runs at a time.
      • Tries to restore a persisted session from disk first (avoids 429).
      • Handles HTTP 429 (Too Many Requests) with a 65-second back-off + retry.

    Failure reasons:
      "network_blocked"   — OS/firewall blocks outbound TCP to screener.in
      "wrong_credentials" — login page returned, credentials rejected
      "csrf_not_found"    — login page HTML changed, CSRF token missing
      "rate_limited"      — screener.in returned 429 and retry also failed
      "network_timeout"   — connection timed out
      "network_error:<e>" — other socket/connection error
      "error:<e>"         — unexpected exception
    """
    global _session, _session_valid, _session_last_login, _login_error_reason, _login_in_progress

    email, password = _get_credentials()
    if not email or not password:
        logger.debug("Screener credentials not configured — running in public-only mode")
        return False

    with _login_lock:
        # Double-check: another thread may have logged in while we were waiting
        if _session_valid:
            return True

        _login_in_progress = True
        try:
            return _do_login(email, password)
        finally:
            _login_in_progress = False


def _do_login(email: str, password: str, _retry: bool = False) -> bool:
    """Internal: perform the actual HTTP login flow. Called inside _login_lock."""
    global _session, _session_valid, _session_last_login, _login_error_reason

    # ── Try restoring persisted session first (avoids a fresh login / 429) ─
    if not _retry and _load_session():
        return True

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
                "Screener login FAILED — credentials rejected for %s. "
                "Site says: '%s'. "
                "Verify email/password at https://www.screener.in/login/",
                email, site_error,
            )
            _login_error_reason = f"wrong_credentials: {site_error}" if site_error else "wrong_credentials"
            return False

        _session = cj
        _session_valid = True
        _session_last_login = datetime.now()
        _login_error_reason = None
        logger.info("Screener.in login successful for %s", email)
        _save_session()   # ← persist so next restart skips re-login
        return True

    except urllib.error.HTTPError as e:
        if e.code == 429:
            if not _retry:
                wait_s = 65   # screener.in rate-limit window is ~60 s
                logger.warning(
                    "Screener.in returned 429 Too Many Requests — "
                    "backing off %d seconds then retrying once...", wait_s
                )
                time.sleep(wait_s)
                return _do_login(email, password, _retry=True)
            else:
                logger.error(
                    "Screener.in still returning 429 after back-off — "
                    "too many login attempts. Wait a few minutes before restarting."
                )
                _login_error_reason = "rate_limited"
                return False
        logger.warning("Screener login HTTP error %d: %s", e.code, e)
        _login_error_reason = f"network_error: HTTP Error {e.code}"
        return False

    except OSError as e:
        err_str = str(e)
        if e.errno == 99 or "Cannot assign requested address" in err_str or "Connection refused" in err_str:
            logger.warning(
                "Screener login BLOCKED — network cannot reach screener.in. "
                "Run the backend locally where screener.in is reachable."
            )
            _login_error_reason = "network_blocked"
        elif "timed out" in err_str.lower() or "timeout" in err_str.lower():
            logger.warning(
                "Screener login TIMED OUT — screener.in did not respond within 20s. "
                "The app will retry on next request."
            )
            _login_error_reason = "network_timeout"
        else:
            logger.warning("Screener login network error: %s", e)
            _login_error_reason = f"network_error: {err_str}"
        return False

    except Exception as e:
        err_str = str(e)
        if "timed out" in err_str.lower() or "timeout" in err_str.lower():
            logger.warning("Screener login TIMED OUT (exception): %s", e)
            _login_error_reason = "network_timeout"
        else:
            logger.warning("Screener login error: %s", e)
            _login_error_reason = f"error: {e}"
        return False


def _get_session() -> Optional[urllib.request.OpenerDirector]:
    """
    Return an authenticated opener, logging in if needed.
    Returns None if credentials are not configured or login fails.
    Transient errors (timeout, rate_limited) are cleared so the next scan retries.
    """
    global _session, _session_valid, _session_last_login, _login_error_reason

    # Check if session needs renewal
    if _session_valid and _session_last_login:
        age = datetime.now() - _session_last_login
        if age > SESSION_TTL:
            logger.info("Screener session expired — re-logging in")
            _session_valid = False
            _SESSION_CACHE_FILE.unlink(missing_ok=True)

    # Transient errors: clear them so the next scan/run attempts login again
    if _login_error_reason in ("network_timeout", "rate_limited"):
        logger.info("Retrying screener.in login after previous '%s'...", _login_error_reason)
        _login_error_reason = None

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


def _strip_html_get_text(html_fragment: str) -> str:
    """
    Strip ALL HTML tags from a fragment and collapse whitespace.
    Used to cleanly extract text content from complex nested tag structures.
    """
    text = re.sub(r'<[^>]+>', ' ', html_fragment)
    return re.sub(r'\s+', ' ', text).strip()


def _fetch_quick_ratios_html(warehouse_id: str, opener: urllib.request.OpenerDirector, symbol: str) -> Optional[str]:
    """
    Fetch the quick-ratio <li> HTML fragment from the authenticated API.

    ROOT CAUSE (confirmed from JS source at company.customisation.js):
    ──────────────────────────────────────────────────────────────────
    Screener.in loads user-added custom ratios (Net Debt to Equity, Pledged %,
    5Yrs PE, 5Yrs PBV etc.) via a SEPARATE Ajax call AFTER the page loads:

        GET /api/company/{warehouseId}/quick_ratios/

    The warehouseId is different from the companyId and lives in:
        <div data-warehouse-id="150476773" data-company-id="3730" ...>

    This endpoint returns raw HTML <li> fragments which JS inserts into #top-ratios.
    This is why the initial HTML fetch only has 9 default <li> items — the quick-ratio
    items are never in the server-rendered HTML, they're injected client-side.

    This function replicates that Ajax call so we get the same data the browser sees.
    """
    if not warehouse_id:
        return None
    url = f"{SCREENER_BASE}/api/company/{warehouse_id}/quick_ratios/"
    try:
        req = urllib.request.Request(
            url,
            headers={
                **_HEADERS_BASE,
                "Accept": "text/html, */*",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": f"{SCREENER_BASE}/company/{urllib.parse.quote(symbol)}/consolidated/",
            }
        )
        with opener.open(req, timeout=15) as r:
            html_fragment = r.read().decode("utf-8")
        lis = re.findall(r'<li[^>]*>', html_fragment)
        logger.debug(
            "%s: quick_ratios API returned %d <li> items (warehouseId=%s)",
            symbol, len(lis), warehouse_id
        )
        return html_fragment
    except Exception as e:
        logger.debug("%s: quick_ratios API failed (warehouseId=%s): %s", symbol, warehouse_id, e)
        return None


def _extract_ratios(html: str, opener: Optional[urllib.request.OpenerDirector] = None, symbol: str = "") -> Dict[str, Any]:
    """
    Extract key ratios from the authenticated company page.

    FIX: Quick-ratios (Net Debt to Equity, Pledged %, 5Yrs PE, 5Yrs PBV) are
    NOT in the initial page HTML — they are loaded via a separate Ajax call to
    /api/company/{warehouseId}/quick_ratios/ by company.customisation.js.
    We replicate that call and merge the result into ratio_map.

    Returns: {current_pe, current_pb, roce, roe, net_debt_to_equity,
              pe_5yr_avg (from page), pb_5yr_avg (from page), pledged_pct}
    """
    ratios: Dict[str, Any] = {
        "current_pe": None, "current_pb": None,
        "roce": None, "roe": None,
        "net_debt_to_equity": None,
        "pe_5yr_avg": None,
        "pb_5yr_avg": None,
        "pledged_pct": None,
    }

    ratio_map: Dict[str, str] = {}   # cleaned_label -> raw numeric string

    def _parse_ratio_lis(source_html: str) -> None:
        """
        Parse <li> items from source_html into ratio_map.
        Handles both default and quick-ratio <li> structures —
        all use <span class="number"> for the value.
        """
        tag_re = re.compile(r'<(/?)span(?:\s[^>]*)?>',  re.IGNORECASE)

        for li in re.findall(r'<li[^>]*>(.*?)</li>', source_html, re.DOTALL):
            # ── Numeric value: always inside <span class="number"> ────────
            num_m = re.search(r'class=["\']number["\'][^>]*>([\d,.\-]+)<', li)
            if not num_m:
                continue
            raw_val = num_m.group(1).strip()

            # ── Label from <span class="name">…</span> ───────────────────
            name_open_m = re.search(
                r'<span[^>]*class=["\'][^"\']*name[^"\']*["\'][^>]*>', li
            )
            if not name_open_m:
                continue

            after_open = li[name_open_m.end():]

            # Walk to find matching closing </span>
            depth = 1
            content_end = len(after_open)
            for m in tag_re.finditer(after_open):
                if m.group(1) == '/':
                    depth -= 1
                    if depth == 0:
                        content_end = m.start()
                        break
                else:
                    depth += 1

            inner_html = after_open[:content_end]
            # Remove nested child spans entirely (e.g. <span class="sub">avg</span>)
            label_html = re.sub(r'<span[^>]*>.*?</span>', '', inner_html, flags=re.DOTALL)
            label = _strip_html_get_text(label_html)
            if label:
                ratio_map[label] = raw_val
                logger.debug("  ratio_map[%r] = %r", label, raw_val)

    # ── Step 1: Parse default ratios from #top-ratios in the page HTML ───
    top_ratios_m = re.search(
        r'<ul[^>]*id=["\']top-ratios["\'][^>]*>(.*?)</ul>',
        html, re.DOTALL
    )
    if top_ratios_m:
        _parse_ratio_lis(top_ratios_m.group(1))
        logger.info("Default ratios from #top-ratios — keys: %s", list(ratio_map.keys()))
    else:
        _parse_ratio_lis(html)
        logger.info("Default ratios from full page (no #top-ratios) — keys: %s", list(ratio_map.keys()))

    # ── Step 2: Fetch quick-ratios via the dedicated Ajax API ─────────────
    # Extract warehouseId from the page HTML
    wh_m = re.search(r'data-warehouse-id=["\'](\d+)["\']', html)
    warehouse_id = wh_m.group(1) if wh_m else None

    if opener and warehouse_id:
        quick_html = _fetch_quick_ratios_html(warehouse_id, opener, symbol)
        if quick_html:
            _parse_ratio_lis(quick_html)
            logger.info(
                "Quick-ratios merged — all keys now: %s", list(ratio_map.keys())
            )
    else:
        logger.warning(
            "%s: Cannot fetch quick-ratios — opener=%s, warehouseId=%s",
            symbol, bool(opener), warehouse_id
        )

    logger.info("Full ratio_map: %s", dict(ratio_map))

    # ── Lookup helpers ─────────────────────────────────────────────────────
    def _get(key: str) -> Optional[float]:
        val = ratio_map.get(key)
        return _parse_number(val) if val is not None else None

    def _get_fuzzy(candidates: List[str]) -> Optional[float]:
        """
        Try each candidate label exactly, then case-insensitively,
        then as a substring of any key in ratio_map.
        """
        # 1. Exact match
        for key in candidates:
            v = _get(key)
            if v is not None:
                return v
        # 2. Case-insensitive exact match
        lc_map = {k.lower(): v for k, v in ratio_map.items()}
        for key in candidates:
            v = lc_map.get(key.lower())
            if v is not None:
                return _parse_number(v)
        # 3. Substring: any ratio_map key that STARTS WITH the candidate
        for key in candidates:
            kl = key.lower()
            for rk, rv in ratio_map.items():
                if rk.lower().startswith(kl):
                    parsed = _parse_number(rv)
                    if parsed is not None:
                        logger.debug("Fuzzy match: %r → %r = %s", key, rk, parsed)
                        return parsed
        return None

    # ── Map to structured output ───────────────────────────────────────────
    ratios["current_pe"]         = _get_fuzzy(["Stock P/E", "P/E", "PE"])
    ratios["roce"]               = _get_fuzzy(["ROCE"])
    ratios["roe"]                = _get_fuzzy(["ROE"])
    ratios["net_debt_to_equity"] = _get_fuzzy([
        "Net Debt to Equity", "Net Debt / Equity",
        "Debt to Equity", "Net Debt/Equity",
    ])

    # Pledging — user-added quick ratio; label shown as "Pledged percentage"
    # Pulled here so _extract_shareholding can use it as a fallback
    ratios["pledged_pct"] = _get_fuzzy([
        "Pledged percentage", "Pledging %", "Pledged %",
        "Promoter Pledging", "% Pledged",
    ])

    # 5-year historical averages — user-added quick ratios
    # Label shown in DevTools: "5Yrs PE" and "5Yrs PBV"
    ratios["pe_5yr_avg"] = _get_fuzzy(["5Yrs PE", "5 Yr PE", "5Yrs P/E", "5 Yr P/E", "5Yr PE"])
    ratios["pb_5yr_avg"] = _get_fuzzy([
        "5Yrs PBV", "5 Yr PBV", "5Yrs P/BV", "5Yrs P/B",
        "5 Yr PBV", "5 Yr P/B", "5Yr PBV",
    ])

    # Current PB = Current Price / Book Value
    price = _get_fuzzy(["Current Price"])
    book  = _get_fuzzy(["Book Value"])
    if price and book and book > 0:
        ratios["current_pb"] = round(price / book, 2)

    logger.debug(
        "Extracted ratios — PE=%s, ROCE=%s, ROE=%s, NDE=%s, 5yrPE=%s, 5yrPBV=%s, PB=%s",
        ratios["current_pe"], ratios["roce"], ratios["roe"],
        ratios["net_debt_to_equity"], ratios["pe_5yr_avg"],
        ratios["pb_5yr_avg"], ratios["current_pb"],
    )

    return ratios


def _extract_pledging_from_analysis(html: str) -> Optional[float]:
    """
    Extract promoter pledging % from the #analysis section's cons list.

    ROOT CAUSE (confirmed from live HTML inspection):
    ─────────────────────────────────────────────────
    Screener.in does NOT render pledging inside the #shareholding table.
    The pledging percentage is only visible in TWO places in the page HTML:

      1. <meta name="description"> in <head>:
           "Promoters have pledged 89.4% of their holding."

      2. The #analysis section <div class="cons"> bullet list:
           <li>Promoters have pledged 89.4% of their holding.</li>

    Neither of these is inside the #shareholding <section>.
    All previous strategies (table parser, raw <tr> scan, regex on section_html)
    were all looking in the wrong place — the shareholding section simply
    does not contain the pledging number.

    This function searches BOTH correct locations and returns the value.
    Returns None only if no pledging sentence is found anywhere (0% pledging
    stocks do not emit this sentence at all — so None = 0% OR data missing).
    """
    # Strategy A: search the analysis section cons list
    analysis_m = re.search(
        r'<section[^>]*id="analysis"[^>]*>(.*?)</section>',
        html, re.DOTALL
    )
    if analysis_m:
        pledge_m = re.search(
            r'pledged\s+([\d]+(?:\.\d+)?)\s*%',
            analysis_m.group(1), re.IGNORECASE
        )
        if pledge_m:
            val = _parse_number(pledge_m.group(1))
            if val is not None:
                logger.debug("Pledging from #analysis cons: %.2f%%", val)
                return val

    # Strategy B: search the <meta name="description"> in <head>
    # Only search the first 5000 chars (where <head> lives)
    meta_m = re.search(
        r'pledged\s+([\d]+(?:\.\d+)?)\s*%',
        html[:5000], re.IGNORECASE
    )
    if meta_m:
        val = _parse_number(meta_m.group(1))
        if val is not None:
            logger.debug("Pledging from meta description: %.2f%%", val)
            return val

    # Not found → pledging is likely 0% (screener only mentions it when > 0)
    # Return None to distinguish "found=0" from "not found" for safety
    return None


def _extract_shareholding(html: str, ratios_pledged_pct: Optional[float] = None) -> Dict[str, Any]:
    """
    Extract promoter holding % and pledging % from the page.

    Promoter holding → #shareholding table (Promoters row, latest quarter).
    Pledging %       → Priority order:
                         1. #top-ratios "Pledged percentage" quick-ratio (most reliable)
                         2. #analysis cons list sentence
                         3. <meta name="description"> in <head>
    """
    result = {"promoter_holding_pct": None, "promoter_pledging_pct": None}

    # ── Pledging: Priority 1 — already extracted from #top-ratios ────────
    if ratios_pledged_pct is not None:
        result["promoter_pledging_pct"] = ratios_pledged_pct
        logger.debug("Pledging from #top-ratios quick-ratio: %.2f%%", ratios_pledged_pct)
    else:
        # Priority 2 & 3: analysis section / meta description
        result["promoter_pledging_pct"] = _extract_pledging_from_analysis(html)

    # ── Promoter holding: from shareholding table ─────────────────────────
    sh_m = re.search(  # noqa: E501
        r'<section[^>]*id="shareholding"[^>]*>(.*?)</section>',
        html, re.DOTALL
    )
    if sh_m:
        section_html = sh_m.group(0)
        # Scan all <tr> rows; find the "Promoters" row
        for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', section_html, re.DOTALL):
            cells = re.findall(r'<td[^>]*>(.*?)</td>', tr, re.DOTALL)
            if not cells:
                continue
            label = _strip_html_get_text(cells[0]).lower().replace("\xa0", " ").strip()
            if "promoter" in label and "pledge" not in label and "no." not in label:
                # Values like "26.76%" — strip % and parse
                values = []
                for c in cells[1:]:
                    raw = _strip_html_get_text(c).replace("%", "").strip()
                    v = _parse_number(raw)
                    if v is not None:
                        values.append(v)
                if values:
                    result["promoter_holding_pct"] = values[-1]  # most recent quarter
                    logger.debug("Promoter holding: %.2f%%", values[-1])
                    break

    # ── Logging ──────────────────────────────────────────────────────────
    if result["promoter_pledging_pct"] is not None:
        logger.info("Pledging extracted: %.2f%%", result["promoter_pledging_pct"])
    else:
        logger.warning("Pledging could not be extracted from shareholding section")

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
        # NOTE: current_pe / current_pb start as None here.
        # They are filled from the PAGE (TTM-based) first, then fall back
        # to chart API only if the page value is unavailable.
        # This ensures current PE/PB and their 5yr averages always come from
        # the SAME source (screener's TTM calculation), making comparisons valid.
        "current_pe": None,
        "current_pb": None,
        "roce": None,
        "roe": None,
    }
    shareholding: Dict = {"promoter_holding_pct": None, "promoter_pledging_pct": None}
    auth_available = False

    opener = _get_session()
    active_opener = None   # track the opener that successfully fetched the page
    if opener:
        html = _fetch_company_page(symbol, opener)
        if html is None:
            # Session may have expired — try one re-login
            global _session_valid
            _session_valid = False
            opener2 = _get_session()
            if opener2:
                html = _fetch_company_page(symbol, opener2)
                active_opener = opener2
        else:
            active_opener = opener

        if html:
            quarterly = _extract_quarterly_results(html)
            page_ratios = _extract_ratios(html, opener=active_opener, symbol=symbol)
            shareholding = _extract_shareholding(html, ratios_pledged_pct=page_ratios.get("pledged_pct"))
            auth_available = True

            # ── PE / PB: PAGE values take absolute priority ───────────────
            # The screener page shows TTM (Trailing Twelve Month) PE/PB.
            # The 5yr historical averages (quick-ratios) are also TTM-based.
            # Mixing the chart API's PE (uses closing price / adjusted EPS) with
            # the page's 5yr TTM average causes wrong PASS/FAIL results.
            # We MUST use the same source for both current and historical values.
            ratios["current_pe"] = page_ratios.get("current_pe")
            ratios["current_pb"] = page_ratios.get("current_pb")

            # Fall back to chart API only if the page failed to provide values
            if ratios["current_pe"] is None:
                ratios["current_pe"] = valuation.get("current_pe")
                logger.debug("%s: current_pe not on page — falling back to chart API", symbol)
            if ratios["current_pb"] is None:
                ratios["current_pb"] = valuation.get("current_pb")
                logger.debug("%s: current_pb not on page — falling back to chart API", symbol)

            # ── Other ratios from page ────────────────────────────────────
            ratios["roce"]               = page_ratios.get("roce")
            ratios["roe"]                = page_ratios.get("roe")
            ratios["net_debt_to_equity"] = page_ratios.get("net_debt_to_equity")

            # Inject page-sourced 5yr averages into ratios for direct access
            ratios["pe_5yr_avg_page"]    = page_ratios.get("pe_5yr_avg")
            ratios["pb_5yr_avg_page"]    = page_ratios.get("pb_5yr_avg")

            # ── Sync valuation dict so eval_pe_below_avg / eval_pb_below_avg
            # always compare apples-to-apples (both values TTM-sourced from page).
            # If the page quick-ratio is available, it wins over chart-computed avg.
            if page_ratios.get("pe_5yr_avg") is not None:
                valuation["pe_avg_5yr"] = page_ratios["pe_5yr_avg"]
            if page_ratios.get("pb_5yr_avg") is not None:
                valuation["pb_avg_5yr"] = page_ratios["pb_5yr_avg"]

            # Also sync current values in valuation so the chart series is
            # still available for fallback and display purposes.
            valuation["current_pe_page"] = ratios["current_pe"]
            valuation["current_pb_page"] = ratios["current_pb"]

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
        f"5yrPE(page)={ratios.get('pe_5yr_avg_page')}, "
        f"5yrPBV(page)={ratios.get('pb_5yr_avg_page')}, "
        f"ROCE={ratios.get('roce')}, "
        f"ROE={ratios.get('roe')}, "
        f"NetDebt/Eq={ratios.get('net_debt_to_equity')}, "
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
    Read-only — does NOT attempt login. Login is driven by:
      • trigger_background_login() at app startup (main.py)
      • _get_session() when Run Screener is clicked
    """
    email, _ = _get_credentials()

    err = str(_login_error_reason) if _login_error_reason else ""

    network_blocked   = err == "network_blocked"
    network_timeout   = err == "network_timeout"
    # rate_limited covers both the clean "rate_limited" flag AND
    # the raw "network_error: HTTP Error 429" string that falls through
    rate_limited      = err == "rate_limited" or "429" in err
    wrong_credentials = err.startswith("wrong_credentials")

    if _session_valid:
        mode = "full"
        note = "Authenticated — all data available."
    elif not email:
        mode = "public_only"
        note = "Set SCREENER_EMAIL and SCREENER_PASSWORD to enable full data."
    elif _login_in_progress:
        mode = "login_pending"
        note = "Login in progress... Refresh in a few seconds."
    elif _login_error_reason is None and not _session_valid:
        # Credentials configured but login hasn't been attempted yet
        mode = "login_pending"
        note = "Login in progress... Refresh in a few seconds."
    elif network_blocked:
        mode = "network_blocked"
        note = (
            "Credentials are correct, but this server's network blocks screener.in. "
            "Run the backend on your local machine where screener.in is accessible."
        )
    elif network_timeout:
        mode = "network_timeout"
        note = (
            "screener.in did not respond in time (timed out). "
            "This is usually temporary — click Run Screener to retry."
        )
    elif rate_limited:
        mode = "rate_limited"
        note = (
            "Screener.in returned HTTP 429 — too many login attempts. "
            "Wait 2–3 minutes, then click Run Screener to retry automatically."
        )
    elif wrong_credentials:
        site_msg = err.replace("wrong_credentials:", "").strip()
        mode = "wrong_credentials"
        note = (
            f"Login rejected by screener.in — {site_msg}. "
            "Verify your email and password at https://www.screener.in/login/"
        )
    else:
        mode = "login_error"
        note = (
            f"Login failed with an unexpected error: {err}. "
            "Check backend logs for details."
        )

    return {
        "authenticated": _session_valid,
        "email_configured": bool(email),
        "network_blocked": network_blocked,
        "network_timeout": network_timeout,
        "rate_limited": rate_limited,
        "wrong_credentials": wrong_credentials,
        "last_login": _session_last_login.isoformat() if _session_last_login else None,
        "mode": mode,
        "note": note,
        "login_error": _login_error_reason,
    }
