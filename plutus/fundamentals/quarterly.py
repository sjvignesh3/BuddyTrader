"""
Pure extractors for the quarterly fundamentals payloads yfinance exposes.

Each function takes a raw DataFrame / dict / list and returns registry-shaped
Decimals or None. Zero I/O, zero side-effects — every extractor is unit-tested
with synthetic fixtures.

yfinance surface used:
  * Ticker.quarterly_financials  — DataFrame indexed by line-item, columns = quarter-end date.
  * Ticker.quarterly_balance_sheet
  * Ticker.quarterly_cashflow
  * Ticker.major_holders          — 2-column DataFrame with insider / institutional %.

Design:
  * ``extract_quarterly_rows(...)`` returns one dict per quarter column,
    keyed by ``fundamentals`` field names. Sync worker upserts these.
  * All Decimal — no float leaks. NaN / missing keys → None (not raise).
"""
from __future__ import annotations

import math
from datetime import date
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence

from plutus.adapters.validators import sanity_check_ratio
from plutus.registry.types import round_half_up, to_decimal


_PCT = 2   # decimal places for percentages
_MONEY = 2   # decimal places for absolute ₹ values

# yfinance line-item labels — normalised (lower-case, stripped).
_SALES_KEYS = ("Total Revenue", "Revenue", "Operating Revenue")
_PBT_KEYS = ("Pretax Income", "Income Before Tax")
_NET_PROFIT_KEYS = ("Net Income", "Net Income Common Stockholders",
                    "Net Income From Continuing Operations")
_OPERATING_INCOME_KEYS = ("Operating Income", "Operating Revenue")


# ---------------------------------------------------------------------------
# Tiny helpers
# ---------------------------------------------------------------------------
def _to_dec_money(v: Any) -> Optional[Decimal]:
    """Coerce a yfinance numeric cell (may be NaN) to Decimal, or None."""
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    try:
        d = to_decimal(v)
    except Exception:
        return None
    return round_half_up(d, _MONEY)


def _to_dec_pct(v: Any) -> Optional[Decimal]:
    """Coerce a percentage (as fraction 0..1 OR percent 0..100)."""
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    try:
        d = to_decimal(v)
    except Exception:
        return None
    # Heuristic: yfinance sometimes returns fractions (0.24), sometimes percents
    # (24.0). Anything in [-1, 1] is treated as a fraction and scaled.
    if Decimal("-1") <= d <= Decimal("1"):
        d = d * Decimal(100)
    try:
        d = sanity_check_ratio(d, field="pct")
    except ValueError:
        return None
    return round_half_up(d, _PCT) if d is not None else None


def _column_get(df: Any, row_key: str, col_key: Any) -> Any:
    """Duck-typed cell fetch: df.at[row_key, col_key] or via row.get."""
    try:
        return df.at[row_key, col_key]
    except Exception:
        pass
    try:
        row = df.loc[row_key]
    except Exception:
        return None
    try:
        return row[col_key]
    except Exception:
        return None


def _first_available_row(df: Any, keys: Iterable[str], col: Any) -> Optional[Decimal]:
    for k in keys:
        v = _column_get(df, k, col)
        if v is not None and not (isinstance(v, float) and math.isnan(v)):
            return _to_dec_money(v)
    return None


def _coerce_col_to_date(col: Any) -> Optional[date]:
    if col is None:
        return None
    if isinstance(col, date):
        return col
    to_date = getattr(col, "date", None)
    if callable(to_date):
        try:
            return to_date()
        except Exception:
            return None
    # Last resort: string parse "YYYY-MM-DD"
    if isinstance(col, str):
        try:
            from datetime import datetime as _dt
            return _dt.strptime(col[:10], "%Y-%m-%d").date()
        except Exception:
            return None
    return None


# ---------------------------------------------------------------------------
# Major holders — 2-row DataFrame ("Insider" / "Institutions")
# ---------------------------------------------------------------------------
def extract_holdings(major_holders_df: Any) -> Dict[str, Optional[Decimal]]:
    """
    Returns dict with promoter_holding_pct, institutional_pct, public_holding_pct.

    yfinance shape (varies by version):
      row 0 = ("% of Shares Held by All Insider", "12.34%")
      row 1 = ("% of Shares Held by Institutions", "45.67%")
    """
    out: Dict[str, Optional[Decimal]] = {
        "promoter_holding_pct": None,
        "institutional_pct": None,
        "public_holding_pct": None,
    }
    if major_holders_df is None:
        return out
    rows: List[Any] = []
    # Duck-type: use iterrows if it's a DataFrame, else assume iterable of rows.
    if hasattr(major_holders_df, "iterrows"):
        rows = [r for _, r in major_holders_df.iterrows()]
    else:
        try:
            rows = list(major_holders_df)
        except Exception:
            return out

    def _cell_to_pct(cell: Any) -> Optional[Decimal]:
        if cell is None:
            return None
        if isinstance(cell, str):
            cell = cell.strip().rstrip("%").strip()
            if not cell:
                return None
        return _to_dec_pct(cell)

    if len(rows) >= 1:
        # yfinance uses column 0 for the value, column 1 for the label.
        try:
            val = rows[0][0]
        except Exception:
            val = None
        out["promoter_holding_pct"] = _cell_to_pct(val)
    if len(rows) >= 2:
        try:
            val = rows[1][0]
        except Exception:
            val = None
        out["institutional_pct"] = _cell_to_pct(val)

    p = out["promoter_holding_pct"]
    i = out["institutional_pct"]
    if p is not None and i is not None:
        pub = Decimal(100) - p - i
        if Decimal(0) <= pub <= Decimal(100):
            out["public_holding_pct"] = round_half_up(pub, _PCT)
    return out


# ---------------------------------------------------------------------------
# Quarterly rows
# ---------------------------------------------------------------------------
def extract_quarterly_rows(
    quarterly_financials: Any,
    info: Optional[Dict[str, Any]] = None,
    major_holders: Any = None,
) -> List[Dict[str, Any]]:
    """
    Turn a yfinance ``quarterly_financials`` DataFrame into one dict per
    quarter, keyed by ``fundamentals`` registry field names.

    Newest quarter is first (yfinance's native ordering).
    """
    if quarterly_financials is None or not hasattr(quarterly_financials, "columns"):
        return []
    cols = list(quarterly_financials.columns)
    if not cols:
        return []

    holdings = extract_holdings(major_holders)
    de_ratio = None
    if info:
        try:
            de_ratio = sanity_check_ratio(info.get("debtToEquity"), field="d/e")
        except ValueError:
            de_ratio = None

    rows: List[Dict[str, Any]] = []
    for col in cols:
        q_date = _coerce_col_to_date(col)
        if q_date is None:
            continue

        sales = _first_available_row(quarterly_financials, _SALES_KEYS, col)
        pbt = _first_available_row(quarterly_financials, _PBT_KEYS, col)
        net_profit = _first_available_row(quarterly_financials, _NET_PROFIT_KEYS, col)
        operating_income = _first_available_row(
            quarterly_financials, _OPERATING_INCOME_KEYS, col)

        op_margin: Optional[Decimal] = None
        if sales and sales > 0 and operating_income is not None:
            op_margin = round_half_up(
                operating_income / sales * Decimal(100), _PCT
            )

        rows.append({
            "quarter_end_date": q_date,
            "quarter_label": q_date.strftime("%b %Y"),
            "sales": sales,
            "pbt": pbt,
            "net_profit": net_profit,
            "operating_margin_pct": op_margin,

            "promoter_holding_pct": holdings["promoter_holding_pct"],
            "institutional_pct": holdings["institutional_pct"],
            "public_holding_pct": holdings["public_holding_pct"],
            # Manual-only fields — placeholders. Overwritten by CSV upload path.
            "promoter_pledging_pct": None,
            "promoter_holding_source": "yfinance",
            "roce": None,
            "roe": None,
            "net_debt_to_equity": de_ratio,
        })
    return rows


# ---------------------------------------------------------------------------
# 5Y average PE / PB — Stage 5 real implementation
# ---------------------------------------------------------------------------
def compute_pe_5yr_avg(
    quarterly_net_income: Sequence[Optional[Decimal]],
    shares_outstanding: Optional[Decimal],
    daily_closes: Sequence[Decimal],
) -> Optional[Decimal]:
    """
    Rolling 5Y average PE from quarterly Net Income + daily close prices.

    Method (matches Buddy's Validation Report §3):
        1. TTM_EPS[t] = sum(NetIncome over trailing 4 quarters) / shares_out
        2. PE[t]      = close[t] / TTM_EPS[t]
        3. Return mean of daily PE over the last ~1260 trading days (5Y).

    Simplified pragmatic implementation:
        * We do not have the daily NI join here — the sync worker will
          precompute a single TTM_EPS from the most recent 4 available
          quarters and apply it uniformly across the 5Y close window.
        * Absent that data → returns None.
    """
    if not quarterly_net_income or not daily_closes or shares_outstanding is None:
        return None
    try:
        shares = to_decimal(shares_outstanding)
    except Exception:
        return None
    if shares <= 0:
        return None

    last_4 = [q for q in list(quarterly_net_income)[:4] if q is not None]
    if len(last_4) < 4:
        return None
    ttm_ni = sum((Decimal(str(q)) for q in last_4), Decimal(0))
    if ttm_ni <= 0:
        return None
    ttm_eps = ttm_ni / shares

    # Take up to 1260 most-recent closes (approx 5Y trading days).
    closes = [to_decimal(c) for c in list(daily_closes)[-1260:]
              if c is not None]
    if not closes:
        return None
    pe_series = [c / ttm_eps for c in closes if c > 0 and ttm_eps > 0]
    if not pe_series:
        return None
    avg = sum(pe_series, Decimal(0)) / Decimal(len(pe_series))
    return round_half_up(avg, _PCT)


def compute_pb_5yr_avg(
    book_value_per_share: Optional[Decimal],
    daily_closes: Sequence[Decimal],
) -> Optional[Decimal]:
    """Rolling 5Y average PB from a single BVPS + daily closes."""
    if book_value_per_share is None or not daily_closes:
        return None
    try:
        bvps = to_decimal(book_value_per_share)
    except Exception:
        return None
    if bvps <= 0:
        return None
    closes = [to_decimal(c) for c in list(daily_closes)[-1260:]
              if c is not None]
    if not closes:
        return None
    pb_series = [c / bvps for c in closes if c > 0]
    if not pb_series:
        return None
    avg = sum(pb_series, Decimal(0)) / Decimal(len(pb_series))
    return round_half_up(avg, _PCT)
