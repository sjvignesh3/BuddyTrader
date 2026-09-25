-- =============================================================
-- 004_fundamentals.sql -- Tier B quarterly fundamentals
-- Source of truth: plutus/registry/fields.py (table='fundamentals')
-- =============================================================

CREATE TABLE IF NOT EXISTS fundamentals (
    id                        BIGSERIAL PRIMARY KEY,
    -- Nullable by design (Plan §5.4): the quarterly worker upserts by
    -- (symbol, quarter_end_date) and does not resolve the FK first.
    stock_id                  BIGINT       REFERENCES stocks(id) ON DELETE CASCADE,
    symbol                    VARCHAR(20)  NOT NULL,
    quarter_end_date          DATE         NOT NULL,
    quarter_label             VARCHAR(20),

    -- Financials --------------------------------------------------
    sales                     NUMERIC(20,2),
    pbt                       NUMERIC(20,2),
    net_profit                NUMERIC(20,2),
    operating_margin_pct      NUMERIC(6,2),

    -- Shareholding & pledging ------------------------------------
    promoter_holding_pct      NUMERIC(6,2),
    institutional_pct         NUMERIC(6,2),
    public_holding_pct        NUMERIC(6,2),
    promoter_pledging_pct     NUMERIC(6,2),
    promoter_holding_source   VARCHAR(20)  NOT NULL DEFAULT 'yfinance',

    -- Quality metrics --------------------------------------------
    roce                      NUMERIC(6,2),
    roe                       NUMERIC(6,2),
    net_debt_to_equity        NUMERIC(8,4),

    -- Historical averages ----------------------------------------
    pe_5y_avg                 NUMERIC(10,2),
    pb_5y_avg                 NUMERIC(10,2),

    -- Raw payload + quality flags --------------------------------
    raw_yf_payload            JSONB        NOT NULL DEFAULT '{}'::jsonb,
    data_quality_flags        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    data_source               VARCHAR(20)  NOT NULL DEFAULT 'yfinance',
    fetched_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT fundamentals_unique UNIQUE (stock_id, quarter_end_date)
);

CREATE INDEX IF NOT EXISTS idx_fund_symbol_q ON fundamentals (symbol, quarter_end_date DESC);

-- ---------------------------------------------------------------
-- Idempotent evolution (safe to re-run against an existing DB).
-- The quarterly worker's ON CONFLICT tuple is (symbol, quarter_end_date)
-- (see plutus/sync/quarterly.py FUNDAMENTALS_CONFLICT) — it needs a
-- matching unique index or every upsert fails with 42P10.
-- ---------------------------------------------------------------
ALTER TABLE fundamentals ALTER COLUMN stock_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_fund_symbol_quarter
    ON fundamentals (symbol, quarter_end_date);
-- Views block ALTER TYPE on their columns; 009 recreates them.
DROP VIEW IF EXISTS v_fundamentals_latest;
ALTER TABLE fundamentals ALTER COLUMN operating_margin_pct TYPE NUMERIC(10,2);

-- Banks & NBFC quality metrics (added by 021_bank_fundamentals.sql; repeated
-- here so a fresh install gets them from this file and the registry test
-- sees every fundamentals column in one place).
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS gross_npa_pct NUMERIC(6,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS net_npa_pct   NUMERIC(6,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS total_assets  NUMERIC(20,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS roa           NUMERIC(6,2);
