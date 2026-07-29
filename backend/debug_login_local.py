#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════╗
║  debug_login_local.py — Run this ON YOUR LOCAL MACHINE          ║
║  It diagnoses exactly where screener.in login is failing.       ║
║                                                                  ║
║  Usage:  python3 debug_login_local.py                           ║
╚══════════════════════════════════════════════════════════════════╝
"""
import os, sys, re, json
import urllib.request, urllib.parse, urllib.error
import http.cookiejar

# ── Load .env from same folder ───────────────────────────────────────────────
def load_env():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        print(f"❌  .env not found at: {env_path}")
        print("    Create it from .env.example and fill in credentials.")
        sys.exit(1)
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

load_env()

EMAIL    = os.environ.get("SCREENER_EMAIL", "").strip()
PASSWORD = os.environ.get("SCREENER_PASSWORD", "").strip()
BASE     = "https://www.screener.in"
HEADERS  = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

G, R, Y, C, B, X = "\033[92m", "\033[91m", "\033[93m", "\033[96m", "\033[1m", "\033[0m"
def ok(m):   print(f"  {G}✅ PASS{X}  {m}")
def fail(m): print(f"  {R}❌ FAIL{X}  {m}")
def info(m): print(f"  {C}ℹ  INFO{X}  {m}")
def warn(m): print(f"  {Y}⚠  WARN{X}  {m}")
def sep(t):  print(f"\n{B}{'─'*60}\n  {t}\n{'─'*60}{X}")

# ────────────────────────────────────────────────────────────────────────────
sep("STEP 1 — Credentials in .env")
if EMAIL:
    ok(f"SCREENER_EMAIL    = {EMAIL}")
else:
    fail("SCREENER_EMAIL is empty!")
if PASSWORD:
    ok(f"SCREENER_PASSWORD = {PASSWORD[:3]}{'*' * (len(PASSWORD)-3)}")
else:
    fail("SCREENER_PASSWORD is empty!")
if not EMAIL or not PASSWORD:
    sys.exit(1)

# ────────────────────────────────────────────────────────────────────────────
sep("STEP 2 — Network reachability")
for label, url in [("google.com", "https://www.google.com"),
                   ("screener.in", "https://www.screener.in")]:
    try:
        urllib.request.urlopen(url, timeout=8)
        ok(f"{label} is reachable")
    except Exception as e:
        fail(f"{label} BLOCKED — {e}")
        if "screener" in url:
            print(f"\n  {R}Cannot reach screener.in from this machine.{X}")
            print(f"  Try: ping screener.in  or  curl -I https://www.screener.in")
            sys.exit(1)

# ────────────────────────────────────────────────────────────────────────────
sep("STEP 3 — GET login page + CSRF token")
cj     = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

try:
    req = urllib.request.Request(
        f"{BASE}/login/",
        headers={**HEADERS, "Accept": "text/html,application/xhtml+xml"},
    )
    with opener.open(req, timeout=20) as r:
        html  = r.read().decode("utf-8")
        final = r.geturl()
    info(f"Login page URL  : {final}")
    info(f"Page size       : {len(html):,} bytes")
except Exception as e:
    fail(f"Could not load login page: {e}")
    sys.exit(1)

# Extract CSRF
csrf_m = re.search(
    r'name=["\']csrfmiddlewaretoken["\']\s+value=["\']([^"\']+)["\']', html
)
if csrf_m:
    csrf = csrf_m.group(1)
    ok(f"CSRF token      : {csrf[:24]}…")
else:
    fail("csrfmiddlewaretoken NOT found in login page HTML.")
    # Show page snippet for diagnosis
    idx = html.find("csrf")
    snippet = html[max(0,idx-80):idx+200] if idx >= 0 else html[:400]
    print(f"\n  Page snippet:\n{snippet}\n")
    sys.exit(1)

# Cookies from GET
info(f"Cookies after GET: {[c.name for c in cj]}")

# ────────────────────────────────────────────────────────────────────────────
sep("STEP 4 — POST credentials")
post_data = urllib.parse.urlencode({
    "csrfmiddlewaretoken": csrf,
    "username": EMAIL,
    "password": PASSWORD,
    "next": "",
}).encode("utf-8")

login_req = urllib.request.Request(
    f"{BASE}/login/",
    data=post_data,
    headers={
        **HEADERS,
        "Accept":       "text/html,application/xhtml+xml",
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer":      f"{BASE}/login/",
        "X-CSRFToken":  csrf,
    },
)

try:
    with opener.open(login_req, timeout=20) as r:
        final_url  = r.geturl()
        resp_html  = r.read().decode("utf-8")
        status     = r.status
    info(f"HTTP status     : {status}")
    info(f"Final URL       : {final_url}")
    info(f"Cookies after POST: {[c.name for c in cj]}")

    if "/login/" in final_url:
        fail("Still on /login/ — credentials rejected by screener.in")

        # Dig out the error message screener.in shows
        err_li   = re.search(r'class="errorlist".*?<li>(.*?)</li>', resp_html, re.DOTALL)
        alert_div = re.search(r'class="[^"]*alert[^"]*"[^>]*>(.*?)</div>', resp_html, re.DOTALL)
        non_field = re.search(r'__all__.*?<li>(.*?)</li>', resp_html, re.DOTALL)

        for label, match in [("Django error", err_li),
                              ("Alert",        alert_div),
                              ("Non-field err",non_field)]:
            if match:
                msg = re.sub(r"<[^>]+>", "", match.group(1)).strip()
                warn(f"{label}: {msg}")

        print(f"""
  {Y}Possible causes:{X}
  1. Wrong email/password in .env
  2. The account email is not verified on screener.in
  3. Too many login attempts — screener.in rate-limited you
     → Wait 15 min and try again, or reset password at:
       https://www.screener.in/accounts/password/reset/
  4. screener.in added CAPTCHA / 2-step for this account
     → Try logging in manually at https://www.screener.in/login/
       and check if a CAPTCHA appears.
""")
        sys.exit(1)

    ok(f"Login SUCCESSFUL — landed on {final_url}")

except urllib.error.HTTPError as e:
    fail(f"HTTP {e.code} on login POST: {e.reason}")
    sys.exit(1)
except Exception as e:
    fail(f"Login POST failed: {e}")
    sys.exit(1)

# ────────────────────────────────────────────────────────────────────────────
sep("STEP 5 — Fetch a stock page (PAGEIND)")
test_sym = "PAGEIND"
page_req = urllib.request.Request(
    f"{BASE}/company/{test_sym}/consolidated/",
    headers={**HEADERS, "Accept": "text/html,application/xhtml+xml", "Referer": BASE},
)
try:
    with opener.open(page_req, timeout=25) as r:
        pg_url  = r.geturl()
        pg_html = r.read().decode("utf-8")
    info(f"Stock page URL  : {pg_url}")

    if "/login/" in pg_url:
        fail("Session not accepted — redirected to login on stock page fetch")
        sys.exit(1)

    numbers = [n for n in re.findall(r'<span class="number">([^<]+)</span>', pg_html) if n.strip()]
    ok(f"Authenticated data: {len(numbers)} populated numbers found")
    info(f"Sample values   : {numbers[:6]}")

    # Extract PE, ROCE, ROE from top-ratios
    for li in re.findall(r'<li[^>]*>(.*?)</li>', pg_html, re.DOTALL):
        name_m = re.search(r'class="name"[^>]*>(.*?)</span>', li, re.DOTALL)
        num_m  = re.search(r'class="number">([\d,.\-]+)</span>', li)
        if name_m and num_m:
            label = re.sub(r'<[^>]+>', '', name_m.group(1)).strip()
            if label in ("Stock P/E", "ROCE", "ROE"):
                ok(f"{label:20s}: {num_m.group(1)}")

except Exception as e:
    fail(f"Stock page fetch failed: {e}")
    sys.exit(1)

# ────────────────────────────────────────────────────────────────────────────
sep("✅  ALL STEPS PASSED — Credentials and data fetch working perfectly")
print(f"""
  {G}Your credentials are correct and screener.in is fully accessible.{X}

  To fix the app:
  1. Make sure you run the backend on THIS machine (not the cloud IDE).
  2. The cloud IDE's network blocks screener.in — that's an environment issue.

  Local run:
    cd Buddy/backend
    pip install -r requirements.txt
    uvicorn app.main:app --reload --port 8000
""")
