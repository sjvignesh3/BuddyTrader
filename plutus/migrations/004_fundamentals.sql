-- =============================================================
-- 004_fundamentals.sql -- Tier B quarterly fundamentals
-- Source of truth: plutus/registry/fields.py (table='fundamentals')
-- =============================================================

CREATE TABLE IF NOT EXISTS fundamentals (
    id                        BIGSERIAL PRIMARY KEY,
    stock_id                  BIGINT       NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
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
