"""
Screener.in authenticated client — the Tier-B (quarterly) data source.

Port of the login/fetch layer proven in the legacy Buddy screener fetcher
(removed 2026-09-16; see git history), on `requests`:

  1. GET  /login/                       -> csrfmiddlewaretoken
  2. POST /login/ (credentials + CSRF)  -> sessionid cookie (one login/run)
  3. GET  /company/{SYM}/consolidated/  -> full page (fallback: standalone)
  4. GET  /api/company/{warehouseId}/quick_ratios/  -> custom ratios fragment
     (Net Debt to Equity, Pledged percentage, 5Yrs PE, 5Yrs PBV — injected
     client-side in the browser, so a plain page fetch never contains them)
  5. Fallback GET /api/company/{id}/chart/ (PUBLIC) -> 5y PE/PBV averages
     when the account has no 5Yrs quick-ratios configured.

Credentials come from SCREENER_EMAIL / SCREENER_PASSWORD env vars — same
names as legacy Buddy and the runbook §4.6. Without credentials the page
numbers are EMPTY (screener renders data for logged-in users only), so the
client refuses to run unauthenticated instead of writing NULL rows.

Rate-limit etiquette: ONE login per process; HTTP 429 on login -> 65 s
back-off + one retry (legacy behaviour). Per-symbol pacing (the 15 s
cooldown) is the WORKER's job, not this module's.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from plutus.fundamentals import screener_page as sp
from plutus.registry.types import to_decimal

logger = logging.getLogger(__name__)

SCREENER_BASE = "https://www.screener.in"
_TIMEOUT_S = 25

_HEADERS_BASE = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


class ScreenerAuthError(RuntimeError):
    """Login impossible — missing/rejected credentials, or rate-limited."""


def get_credentials() -> Tuple[Optional[str], Optional[str]]:
    # Ensure plutus/.env has been loaded — a CLI may reach login() before
    # anything called get_settings() (which is what loads dotenv).
    try:
        from plutus.config import _load_dotenv_files
        _load_dotenv_files()
    except Exception:  # noqa: BLE001 — env vars may already be exported
        pass
    email = os.environ.get("SCREENER_EMAIL", "").strip()
    password = os.environ.get("SCREENER_PASSWORD", "").strip()
    return (email or None, password or None)


class ScreenerClient:
    """One authenticated session per sync run. Never raises from fetches —
    only ``login()`` raises (ScreenerAuthError) so the worker can abort the
    whole run early instead of writing 400+ empty rows."""

    def __init__(self, session: Any = None) -> None:
        if session is None:
            import requests  # noqa: WPS433 — lazy, tests inject a fake
            session = requests.Session()
        self._s = session
        self._s.headers.update(_HEADERS_BASE)
        self._logged_in = False
        self._company_ids: Dict[str, int] = {}

    # ---- Auth --------------------------------------------------------------
    def login(self, *, _retry: bool = False) -> None:
        if self._logged_in:
            return
        email, password = get_credentials()
        if not email or not password:
            raise ScreenerAuthError(
                "SCREENER_EMAIL / SCREENER_PASSWORD not configured — "
                "screener.in renders data only for logged-in users.")

        r = self._s.get(f"{SCREENER_BASE}/login/", timeout=_TIMEOUT_S)
        csrf_m = re.search(
            r'name=["\']csrfmiddlewaretoken["\']\s+value=["\']([^"\']+)["\']',
            r.text)
        if not csrf_m:
            raise ScreenerAuthError("CSRF token not found on login page")

        resp = self._s.post(
            f"{SCREENER_BASE}/login/",
            data={
                "csrfmiddlewaretoken": csrf_m.group(1),
                "username": email,
                "password": password,
                "next": "",
            },
            headers={
                "Referer": f"{SCREENER_BASE}/login/",
                "X-CSRFToken": csrf_m.group(1),
            },
            timeout=_TIMEOUT_S,
        )
        if resp.status_code == 429:
            if _retry:
                raise ScreenerAuthError("rate-limited (429) after back-off")
            logger.warning("screener login 429 — backing off 65s and retrying once")
            time.sleep(65)
            return self.login(_retry=True)
        if "/login/" in str(resp.url):
            err_m = re.search(r'class="errorlist".*?<li>(.*?)</li>',
                              resp.text, re.DOTALL)
            site = sp.strip_html(err_m.group(1)) if err_m else ""
            raise ScreenerAuthError(f"credentials rejected: {site or 'unknown'}")

        self._logged_in = True
        logger.info("screener.in login OK for %s", email)

    # ---- Company page -------------------------------------------------------
    @staticmethod
    def _code(symbol: str) -> str:
        return symbol.split(".")[0].strip().upper()

    def fetch_company_html(self, symbol: str) -> Optional[str]:
        """Authenticated page HTML with populated numbers, or None.

        Tries /consolidated/ first, then standalone. A page is PREFERRED
        when its #quarters table has data; a page with populated top
        ratios but NO quarters (companies without consolidated statements:
        banks such as AUBANK, subsidiaries such as COLPAL / PFIZER) is kept
        only as a fallback. Before 2026-09-12 the consolidated page won as
        soon as any number was present, so 12 such stocks failed every
        quarterly run with "no quarterly rows extracted" and their weekly
        PE/PB came from the empty consolidated statements."""
        code = self._code(symbol)
        fallback_html: Optional[str] = None
        for path in (f"/company/{code}/consolidated/", f"/company/{code}/"):
            try:
                r = self._s.get(f"{SCREENER_BASE}{path}", timeout=_TIMEOUT_S)
            except Exception as exc:  # noqa: BLE001
                logger.warning("%s: fetch %s failed: %s", symbol, path, exc)
                continue
            if r.status_code == 404:
                continue
            if "/login/" in str(r.url):
                # Session evaporated mid-run — one re-login attempt.
                logger.info("%s: session expired — re-logging in", symbol)
                self._logged_in = False
                self.login()
                return self.fetch_company_html(symbol)
            if r.status_code != 200:
                continue
            numbers = re.findall(r'<span class="number">([^<]+)</span>', r.text)
            if not any(n.strip() for n in numbers):
                logger.warning("%s: page loaded but numbers EMPTY on %s "
                               "(not authenticated?)", symbol, path)
                continue
            if sp.extract_quarterly_results(r.text):
                return r.text
            logger.warning("%s: numbers present but NO quarterly results on "
                           "%s — trying the other statement view", symbol, path)
            if fallback_html is None:
                fallback_html = r.text
        return fallback_html

    def fetch_quick_ratios_html(self, warehouse_id: str, symbol: str) -> Optional[str]:
        """The Ajax fragment carrying the account's custom ratios."""
        if not warehouse_id:
            return None
        try:
            r = self._s.get(
                f"{SCREENER_BASE}/api/company/{warehouse_id}/quick_ratios/",
                headers={
                    "Accept": "text/html, */*",
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": f"{SCREENER_BASE}/company/{self._code(symbol)}/consolidated/",
                },
                timeout=_TIMEOUT_S,
            )
            if r.status_code == 200:
                return r.text
        except Exception as exc:  # noqa: BLE001
            logger.warning("%s: quick_ratios failed: %s", symbol, exc)
        return None

    # ---- Public chart API (5y avg fallback) ---------------------------------
    def _company_id(self, symbol: str) -> Optional[int]:
        code = self._code(symbol)
        if code in self._company_ids:
            return self._company_ids[code]
        try:
            r = self._s.get(
                f"{SCREENER_BASE}/api/company/search/?q={code}",
                headers={"Accept": "application/json",
                         "X-Requested-With": "XMLHttpRequest"},
                timeout=_TIMEOUT_S,
            )
            for item in r.json():
                url_sym = str(item.get("url", "")).strip("/").split("/")[-1].upper()
                if url_sym == code:
                    self._company_ids[code] = int(item["id"])
                    return self._company_ids[code]
        except Exception as exc:  # noqa: BLE001
            logger.debug("%s: company id lookup failed: %s", symbol, exc)
        return None

    def _chart_avg(self, company_id: int, metric: str, years: int = 5) -> Optional[Decimal]:
        try:
            r = self._s.get(
                f"{SCREENER_BASE}/api/company/{company_id}/chart/",
                params={"q": metric, "days": 3650},
                headers={"Accept": "application/json",
                         "X-Requested-With": "XMLHttpRequest"},
                timeout=_TIMEOUT_S,
            )
            datasets = r.json().get("datasets", [])
            if not datasets:
                return None
            cutoff = (datetime.now() - timedelta(days=years * 365)).strftime("%Y-%m-%d")
            values: List[Decimal] = []
            for row in datasets[0].get("values", []):
                if row[1] is None or str(row[0]) < cutoff:
                    continue
                d = to_decimal(str(row[1]))
                if d is not None and d > 0:
                    values.append(d)
            if not values:
                return None
            return (sum(values, Decimal(0)) / Decimal(len(values))).quantize(
                Decimal("0.01"))
        except Exception as exc:  # noqa: BLE001
            logger.debug("chart avg failed id=%s metric=%s: %s",
                         company_id, metric, exc)
            return None

    # ---- Weekly ratios (PE / PB / Market Cap) --------------------------------
    def fetch_ratios_only(self, symbol: str) -> Dict[str, Any]:
        """Lightweight fetch for the WEEKLY ratios sync: the company page's
        #top-ratios only (Stock P/E, Market Cap, Current Price, Book Value
        -> PB). No quick-ratios Ajax, no chart API — one GET per symbol.

        Raises RuntimeError when the page is unavailable (per-symbol failure
        the worker isolates)."""
        self.login()
        html = self.fetch_company_html(symbol)
        if html is None:
            raise RuntimeError("company page unavailable / not populated")
        return sp.extract_ratios(html, None)

    # ---- Bundle -------------------------------------------------------------
    def fetch_bundle(self, symbol: str) -> Dict[str, Any]:
        """Everything the quarterly worker needs for one symbol.

        Returns {quarterly, ratios, shareholding} — parsed, Decimal-typed.
        Raises RuntimeError when the page is unavailable (per-symbol failure
        the worker isolates); raises ScreenerAuthError only from login().
        """
        self.login()
        html = self.fetch_company_html(symbol)
        if html is None:
            raise RuntimeError("company page unavailable / not populated")

        quick_html = self.fetch_quick_ratios_html(
            sp.extract_warehouse_id(html) or "", symbol)
        ratios = sp.extract_ratios(html, quick_html)
        shareholding = sp.extract_shareholding(html)
        quarterly = sp.extract_quarterly_results(html)

        # Pledging priority: quick-ratio -> analysis/meta sentence.
        if ratios.get("pledged_pct") is None:
            ratios["pledged_pct"] = sp.extract_pledging_fallback(html)

        # 5y averages: quick-ratios win; public chart API fills the gap.
        if ratios.get("pe_5yr_avg") is None or ratios.get("pb_5yr_avg") is None:
            cid = self._company_id(symbol)
            if cid is not None:
                if ratios.get("pe_5yr_avg") is None:
                    ratios["pe_5yr_avg"] = self._chart_avg(cid, "Price to Earning")
                if ratios.get("pb_5yr_avg") is None:
                    ratios["pb_5yr_avg"] = self._chart_avg(cid, "Price to book value")

        return {
            "symbol": symbol,
            "quarterly": quarterly,
            "ratios": ratios,
            "shareholding": shareholding,
        }


def _json_safe_raw_map(ratios: Dict[str, Any]) -> Dict[str, str]:
    raw = ratios.get("_raw_map") or {}
    return {str(k): str(v) for k, v in raw.items()}
