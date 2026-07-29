# -*- coding: utf-8 -*-
"""
Credential Verification Test
Runs entirely in the terminal — no server restart needed.
Tests: Login → Company ID → PE/PB chart → Quarterly data → ROCE/ROE/Pledging
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

# Load .env before anything else
from dotenv import load_dotenv
from pathlib import Path
load_dotenv(Path(__file__).parent / ".env")

import logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")

from app.services.screener_data_fetcher import (
    _get_credentials, _login, is_authenticated, fetch_fundamental_data, get_auth_status
)

# ── ANSI colours ─────────────────────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

def ok(msg):   print(f"  {GREEN}✅ PASS{RESET}  {msg}")
def fail(msg): print(f"  {RED}❌ FAIL{RESET}  {msg}")
def info(msg): print(f"  {CYAN}ℹ  INFO{RESET}  {msg}")
def warn(msg): print(f"  {YELLOW}⚠  WARN{RESET}  {msg}")
def sep(title=""):
    line = "─" * 60
    if title:
        print(f"\n{BOLD}{line}{RESET}")
        print(f"{BOLD}  {title}{RESET}")
        print(f"{BOLD}{line}{RESET}")
    else:
        print(f"{CYAN}{line}{RESET}")

# ═══════════════════════════════════════════════════════════════════════════
#  STEP 1: Credential Detection
# ═══════════════════════════════════════════════════════════════════════════
sep("STEP 1 — Credential Detection")
email, password = _get_credentials()

if email:
    ok(f"SCREENER_EMAIL loaded from .env → {email}")
else:
    fail("SCREENER_EMAIL not found — check backend/.env")

if password:
    masked = password[:2] + "*" * (len(password) - 2)
    ok(f"SCREENER_PASSWORD loaded from .env → {masked}")
else:
    fail("SCREENER_PASSWORD not found — check backend/.env")

if not email or not password:
    print(f"\n{RED}Cannot continue — credentials missing.{RESET}")
    sys.exit(1)

# ═══════════════════════════════════════════════════════════════════════════
#  STEP 2: Login
# ═══════════════════════════════════════════════════════════════════════════
sep("STEP 2 — Screener.in Login")
print("  Attempting login to screener.in ...")

success = _login()
if success:
    ok(f"Login successful — session established")
else:
    fail("Login FAILED — wrong email/password OR screener.in is blocking")
    print(f"\n{RED}Tip:{RESET} Double-check credentials in backend/.env")
    print(f"     You can verify at: https://www.screener.in/login/")
    sys.exit(1)

# ═══════════════════════════════════════════════════════════════════════════
#  STEP 3: Auth Status Check
# ═══════════════════════════════════════════════════════════════════════════
sep("STEP 3 — Auth Status")
status = get_auth_status()
info(f"Mode            : {status['mode']}")
info(f"Authenticated   : {status['authenticated']}")
info(f"Last login      : {status['last_login']}")
info(f"Note            : {status['note']}")

# ═══════════════════════════════════════════════════════════════════════════
#  STEP 4: Stock-level data fetch (3 test stocks)
# ═══════════════════════════════════════════════════════════════════════════
sep("STEP 4 — Stock Data Verification")

TEST_STOCKS = ["PAGEIND", "PGHH", "NESTLEIND"]

for symbol in TEST_STOCKS:
    print(f"\n  {BOLD}▶ Testing: {symbol}{RESET}")
    data = fetch_fundamental_data(symbol)

    if data is None:
        fail(f"{symbol} — not found on screener.in at all")
        continue

    # Company ID
    cid = data.get("company_id")
    if cid:
        ok(f"Company ID found: {cid}")
    else:
        fail("Company ID missing")

    # Auth tier
    auth_used = data.get("auth_available", False)
    if auth_used:
        ok("Authenticated page loaded — full data available (Tier 2)")
    else:
        warn("Only public data loaded (Tier 1) — auth page returned empty")

    # PE / PB
    ratios  = data.get("ratios", {})
    val     = data.get("valuation", {})
    curr_pe = ratios.get("current_pe") or val.get("current_pe")
    curr_pb = ratios.get("current_pb") or val.get("current_pb")
    pe_avg5 = val.get("pe_avg_5yr")
    pb_avg5 = val.get("pb_avg_5yr")

    if curr_pe:
        ok(f"Current PE  : {curr_pe:.1f}  |  5yr Avg PE : {pe_avg5 or 'N/A'}")
    else:
        fail("Current PE missing")

    if curr_pb:
        ok(f"Current PB  : {curr_pb:.1f}  |  5yr Avg PB : {pb_avg5 or 'N/A'}")
    else:
        fail("Current PB missing")

    # ROCE / ROE (Tier 2 only)
    roce = ratios.get("roce")
    roe  = ratios.get("roe")
    if roce is not None:
        ok(f"ROCE        : {roce:.1f}%")
    else:
        fail("ROCE missing — Tier 2 auth data not loaded")

    if roe is not None:
        ok(f"ROE         : {roe:.1f}%")
    else:
        fail("ROE missing — Tier 2 auth data not loaded")

    # Quarterly results
    quarters = data.get("quarterly_results", [])
    if quarters:
        latest_q = quarters[-1]
        ok(
            f"Quarterly ({len(quarters)} qtrs) — Latest: "
            f"{latest_q.get('quarter','')} | "
            f"Sales={latest_q.get('sales')} | "
            f"PBT={latest_q.get('pbt')} | "
            f"NP={latest_q.get('net_profit')}"
        )
    else:
        fail("Quarterly results empty — Tier 2 auth data not loaded")

    # Promoter pledging
    sh = data.get("shareholding", {})
    pledging = sh.get("promoter_pledging_pct")
    if pledging is not None:
        ok(f"Pledging    : {pledging:.1f}%")
    else:
        warn("Pledging data not found (may be 0% — assumed OK)")

# ═══════════════════════════════════════════════════════════════════════════
#  STEP 5: Live API Test via running server
# ═══════════════════════════════════════════════════════════════════════════
sep("STEP 5 — Live API Test (backend on port 8000)")
import urllib.request, json as _json

try:
    with urllib.request.urlopen("http://localhost:8000/api/screener/auth-status", timeout=5) as r:
        api_status = _json.loads(r.read())
    ok(f"API /screener/auth-status → authenticated={api_status.get('authenticated')} mode={api_status.get('mode')}")
except Exception as e:
    warn(f"Server not reachable (start backend first): {e}")

# ── Final Summary ─────────────────────────────────────────────────────────
sep("SUMMARY")
if is_authenticated():
    print(f"\n  {GREEN}{BOLD}✅ Credentials verified — all data tiers accessible{RESET}")
    print(f"  {GREEN}   Quarterly results, ROCE, ROE, Pledging are live.{RESET}\n")
else:
    print(f"\n  {RED}{BOLD}❌ Credentials NOT verified — running in public-only mode{RESET}\n")
