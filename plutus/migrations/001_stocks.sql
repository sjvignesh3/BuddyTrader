-- =============================================================
-- 001_stocks.sql -- Universe table
-- Source of truth: plutus/registry/fields.py (table='stocks')
-- =============================================================

CREATE TABLE IF NOT EXISTS stocks (
    id                BIGSERIAL PRIMARY KEY,
    symbol            VARCHAR(20)  NOT NULL,
    name              VARCHAR(255),
    sector            VARCHAR(100),
    industry          VARCHAR(150),
    exchange          VARCHAR(10)  NOT NULL DEFAULT 'NSE',
    active            BOOLEAN      NOT NULL DEFAULT TRUE,
    pools             TEXT[]       NOT NULL DEFAULT '{}',
    cap_type_manual   VARCHAR(20),
    metadata          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT stocks_symbol_unique UNIQUE (symbol)
);

CREATE INDEX IF NOT EXISTS idx_stocks_pools  ON stocks USING GIN (pools);
CREATE INDEX IF NOT EXISTS idx_stocks_symbol ON stocks (symbol);
CREATE INDEX IF NOT EXISTS idx_stocks_active ON stocks (active);

-- updated_at trigger --------------------------------------------------
CREATE OR REPLACE FUNCTION plutus_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stocks_touch ON stocks;
CREATE TRIGGER trg_stocks_touch
    BEFORE UPDATE ON stocks
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- ---------------------------------------------------------------
-- Idempotent evolution (safe to re-run against an existing DB).
-- 019_universe.sql: which S200 screening criteria set applies —
-- 'Banks' | 'NBFC' (ROE + Net profit) or 'Normal' (Net D/E + ROCE +
-- Net profit). NULL = not classified yet. The CHECK constraint, the
-- backfill and the index live in 019.
-- ---------------------------------------------------------------
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS sector_group VARCHAR(10);
