"""
Tier-B row builder — Screener.in bundle -> `fundamentals` table rows.

Data source (per the locked decision, 2026-09-01): quarterly fundamentals
come from Screener.in's authenticated company page (see screener_client /
screener_page — the parsing methodology proven in legacy Buddy). yfinance
remains the DAILY (Tier-A) source only; the two tiers never mix sources.

Row contract:
  * One row per quarter column from Screener's #quarters table, keyed by
    (symbol, quarter_end_date) — idempotent upserts.
  * Money values: Screener prints ₹ CRORES; the DB stores ABSOLUTE rupees
    (registry contract; the frontend's fmtCr divides by 1e7). Converted
    here, exactly once.
  * "Latest at fetch time" quality metrics (ROCE / ROE / net D/E / pledging
    / holdings / 5Y averages) land on the NEWEST quarter row only.
  * data_quality_flags records the concrete source per enriched field.
  * EVERY row carries the same key set — PostgREST bulk upserts use one
    uniform column list, and a missing key becomes an explicit NULL that
    fights NOT NULL DEFAULT columns.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, List, Optional

from plutus.registry.types import round_half_up

_CRORE = Decimal(10_000_000)  # 1 Cr = 1e7 rupees


def _cr_to_abs(v: Optional[Decimal]) -> Optional[Decimal]:
    if v is None:
        return None
    return round_half_up(v * _CRORE, 2)


def rows_from_bundle(bundle: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Screener bundle (see ScreenerClient.fetch_bundle) -> fundamentals rows,
    NEWEST QUARTER FIRST. Returns [] when the bundle has no usable quarters."""
    quarterly = bundle.get("quarterly") or []
    ratios: Dict[str, Any] = bundle.get("ratios") or {}
    holdings: Dict[str, Any] = bundle.get("shareholding") or {}

    usable = [q for q in quarterly if q.get("quarter_end_date") is not None]
    if not usable:
        return []
    # Screener prints oldest -> newest; we emit newest first.
    usable = sorted(usable, key=lambda q: q["quarter_end_date"], reverse=True)

    promoter = holdings.get("promoter_holding_pct")
    institutional = holdings.get("institutional_pct")
    public = holdings.get("public_holding_pct")
    pledging = ratios.get("pledged_pct")
    roce = ratios.get("roce")
    roe = ratios.get("roe")
    net_de = ratios.get("net_debt_to_equity")
    pe5 = ratios.get("pe_5yr_avg")
    pb5 = ratios.get("pb_5yr_avg")

    flags: Dict[str, str] = {}
    for name, val in (("roce", roce), ("roe", roe),
                      ("net_debt_to_equity", net_de),
                      ("promoter_pledging_pct", pledging),
                      ("pe_5y_avg", pe5), ("pb_5y_avg", pb5)):
        if val is not None:
            flags[name] = "screener.in"

    raw_payload = {
        "top_ratios": {str(k): str(v)
                       for k, v in (ratios.get("_raw_map") or {}).items()},
        "shareholding": {k: str(v) for k, v in holdings.items()
                         if v is not None},
    }

    rows: List[Dict[str, Any]] = []
    newest = True
    for q in usable:
        rows.append({
            "quarter_end_date": q["quarter_end_date"],
            "quarter_label": q.get("quarter_label"),
            "sales": _cr_to_abs(q.get("sales")),
            "pbt": _cr_to_abs(q.get("pbt")),
            "net_profit": _cr_to_abs(q.get("net_profit")),
            # OPM dropped from the criteria (2026-09-02) — column kept, NULL.
            "operating_margin_pct": None,
            # Shareholding: latest pattern applies to the newest row.
            "promoter_holding_pct": promoter if newest else None,
            "institutional_pct": institutional if newest else None,
            "public_holding_pct": public if newest else None,
            "promoter_pledging_pct": pledging if newest else None,
            "promoter_holding_source": "screener.in",
            # Quality metrics — "latest at fetch time".
            "roce": roce if newest else None,
            "roe": roe if newest else None,
            "net_debt_to_equity": net_de if newest else None,
            "pe_5y_avg": pe5 if newest else None,
            "pb_5y_avg": pb5 if newest else None,
            "data_source": "screener.in",
            "data_quality_flags": flags if newest else {},
            "raw_yf_payload": raw_payload if newest else {},
        })
        newest = False
    return rows
