"""Field Registry — the canonical catalog of every persisted Plutus field.

Every column that appears in Supabase, every metric that appears on the
frontend, every input a strategy consumes — all of them are defined ONCE
here. Migrations, adapters, metrics, sync workers, and scan strategies all
read from this module. No other file is allowed to hardcode a column name.

If you need a new field:
    1. Add it here with source + tier + formula + unit.
    2. Reference it from the appropriate migration file via ``FIELDS['name']``.
    3. Reference it from your adapter / metric using ``get_field('name')``.

This keeps the ``daily_snapshots`` schema, the yfinance adapter, and the
scan-time reads perfectly in sync — mismatches become impossible.
"""

from __future__ import annotations

from dataclasses import dataclass, field as dc_field
from enum import Enum
from types import MappingProxyType
from typing import Mapping, Optional


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------
class FieldSource(str, Enum):
    """Where the raw value ultimately comes from."""

    YF_INFO = "yfinance.info"              # ``.info`` dict fields
    YF_HISTORY = "yfinance.history"        # OHLCV DataFrame
    YF_QUARTERLY = "yfinance.quarterly"    # ``.quarterly_financials`` etc.
    YF_HOLDERS = "yfinance.major_holders"  # Shareholding table
    SCREENER = "screener.in"               # Authenticated Screener.in page
    DERIVED = "derived"                    # Computed from other fields
    MANUAL = "manual"                      # Admin CSV upload (pledging, ROE)
    CSV = "csv"                            # From the master universe CSV
    SYSTEM = "system"                      # Timestamps, primary keys, audit


class FieldTier(str, Enum):
    """When the field is refreshed."""

    UNIVERSE = "universe"           # Static, refreshed only via seed script.
    A_DAILY = "A_daily"             # Refreshed every trading day at 5 PM IST.
    B_QUARTERLY = "B_quarterly"     # Refreshed on manual/quarterly sync.
    DERIVED = "derived"             # Computed at read/scan time.
    SYSTEM = "system"               # Written by the DB itself.


class FieldDType(str, Enum):
    """Storage dtype. Maps 1:1 to Postgres and to the Python primitive."""

    DECIMAL = "DECIMAL"     # ``NUMERIC(p,s)`` in Postgres, ``Decimal`` in Py.
    INT = "INT"             # ``BIGINT`` typically.
    STR = "STR"             # ``VARCHAR`` / ``TEXT``.
    BOOL = "BOOL"
    DATE = "DATE"
    TIMESTAMP = "TIMESTAMP"
    JSONB = "JSONB"
    TEXT_ARRAY = "TEXT[]"


# ---------------------------------------------------------------------------
# Field record
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Field:
    """Metadata for one persisted field.

    Attributes
    ----------
    name:
        Column name. Snake case, matches the Postgres column exactly.
    table:
        Owning table (``stocks``, ``daily_snapshots``, ``fundamentals``, ...).
    dtype:
        Storage type.
    source:
        Where the raw value comes from.
    tier:
        When it is refreshed.
    unit:
        Human-readable unit / scale note (e.g. ``"₹ Cr"``, ``"percent (0-100)"``).
    nullable:
        Whether the DB column allows NULL. Derived fields with sparse inputs
        should be nullable; primary numeric columns should be too until the
        adapter proves the field is always present.
    formula:
        For ``DERIVED`` fields, the formula in plain math. For direct-copy
        fields, a short pointer to the source key.
    precision:
        For ``DECIMAL``, the (precision, scale) tuple used in the migration.
    yf_key:
        For ``YF_*`` sources, the exact key/attribute name on the yfinance
        object. Adapters read this — never a hardcoded string.
    notes:
        Free-form gotchas (e.g. "debtToEquity is returned as a percent").
    """

    name: str
    table: str
    dtype: FieldDType
    source: FieldSource
    tier: FieldTier
    unit: str = ""
    nullable: bool = True
    formula: str = ""
    precision: Optional[tuple[int, int]] = None
    yf_key: str = ""
    notes: str = ""


# ---------------------------------------------------------------------------
# Field catalog
# ---------------------------------------------------------------------------
# NOTE: Order below matches the migration ordering (stocks -> snapshots ->
# fundamentals). Do not reorder without also updating the migrations.
_FIELDS: list[Field] = [
    # ==================================================================
    # stocks — Universe (seeded from CSV, refreshed via seed script)
    # ==================================================================
    Field("id", "stocks", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="BIGSERIAL primary key."),
    Field("symbol", "stocks", FieldDType.STR, FieldSource.CSV, FieldTier.UNIVERSE,
          nullable=False, notes="NSE ticker without exchange suffix, e.g. RELIANCE."),
    Field("name", "stocks", FieldDType.STR, FieldSource.YF_INFO, FieldTier.UNIVERSE,
          yf_key="longName"),
    Field("sector", "stocks", FieldDType.STR, FieldSource.YF_INFO, FieldTier.UNIVERSE,
          yf_key="sector"),
    Field("industry", "stocks", FieldDType.STR, FieldSource.YF_INFO, FieldTier.UNIVERSE,
          yf_key="industry"),
    Field("exchange", "stocks", FieldDType.STR, FieldSource.CSV, FieldTier.UNIVERSE,
          notes="Default 'NSE'."),
    Field("active", "stocks", FieldDType.BOOL, FieldSource.CSV, FieldTier.UNIVERSE,
          nullable=False, notes="Soft-delete flag; scans skip inactive."),
    Field("pools", "stocks", FieldDType.TEXT_ARRAY, FieldSource.CSV, FieldTier.UNIVERSE,
          notes="Pool tags: F40, E40, S200, PlayArea."),
    Field("cap_type_manual", "stocks", FieldDType.STR, FieldSource.CSV, FieldTier.UNIVERSE,
          notes="Optional manual cap bucket: Large | Mid | Small | Micro (Universe page / CSV)."),
    Field("sector_group", "stocks", FieldDType.STR, FieldSource.MANUAL, FieldTier.UNIVERSE,
          unit="Banks|NBFC|Normal",
          notes="Which S200 screening criteria set applies (migration 019). "
                "Banks/NBFC: ROE + Net profit. Normal: Net D/E + ROCE + Net profit. "
                "Set on the Universe page or by import; NULL = not classified yet."),
    Field("metadata", "stocks", FieldDType.JSONB, FieldSource.CSV, FieldTier.UNIVERSE,
          notes="Free-form CSV extras (Priority, Volatility, etc.)."),

    # ==================================================================
    # daily_snapshots — Tier A price-action data (5 PM IST daily)
    # ==================================================================
    Field("stock_id", "daily_snapshots", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False),
    Field("symbol", "daily_snapshots", FieldDType.STR, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="Denormalized from stocks for fast lookup."),
    Field("snapshot_date", "daily_snapshots", FieldDType.DATE, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="The trading date this row represents (IST)."),

    # -- Raw OHLCV (from yfinance.history) ------------------------------
    Field("open", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_HISTORY, FieldTier.A_DAILY,
          precision=(12, 2), unit="₹", yf_key="Open"),
    Field("high", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_HISTORY, FieldTier.A_DAILY,
          precision=(12, 2), unit="₹", yf_key="High"),
    Field("low", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_HISTORY, FieldTier.A_DAILY,
          precision=(12, 2), unit="₹", yf_key="Low"),
    Field("close", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_HISTORY, FieldTier.A_DAILY,
          precision=(12, 2), unit="₹", yf_key="Close"),
    Field("adj_close", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_HISTORY, FieldTier.A_DAILY,
          precision=(12, 2), unit="₹", yf_key="Adj Close"),
    Field("volume", "daily_snapshots", FieldDType.INT, FieldSource.YF_HISTORY, FieldTier.A_DAILY,
          yf_key="Volume", notes="Traded shares."),

    # -- Valuation (from yfinance.info) ---------------------------------
    Field("market_cap", "daily_snapshots", FieldDType.DECIMAL, FieldSource.SCREENER, FieldTier.A_DAILY,
          precision=(20, 2), unit="₹ absolute",
          notes="From screener_ratios (weekly Saturday sync); stamped into "
                "each day's snapshot by the daily worker. Frontend shows ₹Cr."),
    Field("pe_current", "daily_snapshots", FieldDType.DECIMAL, FieldSource.SCREENER, FieldTier.A_DAILY,
          precision=(10, 2), unit="ratio",
          notes="Screener 'Stock P/E' (weekly) — same TTM convention as pe_5y_avg."),
    Field("forward_pe", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_INFO, FieldTier.A_DAILY,
          precision=(10, 2), unit="ratio", yf_key="forwardPE",
          notes="RETIRED (2026-09-01): column kept, no longer populated."),
    Field("pb_current", "daily_snapshots", FieldDType.DECIMAL, FieldSource.SCREENER, FieldTier.A_DAILY,
          precision=(10, 2), unit="ratio",
          notes="Screener Current Price / Book Value (weekly)."),
    Field("debt_to_equity_pct", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_INFO, FieldTier.A_DAILY,
          precision=(8, 4), unit="percent (0-100)", yf_key="debtToEquity",
          notes="RETIRED (2026-09-01): column kept, no longer populated. "
                "Net D/E lives in fundamentals (screener quick ratio)."),
    Field("ebitda_ttm", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_INFO, FieldTier.A_DAILY,
          precision=(20, 2), unit="₹ absolute", yf_key="ebitda",
          notes="RETIRED (2026-09-01): column kept, no longer populated."),
    Field("revenue_ttm", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_INFO, FieldTier.A_DAILY,
          precision=(20, 2), unit="₹ absolute", yf_key="totalRevenue"),
    Field("profit_margin_pct", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_INFO, FieldTier.A_DAILY,
          precision=(6, 2), unit="percent (0-100)", yf_key="profitMargins",
          notes="yfinance returns 0..1; adapter converts to percent."),

    # -- 52W (from yfinance.info) ---------------------------------------
    Field("high_52w", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_INFO, FieldTier.A_DAILY,
          precision=(12, 2), unit="₹", yf_key="fiftyTwoWeekHigh"),
    Field("low_52w", "daily_snapshots", FieldDType.DECIMAL, FieldSource.YF_INFO, FieldTier.A_DAILY,
          precision=(12, 2), unit="₹", yf_key="fiftyTwoWeekLow"),

    # -- Derived cap bucket --------------------------------------------
    Field("cap_bucket", "daily_snapshots", FieldDType.STR, FieldSource.DERIVED, FieldTier.A_DAILY,
          unit="Large|Mid|Small|Micro",
          formula="Large>=100000Cr, Mid 30000-100000Cr, Small 10000-30000Cr, Micro<10000Cr (env-overridable)"),

    # -- Derived from OHLCV --------------------------------------------
    Field("dma_200", "daily_snapshots", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.A_DAILY,
          precision=(12, 2), unit="₹",
          formula="mean(adj_close[-200:]); None when fewer than 200 bars"),
    Field("below_200dma_pct", "daily_snapshots", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.A_DAILY,
          precision=(6, 2), unit="percent",
          formula="(dma_200 - close) / dma_200 * 100; negative when above DMA"),
    Field("ath", "daily_snapshots", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.A_DAILY,
          precision=(12, 2), unit="₹",
          formula="max(High * (Adj Close / Close)) over 5Y, after dropna()"),
    Field("fall_from_ath_pct", "daily_snapshots", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.A_DAILY,
          precision=(6, 2), unit="percent",
          formula="(ath - close) / ath * 100; negative when above ATH"),
    Field("distance_from_52w_low_pct", "daily_snapshots", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.A_DAILY,
          precision=(6, 2), unit="percent (0-100)",
          formula="(close - low_52w) / low_52w * 100"),
    Field("distance_from_52w_high_pct", "daily_snapshots", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.A_DAILY,
          precision=(6, 2), unit="percent (0-100)",
          formula="(high_52w - close) / high_52w * 100"),

    # -- 20% Rally block (from OHLCV, see metrics/rally.py Stage 3) -----
    Field("has_valid_20pct_rally", "daily_snapshots", FieldDType.BOOL, FieldSource.DERIVED, FieldTier.A_DAILY,
          formula="See metrics/rally.py — pivot-based streak detection."),
    Field("last_rally_pct", "daily_snapshots", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.A_DAILY,
          precision=(6, 2), unit="percent",
          formula="See metrics/rally.py — (last_rally_high - last_rally_low) / last_rally_low * 100."),
    Field("last_rally_low", "daily_snapshots", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.A_DAILY,
          precision=(12, 2), unit="₹",
          formula="See metrics/rally.py — pivot low of the most recent qualified 20% rally."),
    Field("last_rally_high", "daily_snapshots", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.A_DAILY,
          precision=(12, 2), unit="₹",
          formula="See metrics/rally.py — pivot high of the most recent qualified 20% rally."),
    Field("last_rally_start_date", "daily_snapshots", FieldDType.DATE, FieldSource.DERIVED, FieldTier.A_DAILY,
          formula="See metrics/rally.py — date of the pivot low."),
    Field("last_rally_end_date", "daily_snapshots", FieldDType.DATE, FieldSource.DERIVED, FieldTier.A_DAILY,
          formula="See metrics/rally.py — date of the pivot high."),
    Field("days_since_last_rally", "daily_snapshots", FieldDType.INT, FieldSource.DERIVED, FieldTier.A_DAILY,
          formula="snapshot_date - last_rally_end_date, in trading days."),

    # -- Trend (from OHLCV) --------------------------------------------
    Field("price_change_nd_pct", "daily_snapshots", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.A_DAILY,
          precision=(6, 2), unit="percent",
          formula="(close[today] - close[today - N trading days]) / close[today - N] * 100."),

    # -- Raw payload for future-proofing --------------------------------
    Field("raw_yf_meta", "daily_snapshots", FieldDType.JSONB, FieldSource.YF_INFO, FieldTier.A_DAILY,
          notes="Full .info blob at snapshot time. Enables backfill of new fields."),

    # ==================================================================
    # fundamentals — Tier B (quarterly)
    # ==================================================================
    Field("stock_id", "fundamentals", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False),
    Field("symbol", "fundamentals", FieldDType.STR, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False),
    Field("quarter_end_date", "fundamentals", FieldDType.DATE, FieldSource.YF_QUARTERLY, FieldTier.B_QUARTERLY,
          nullable=False, yf_key="__column_header__",
          notes="Column header of the .quarterly_financials DataFrame (not a value)."),
    Field("quarter_label", "fundamentals", FieldDType.STR, FieldSource.DERIVED, FieldTier.B_QUARTERLY,
          formula="quarter_end_date.strftime('%b %Y') e.g. 'Sep 2024'."),

    Field("sales", "fundamentals", FieldDType.DECIMAL, FieldSource.YF_QUARTERLY, FieldTier.B_QUARTERLY,
          precision=(20, 2), unit="₹ absolute", yf_key="Total Revenue"),
    Field("pbt", "fundamentals", FieldDType.DECIMAL, FieldSource.YF_QUARTERLY, FieldTier.B_QUARTERLY,
          precision=(20, 2), unit="₹ absolute", yf_key="Pretax Income",
          notes="Confirmed available in yfinance >= 1.5.x."),
    Field("net_profit", "fundamentals", FieldDType.DECIMAL, FieldSource.YF_QUARTERLY, FieldTier.B_QUARTERLY,
          precision=(20, 2), unit="₹ absolute", yf_key="Net Income"),
    Field("operating_margin_pct", "fundamentals", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.B_QUARTERLY,
          precision=(6, 2), unit="percent (0-100)",
          formula="operating_income / sales * 100 if both present."),

    Field("promoter_holding_pct", "fundamentals", FieldDType.DECIMAL, FieldSource.YF_HOLDERS, FieldTier.B_QUARTERLY,
          precision=(6, 2), unit="percent (0-100)",
          yf_key="major_holders.row0",
          notes="First row of major_holders DataFrame (insider %). ±1-2% vs NSE."),
    Field("institutional_pct", "fundamentals", FieldDType.DECIMAL, FieldSource.YF_HOLDERS, FieldTier.B_QUARTERLY,
          precision=(6, 2), unit="percent (0-100)",
          yf_key="major_holders.row1",
          notes="Second row of major_holders DataFrame (institutional %)."),
    Field("public_holding_pct", "fundamentals", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.B_QUARTERLY,
          precision=(6, 2), unit="percent (0-100)",
          formula="100 - promoter_holding_pct - institutional_pct, if both present."),
    Field("promoter_pledging_pct", "fundamentals", FieldDType.DECIMAL, FieldSource.MANUAL, FieldTier.B_QUARTERLY,
          precision=(6, 2), unit="percent (0-100)",
          notes="No free API source. Admin uploads CSV each quarter."),
    Field("promoter_holding_source", "fundamentals", FieldDType.STR, FieldSource.SYSTEM, FieldTier.B_QUARTERLY,
          notes="'yfinance' or 'manual'."),

    Field("roce", "fundamentals", FieldDType.DECIMAL, FieldSource.MANUAL, FieldTier.B_QUARTERLY,
          precision=(6, 2), unit="percent",
          notes="yfinance null for Indian stocks; manual override for key names."),
    Field("roe", "fundamentals", FieldDType.DECIMAL, FieldSource.MANUAL, FieldTier.B_QUARTERLY,
          precision=(6, 2), unit="percent",
          notes="yfinance null for Indian stocks; manual override."),
    Field("net_debt_to_equity", "fundamentals", FieldDType.DECIMAL, FieldSource.YF_INFO, FieldTier.B_QUARTERLY,
          precision=(8, 4), unit="ratio", yf_key="debtToEquity",
          notes="Snapshot at fundamentals fetch time (also in daily_snapshots)."),

    # -- Banks & NBFC quality metrics (migration 021) -------------------
    # Lenders carry no meaningful Net D/E, ROCE or "Sales"; their 11-check
    # score (strategies/fundamental.py, group branch) reads these instead.
    Field("gross_npa_pct", "fundamentals", FieldDType.DECIMAL, FieldSource.SCREENER, FieldTier.B_QUARTERLY,
          precision=(6, 2), unit="percent (0-100)",
          notes="Screener #quarters 'Gross NPA %' row — one value PER QUARTER "
                "(banks / NBFCs only; NULL for everyone else)."),
    Field("net_npa_pct", "fundamentals", FieldDType.DECIMAL, FieldSource.SCREENER, FieldTier.B_QUARTERLY,
          precision=(6, 2), unit="percent (0-100)",
          notes="Screener #quarters 'Net NPA %' row — per quarter (lenders only)."),
    Field("total_assets", "fundamentals", FieldDType.DECIMAL, FieldSource.SCREENER, FieldTier.B_QUARTERLY,
          precision=(20, 2), unit="₹ absolute",
          notes="Latest #balance-sheet 'Total Assets' column (₹ Cr on the page, "
                "absolute here). Newest quarter row only. ROA denominator."),
    Field("roa", "fundamentals", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.B_QUARTERLY,
          precision=(6, 2), unit="percent",
          formula="Screener 'Return on assets' quick ratio when the account has it; "
                  "else sum(newest 4 quarters net_profit) / total_assets * 100. "
                  "Newest quarter row only.",
          notes="Bank ROA > 1.2%, NBFC ROA > 2% in the group score."),

    Field("pe_5y_avg", "fundamentals", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.B_QUARTERLY,
          precision=(10, 2), unit="ratio",
          formula="mean(daily_close / TTM_EPS) over last 5Y; TTM_EPS = sum(last 4Q NI)/shares_out."),
    Field("pb_5y_avg", "fundamentals", FieldDType.DECIMAL, FieldSource.DERIVED, FieldTier.B_QUARTERLY,
          precision=(10, 2), unit="ratio",
          formula="mean(daily_close / book_value_per_share) over last 5Y."),

    Field("raw_yf_payload", "fundamentals", FieldDType.JSONB, FieldSource.YF_QUARTERLY, FieldTier.B_QUARTERLY,
          notes="Full quarterly + info blob for future backfills."),
    Field("data_quality_flags", "fundamentals", FieldDType.JSONB, FieldSource.SYSTEM, FieldTier.B_QUARTERLY,
          notes="Per-field null/derived/manual markers."),
    Field("data_source", "fundamentals", FieldDType.STR, FieldSource.SYSTEM, FieldTier.B_QUARTERLY,
          notes="Default 'yfinance'."),
    Field("fetched_at", "fundamentals", FieldDType.TIMESTAMP, FieldSource.SYSTEM, FieldTier.SYSTEM),

    # ==================================================================
    # sync_jobs — Audit trail for every sync run (Stage 4)
    # ==================================================================
    Field("job_id", "sync_jobs", FieldDType.STR, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="UUID assigned by the worker."),
    Field("job_type", "sync_jobs", FieldDType.STR, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="'daily_sync' | 'quarterly_sync' | 'manual'."),
    Field("as_of_date", "sync_jobs", FieldDType.DATE, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="Trading date the job represents (IST)."),
    Field("started_at", "sync_jobs", FieldDType.TIMESTAMP, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False),
    Field("finished_at", "sync_jobs", FieldDType.TIMESTAMP, FieldSource.SYSTEM, FieldTier.SYSTEM),
    Field("status", "sync_jobs", FieldDType.STR, FieldSource.SYSTEM, FieldTier.SYSTEM,
          notes="'ok' | 'partial' | 'failed' | 'running'."),
    Field("symbols_total", "sync_jobs", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM),
    Field("symbols_ok", "sync_jobs", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM),
    Field("symbols_failed", "sync_jobs", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM),
    Field("snapshots_written", "sync_jobs", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM),
    Field("payload_json", "sync_jobs", FieldDType.JSONB, FieldSource.SYSTEM, FieldTier.SYSTEM,
          notes="Dry-run flag, upsert_errors, per-symbol failure map."),

    # errors_json on daily_snapshots — Stage 4 pipeline diagnostics.
    Field("errors_json", "daily_snapshots", FieldDType.JSONB, FieldSource.SYSTEM, FieldTier.A_DAILY,
          notes="Non-fatal pipeline warnings for that (symbol, date). Empty [] on clean runs."),

    # ==================================================================
    # scans — one row per (pool, snapshot_date, triggered_by) — Stage 6
    # ==================================================================
    Field("id", "scans", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="BIGSERIAL primary key."),
    Field("pool_code", "scans", FieldDType.STR, FieldSource.SYSTEM, FieldTier.SYSTEM,
          notes="F40, E40, S200, PlayArea."),
    Field("triggered_by", "scans", FieldDType.STR, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="'manual' | 'cron' | 'api'."),
    Field("snapshot_date", "scans", FieldDType.DATE, FieldSource.SYSTEM, FieldTier.SYSTEM),
    Field("strategy_ids", "scans", FieldDType.TEXT_ARRAY, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="Strategies that ran in this scan."),
    Field("total_stocks", "scans", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM),
    Field("opportunities_count", "scans", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM),
    Field("duration_seconds", "scans", FieldDType.DECIMAL, FieldSource.SYSTEM, FieldTier.SYSTEM,
          precision=(8, 2), unit="seconds"),
    Field("started_at", "scans", FieldDType.TIMESTAMP, FieldSource.SYSTEM, FieldTier.SYSTEM),
    Field("finished_at", "scans", FieldDType.TIMESTAMP, FieldSource.SYSTEM, FieldTier.SYSTEM),
    Field("created_at", "scans", FieldDType.TIMESTAMP, FieldSource.SYSTEM, FieldTier.SYSTEM),

    # ==================================================================
    # scan_results — one row per (scan_id, symbol, strategy_id) — Stage 6
    # ==================================================================
    Field("id", "scan_results", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False),
    Field("scan_id", "scan_results", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="FK -> scans.id (ON DELETE CASCADE)."),
    Field("stock_id", "scan_results", FieldDType.INT, FieldSource.SYSTEM, FieldTier.SYSTEM,
          notes="FK -> stocks.id."),
    Field("symbol", "scan_results", FieldDType.STR, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False),
    Field("strategy_id", "scan_results", FieldDType.STR, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False),
    Field("status", "scan_results", FieldDType.STR, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="BUY_ZONE|OPPORTUNITY|NO_SIGNAL|VALID|INVALID|PASS|FAIL|ERROR."),
    Field("score", "scan_results", FieldDType.DECIMAL, FieldSource.SYSTEM, FieldTier.SYSTEM,
          precision=(6, 2)),
    Field("best_score", "scan_results", FieldDType.DECIMAL, FieldSource.SYSTEM, FieldTier.SYSTEM,
          precision=(6, 2), notes="Same as score for single-strategy results; rollup for multi."),
    Field("reasons", "scan_results", FieldDType.JSONB, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="Human-readable trigger reasons."),
    Field("metrics_snapshot", "scan_results", FieldDType.JSONB, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="Exact input values consulted (audit)."),
    Field("fundamentals_check", "scan_results", FieldDType.JSONB, FieldSource.SYSTEM, FieldTier.SYSTEM,
          nullable=False, notes="Populated by fundamental screener; {} otherwise."),
    Field("created_at", "scan_results", FieldDType.TIMESTAMP, FieldSource.SYSTEM, FieldTier.SYSTEM),
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
# Immutable view — callers cannot mutate the registry at runtime.
FIELDS: Mapping[tuple[str, str], Field] = MappingProxyType(
    {(f.table, f.name): f for f in _FIELDS}
)


def get_field(name: str, table: Optional[str] = None) -> Field:
    """Return the ``Field`` record for ``name``.

    If ``table`` is supplied, the match must be exact. Otherwise, if the name
    is unique across the registry, that lone entry is returned; if it is
    ambiguous (e.g. ``symbol`` exists on multiple tables), a ``KeyError`` is
    raised so the caller is forced to disambiguate.
    """
    if table is not None:
        try:
            return FIELDS[(table, name)]
        except KeyError as exc:
            raise KeyError(f"No field '{name}' on table '{table}'.") from exc

    matches = [f for (t, n), f in FIELDS.items() if n == name]
    if not matches:
        raise KeyError(f"No field named '{name}' in the registry.")
    if len(matches) > 1:
        tables = sorted({f.table for f in matches})
        raise KeyError(
            f"Field '{name}' is ambiguous across tables {tables}; pass the table argument."
        )
    return matches[0]


def fields_for(table: str) -> tuple[Field, ...]:
    """Return every field defined for ``table`` in registry order."""
    return tuple(f for (t, _), f in FIELDS.items() if t == table)


def tables() -> tuple[str, ...]:
    """Return every table name present in the registry, in first-seen order."""
    seen: list[str] = []
    for (t, _) in FIELDS.keys():
        if t not in seen:
            seen.append(t)
    return tuple(seen)
