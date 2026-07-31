"""Debug script to test the actual #top-ratios parsing on the live page."""
import os, re, sys
from pathlib import Path

# load .env
env_file = Path(__file__).parent / '.env'
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

import http.cookiejar, urllib.request, urllib.parse

SCREENER_BASE = 'https://www.screener.in'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
}

email = os.environ.get('SCREENER_EMAIL', '')
password = os.environ.get('SCREENER_PASSWORD', '')
print(f"Logging in as: {email}")

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

# Step 1: GET login page
req = urllib.request.Request(SCREENER_BASE + '/login/', headers={**HEADERS, 'Accept': 'text/html'})
with opener.open(req, timeout=20) as r:
    login_html = r.read().decode('utf-8')

csrf_m = re.search(r'name="csrfmiddlewaretoken"\s+value="([^"]+)"', login_html)
if not csrf_m:
    csrf_m = re.search(r"name='csrfmiddlewaretoken'\s+value='([^']+)'", login_html)
csrf = csrf_m.group(1)
print(f"CSRF token: {csrf[:20]}...")

# Step 2: POST login
data = urllib.parse.urlencode({
    'csrfmiddlewaretoken': csrf,
    'username': email,
    'password': password,
    'next': '',
}).encode()
req2 = urllib.request.Request(
    SCREENER_BASE + '/login/', data=data,
    headers={**HEADERS, 'Accept': 'text/html', 'Content-Type': 'application/x-www-form-urlencoded',
             'Referer': SCREENER_BASE + '/login/', 'X-CSRFToken': csrf}
)
with opener.open(req2, timeout=20) as r:
    final = r.geturl()
print(f"Login redirect: {final}")
if '/login/' in final:
    print("LOGIN FAILED"); sys.exit(1)
print("LOGIN OK\n")

# Step 3: Fetch WEBELSOLAR page
req3 = urllib.request.Request(
    SCREENER_BASE + '/company/WEBELSOLAR/consolidated/',
    headers={**HEADERS, 'Accept': 'text/html', 'Referer': SCREENER_BASE + '/'}
)
with opener.open(req3, timeout=25) as r:
    page = r.read().decode('utf-8')
print(f"Page fetched: {len(page)} chars")

# Step 4: Find the real top-ratios block
ul_start = page.find('<ul id="top-ratios"')
if ul_start == -1:
    print("❌ top-ratios NOT FOUND"); sys.exit(1)
print(f"top-ratios <ul> found at index: {ul_start}")

# Walk to real closing </ul> respecting nesting
depth = 0
i = ul_start
real_end = ul_start
while i < len(page):
    if page[i:i+3] == '<ul':
        depth += 1
    elif page[i:i+5] == '</ul>':
        depth -= 1
        if depth == 0:
            real_end = i + 5
            break
    i += 1

full_block = page[ul_start:real_end]
print(f"Full block length: {len(full_block)} chars")

nested_uls = re.findall(r'<ul[^>]*>', full_block)
print(f"Nested <ul> tags inside block: {nested_uls}")

li_count_full = len(re.findall(r'<li[^>]*>', full_block))
print(f"Total <li> items in full block: {li_count_full}")

# Step 5: What does the current regex capture?
m = re.search(r'<ul[^>]*id=["\']top-ratios["\'][^>]*>(.*?)</ul>', page, re.DOTALL)
if m:
    li_regex = len(re.findall(r'<li[^>]*>', m.group(1)))
    print(f"Current regex captures: {li_regex} <li> items")
    if li_regex < li_count_full:
        print(f"❌ BUG CONFIRMED: regex stops early, missing {li_count_full - li_regex} items")
        idx = full_block.find(m.group(1))
        cut_at = idx + len(m.group(1))
        print(f"Cut-off point content (first 500 chars):")
        print(repr(full_block[cut_at:cut_at+500]))
    else:
        print("✅ Regex correct - captures all items")
    ds_regex = re.findall(r'data-source="([^"]+)"', m.group(1))
    print(f"data-sources in regex result: {ds_regex}")
else:
    print("❌ Regex DID NOT MATCH")

ds_full = re.findall(r'data-source="([^"]+)"', full_block)
print(f"data-sources in full block:    {ds_full}")

# Step 6: Print full block for inspection
print("\n=== FULL TOP-RATIOS BLOCK ===")
print(full_block[:3000])
