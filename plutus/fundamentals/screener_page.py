"""
Screener.in company-page parsers — pure functions, no I/O.

Faithful Decimal port of the parsing methodology proven in the legacy
Buddy screener fetcher (removed 2026-09-16; see git history):

  * ``#quarters`` section table  -> quarterly Sales / OPM% / PBT / Net Profit
  * ``#top-ratios`` <li> items   -> default ratios (ROCE, ROE, ...)
  * quick-ratios Ajax fragment   -> custom ratios (Net D/E, Pledged %, 5Yrs PE/PBV)
  * ``#shareholding`` table      -> Promoters / FIIs / DIIs / Public %
  * pledging fallbacks           -> #analysis cons list, <meta description>

Everything numeric returns Decimal via ``to_decimal`` (the only sanctioned
conversion). All functions take HTML strings and are unit-tested offline
against fixtures — the network layer lives in ``screener_client.py``.

UNITS: Screener reports money in ₹ CRORES. The `fundamentals` table stores
ABSOLUTE rupees (registry contract, and what the frontend's fmtCr expects) —
``CRORE = Decimal(1e7)`` conversion happens in ``rows_from_bundle`` in
``quarterly.py``, NOT here. Parsers return values exactly as printed.
"""
from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional

from plutus.registry.types import to_decimal

# ---------------------------------------------------------------------------
# Number / label helpers (legacy: _parse_number / _strip_html_get_text)
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def parse_number(text: Optional[str]) -> Optional[Decimal]:
    """'3,09,468' / '63.0%' / '—' -> Decimal or None. Never float."""
    if not text:
        return None
    cleaned = text.strip().replace(",", "").replace("%", "").replace("\xa0", "")
    if cleaned in ("", "—", "-", "NA", "N/A"):
        return None
    return to_decimal(cleaned)


def strip_html(fragment: str) -> str:
    """Remove tags, collapse whitespace (legacy _strip_html_get_text)."""
    return _WS_RE.sub(" ", _TAG_RE.sub(" ", fragment)).strip()


_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
_DAYS_IN_MONTH = {1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30,
                  7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}


def quarter_label_to_date(label: str) -> Optional[date]:
    """'Jun 2026' -> date(2026, 6, 30) (month-end)."""
    m = re.match(r"([A-Za-z]{3})\w*\s+(\d{4})", label.strip())
    if not m:
        return None
    month = _MONTHS.get(m.group(1).lower())
    if month is None:
        return None
    year = int(m.group(2))
    day = _DAYS_IN_MONTH[month]
    if month == 2 and year % 4 == 0 and (year % 100 != 0 or year % 400 == 0):
        day = 29
    return date(year, month, day)


# ---------------------------------------------------------------------------
# Section-table parser (legacy _parse_section_table)
# ---------------------------------------------------------------------------

def parse_section_table(html: str, section_id: str) -> List[List[str]]:
    """<section id=...><table class="data-table"> -> rows of cell strings.
    Row 0 is the header when a <thead> exists."""
    rows: List[List[str]] = []
    m = re.search(rf'<section[^>]*id="{section_id}"[^>]*>(.*?)</section>',
                  html, re.DOTALL)
    if not m:
        return rows
    section_html = m.group(1)

    thead_m = re.search(r"<thead>(.*?)</thead>", section_html, re.DOTALL)
    if thead_m:
        ths = re.findall(r"<th[^>]*>(.*?)</th>", thead_m.group(1), re.DOTALL)
        header = [strip_html(h) for h in ths]
        if header:
            rows.append(header)

    tbody_m = re.search(r"<tbody>(.*?)</tbody>", section_html, re.DOTALL)
    if tbody_m:
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", tbody_m.group(1), re.DOTALL):
            cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.DOTALL)
            cleaned = [strip_html(c) for c in cells]
            if cleaned:
                rows.append(cleaned)
    return rows


# ---------------------------------------------------------------------------
# Quarterly results — #quarters (legacy _extract_quarterly_results + OPM row)
# ---------------------------------------------------------------------------

def extract_quarterly_results(html: str) -> List[Dict[str, Any]]:
    """One dict per quarter column, NEWEST LAST as printed on the page:
    {quarter_label, quarter_end_date, sales, pbt, net_profit,
     gross_npa_pct, net_npa_pct}.
    Money values are in ₹ CRORES exactly as printed. Banks / NBFCs print
    "Revenue" instead of "Sales" (mapped to `sales`) and carry the two NPA
    rows; for everyone else the NPA keys are None.
    (OPM intentionally not extracted — dropped from the criteria 2026-09-02.)"""
    out: List[Dict[str, Any]] = []
    rows = parse_section_table(html, "quarters")
    if not rows:
        return out
    headers = rows[0]
    if len(headers) < 2:
        return out

    sales_row = pbt_row = np_row = gnpa_row = nnpa_row = None
    for row in rows[1:]:
        if not row:
            continue
        label = row[0].lower()
        if (label.startswith("sales") or label.startswith("revenue")) and sales_row is None:
            sales_row = row
        elif ("profit before tax" in label or label.strip() == "pbt") and pbt_row is None:
            pbt_row = row
        elif "net profit" in label and "before" not in label and np_row is None:
            np_row = row
        elif label.startswith("gross npa") and gnpa_row is None:
            gnpa_row = row
        elif label.startswith("net npa") and nnpa_row is None:
            nnpa_row = row

    def _cell(row: Optional[List[str]], i: int) -> Optional[Decimal]:
        if row is None or i >= len(row):
            return None
        return parse_number(row[i])

    for i in range(1, len(headers)):
        label = headers[i].strip()
        if not label:
            continue
        out.append({
            "quarter_label": label,
            "quarter_end_date": quarter_label_to_date(label),
            "sales": _cell(sales_row, i),
            "pbt": _cell(pbt_row, i),
            "net_profit": _cell(np_row, i),
            "gross_npa_pct": _cell(gnpa_row, i),
            "net_npa_pct": _cell(nnpa_row, i),
        })
    return out


def quarterly_npa_is_blank(quarterly: List[Dict[str, Any]], html: str) -> bool:
    """True when the #quarters table CARRIES the NPA rows but every cell is
    empty. Banks disclose asset quality on the STANDALONE statements only;
    their consolidated page prints the row labels with blank cells
    (verified HDFCBANK / ICICIBANK / SBIN / AXISBANK / KOTAKBANK, 2026-09-25).
    NBFCs print NPAs on both views. Non-lenders have no rows -> False."""
    if not quarterly:
        return False
    if any(q.get("gross_npa_pct") is not None or q.get("net_npa_pct") is not None
           for q in quarterly):
        return False
    for row in parse_section_table(html, "quarters")[1:]:
        if row and row[0].strip().lower().startswith(("gross npa", "net npa")):
            return True
    return False


def fill_npa_from(quarterly: List[Dict[str, Any]],
                  other: List[Dict[str, Any]]) -> int:
    """Copy gross_npa_pct / net_npa_pct from `other` into `quarterly` by
    quarter label, only where the target cell is None. Returns the number
    of quarters that received at least one value."""
    by_label = {q.get("quarter_label"): q for q in other if q.get("quarter_label")}
    filled = 0
    for q in quarterly:
        src = by_label.get(q.get("quarter_label"))
        if not src:
            continue
        touched = False
        for key in ("gross_npa_pct", "net_npa_pct"):
            if q.get(key) is None and src.get(key) is not None:
                q[key] = src[key]
                touched = True
        filled += 1 if touched else 0
    return filled


# ---------------------------------------------------------------------------
# Balance sheet — #balance-sheet "Total Assets" (ROA denominator for lenders)
# ---------------------------------------------------------------------------

def extract_total_assets(html: str) -> Optional[Decimal]:
    """Latest (right-most) 'Total Assets' cell of the #balance-sheet table,
    in ₹ CRORES as printed. None when the section or row is absent."""
    rows = parse_section_table(html, "balance-sheet")
    for row in rows[1:] if rows else []:
        if not row:
            continue
        if row[0].strip().lower().startswith("total assets"):
            for cell in reversed(row[1:]):
                v = parse_number(cell)
                if v is not None:
                    return v
            return None
    return None


# ---------------------------------------------------------------------------
# Ratios — #top-ratios + quick-ratios fragment (legacy _extract_ratios)
# ---------------------------------------------------------------------------

_SPAN_TAG_RE = re.compile(r"<(/?)span(?:\s[^>]*)?>", re.IGNORECASE)


def parse_ratio_lis(source_html: str) -> Dict[str, str]:
    """<li> items -> {label: raw numeric string}. Handles nested spans in the
    label (legacy depth-walk) so '5Yrs <span class=sub>avg</span> PE' parses."""
    ratio_map: Dict[str, str] = {}
    for li in re.findall(r"<li[^>]*>(.*?)</li>", source_html, re.DOTALL):
        num_m = re.search(r'class=["\']number["\'][^>]*>([\d,.\-]+)<', li)
        if not num_m:
            continue
        raw_val = num_m.group(1).strip()

        name_open_m = re.search(
            r'<span[^>]*class=["\'][^"\']*name[^"\']*["\'][^>]*>', li)
        if not name_open_m:
            continue
        after_open = li[name_open_m.end():]
        depth = 1
        content_end = len(after_open)
        for m in _SPAN_TAG_RE.finditer(after_open):
            if m.group(1) == "/":
                depth -= 1
                if depth == 0:
                    content_end = m.start()
                    break
            else:
                depth += 1
        inner = after_open[:content_end]
        label_html = re.sub(r"<span[^>]*>.*?</span>", "", inner, flags=re.DOTALL)
        label = strip_html(label_html)
        if label:
            ratio_map[label] = raw_val
    return ratio_map


def extract_ratios(html: str, quick_ratios_html: Optional[str] = None) -> Dict[str, Optional[Decimal]]:
    """Merge #top-ratios + the quick-ratios Ajax fragment, then map the
    labels the Plutus rules need (legacy fuzzy-match order preserved)."""
    ratio_map: Dict[str, str] = {}
    top_m = re.search(r'<ul[^>]*id=["\']top-ratios["\'][^>]*>(.*?)</ul>',
                      html, re.DOTALL)
    ratio_map.update(parse_ratio_lis(top_m.group(1) if top_m else html))
    if quick_ratios_html:
        ratio_map.update(parse_ratio_lis(quick_ratios_html))

    lc_map = {k.lower(): v for k, v in ratio_map.items()}

    def _fuzzy(candidates: List[str]) -> Optional[Decimal]:
        for key in candidates:                      # exact
            if key in ratio_map:
                v = parse_number(ratio_map[key])
                if v is not None:
                    return v
        for key in candidates:                      # case-insensitive
            if key.lower() in lc_map:
                v = parse_number(lc_map[key.lower()])
                if v is not None:
                    return v
        for key in candidates:                      # prefix
            kl = key.lower()
            for rk, rv in ratio_map.items():
                if rk.lower().startswith(kl):
                    v = parse_number(rv)
                    if v is not None:
                        return v
        return None

    ratios: Dict[str, Optional[Decimal]] = {
        "current_pe": _fuzzy(["Stock P/E", "P/E", "PE"]),
        # ₹ CRORES as printed (weekly ratios worker converts to absolute ₹).
        "market_cap_cr": _fuzzy(["Market Cap"]),
        "current_price": _fuzzy(["Current Price"]),
        "book_value": _fuzzy(["Book Value"]),
        "roce": _fuzzy(["ROCE"]),
        "roe": _fuzzy(["ROE", "Return on equity"]),
        # Only present when the account's quick ratios include it (lenders).
        "roa": _fuzzy(["Return on assets", "ROA", "Return on Assets"]),
        "net_debt_to_equity": _fuzzy([
            "Net Debt to Equity", "Net Debt / Equity", "Net Debt/Equity",
            "Debt to equity", "Debt to Equity",
        ]),
        "pledged_pct": _fuzzy([
            "Pledged percentage", "Pledging %", "Pledged %",
            "Promoter Pledging", "% Pledged",
        ]),
        "pe_5yr_avg": _fuzzy(["5Yrs PE", "5 Yr PE", "5Yrs P/E", "5 Yr P/E", "5Yr PE"]),
        "pb_5yr_avg": _fuzzy([
            "5Yrs PBV", "5 Yr PBV", "5Yrs P/BV", "5Yrs P/B", "5 Yr P/B", "5Yr PBV",
        ]),
    }

    # Current PB = Current Price / Book Value (legacy derivation).
    price = ratios["current_price"]
    book = ratios["book_value"]
    ratios["current_pb"] = None
    if price is not None and book is not None and book > 0:
        ratios["current_pb"] = (price / book).quantize(Decimal("0.01"))

    # Raw map kept for the JSONB audit payload.
    ratios["_raw_map"] = ratio_map  # type: ignore[assignment]
    return ratios


# ---------------------------------------------------------------------------
# Pledging fallbacks (legacy _extract_pledging_from_analysis)
# ---------------------------------------------------------------------------

def extract_pledging_fallback(html: str) -> Optional[Decimal]:
    """#analysis cons sentence, then <meta description>. None = not mentioned
    (screener only writes the sentence when pledging > 0)."""
    analysis_m = re.search(r'<section[^>]*id="analysis"[^>]*>(.*?)</section>',
                           html, re.DOTALL)
    if analysis_m:
        pm = re.search(r"pledged\s+([\d]+(?:\.\d+)?)\s*%",
                       analysis_m.group(1), re.IGNORECASE)
        if pm:
            return parse_number(pm.group(1))
    pm = re.search(r"pledged\s+([\d]+(?:\.\d+)?)\s*%", html[:5000], re.IGNORECASE)
    if pm:
        return parse_number(pm.group(1))
    return None


# ---------------------------------------------------------------------------
# Shareholding — #shareholding table (extended: FIIs/DIIs/Public rows too)
# ---------------------------------------------------------------------------

def extract_shareholding(html: str) -> Dict[str, Optional[Decimal]]:
    """Latest-quarter Promoters / FIIs+DIIs / Public percentages.
    institutional_pct = FIIs + DIIs (matches Screener's split)."""
    out: Dict[str, Optional[Decimal]] = {
        "promoter_holding_pct": None,
        "institutional_pct": None,
        "public_holding_pct": None,
    }
    sh_m = re.search(r'<section[^>]*id="shareholding"[^>]*>(.*?)</section>',
                     html, re.DOTALL)
    if not sh_m:
        return out
    section_html = sh_m.group(0)

    def _latest(cells: List[str]) -> Optional[Decimal]:
        vals = [parse_number(strip_html(c)) for c in cells]
        vals = [v for v in vals if v is not None]
        return vals[-1] if vals else None

    fii = dii = None
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", section_html, re.DOTALL):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.DOTALL)
        if not cells:
            continue
        label = strip_html(cells[0]).lower().replace("\xa0", " ")
        if "no." in label:
            continue
        if "promoter" in label and "pledge" not in label and out["promoter_holding_pct"] is None:
            out["promoter_holding_pct"] = _latest(cells[1:])
        elif label.startswith("fii") and fii is None:
            fii = _latest(cells[1:])
        elif label.startswith("dii") and dii is None:
            dii = _latest(cells[1:])
        elif label.startswith("public") and out["public_holding_pct"] is None:
            out["public_holding_pct"] = _latest(cells[1:])

    if fii is not None or dii is not None:
        out["institutional_pct"] = (fii or Decimal(0)) + (dii or Decimal(0))
    return out


def extract_warehouse_id(html: str) -> Optional[str]:
    """data-warehouse-id — needed for the quick-ratios Ajax call."""
    m = re.search(r'data-warehouse-id=["\'](\d+)["\']', html)
    return m.group(1) if m else None
