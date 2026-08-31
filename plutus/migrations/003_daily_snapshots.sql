-- =============================================================
-- 003_daily_snapshots.sql -- Tier A price-action data (daily 5 PM IST)
-- Source of truth: plutus/registry/fields.py (table='daily_snapshots')
-- =============================================================

CREATE TABLE IF NOT EXISTS daily_snapshots (
    id                          BIGSERIAL PRIMARY KEY,
    stock_id                    BIGINT       NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
    symbol                      VARCHAR(20)  NOT NULL,
    snapshot_date               DATE         NOT NULL,

    -- Raw OHLCV -----------------------------------------------------
    open                        NUMERIC(12,2),
    high                        NUMERIC(12,2),
    low                         NUMERIC(12,2),
    close                       NUMERIC(12,2),
    adj_close                   NUMERIC(12,2),
    volume                      BIGINT,

    -- Valuation -----------------------------------------------------
    market_cap                  NUMERIC(20,2),
    cap_bucket                  VARCHAR(10),
    pe_current                  NUMERIC(10,2),
    forward_pe                  NUMERIC(10,2),
    pb_current                  NUMERIC(10,2),
    debt_to_equity_pct          NUMERIC(8,4),
    ebitda_ttm                  NUMERIC(20,2),
    revenue_ttm                 NUMERIC(20,2),
    profit_margin_pct           NUMERIC(6,2),

    -- 52W / ATH / DMA ----------------------------------------------
    high_52w                    NUMERIC(12,2),
    low_52w                     NUMERIC(12,2),
    dma_200                     NUMERIC(12,2),
    below_200dma_pct            NUMERIC(6,2),
    ath                         NUMERIC(12,2),
    fall_from_ath_pct           NUMERIC(6,2),
    distance_from_52w_low_pct   NUMERIC(6,2),
    distance_from_52w_high_pct  NUMERIC(6,2),

    -- 20% Rally ----------------------------------------------------
    has_valid_20pct_rally       BOOLEAN,
    last_rally_pct              NUMERIC(6,2),
    last_rally_low              NUMERIC(12,2),
    last_rally_high             NUMERIC(12,2),
    last_rally_start_date       DATE,
    last_rally_end_date         DATE,
    days_since_last_rally       INT,

    -- Trend --------------------------------------------------------
    price_change_nd_pct         NUMERIC(6,2),

    -- Future-proof raw payload -------------------------------------
    raw_yf_meta                 JSONB        NOT NULL DEFAULT '{}'::jsonb,

    -- Stage 4: non-fatal pipeline warnings for that (symbol, date).
    errors_json                 JSONB        NOT NULL DEFAULT '[]'::jsonb,

    created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Natural key = (symbol, snapshot_date) — matches the worker's
    -- SNAPSHOT_CONFLICT constant so upserts are idempotent by symbol
    -- without needing the FK stock_id resolved first.
    CONSTRAINT daily_snapshots_unique_symbol UNIQUE (symbol, snapshot_date),
    CONSTRAINT daily_snapshots_unique_stock  UNIQUE (stock_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_snap_date   ON daily_snapshots (snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_snap_symbol ON daily_snapshots (symbol, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_snap_cap    ON daily_snapshots (cap_bucket, snapshot_date DESC);
