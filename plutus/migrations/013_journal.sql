-- =============================================================
-- 013_journal.sql -- Trading Journal (personal tool)
-- =============================================================
-- Three tables:
--   * journal_settings       -- single row: trading capital (manual).
--   * journal_opportunities  -- watch/plan list (may convert to a trade).
--   * journal_trades         -- executed buys; OPEN until sold, CLOSED after.
--     Partial booking = the open row is split (sold qty becomes a CLOSED
--     row, remaining qty stays OPEN).
--
-- All derived values (LTP, allocation %, gains, ATH distance) are computed
-- at read time from daily_snapshots + capital — never persisted here.
-- Written ONLY through the FastAPI journal endpoints (service_role);
-- anon has no access.
-- =============================================================

CREATE TABLE IF NOT EXISTS journal_settings (
    id          SMALLINT      PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    capital     NUMERIC(14,2) NOT NULL DEFAULT 300000 CHECK (capital > 0),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO journal_settings (id, capital)
VALUES (1, 300000)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS journal_opportunities (
    id            BIGSERIAL     PRIMARY KEY,
    opp_date      DATE,
    symbol        VARCHAR(20)   NOT NULL,
    cap_bucket    VARCHAR(10)   CHECK (cap_bucket IN ('Large','Mid','Small','Micro')),
    buy_price     NUMERIC(12,2),
    limit_price   NUMERIC(12,2),
    qty           INT,
    strategy      VARCHAR(60),
    target_price  NUMERIC(12,2),
    action_filter VARCHAR(20)   CHECK (action_filter IN ('Buy Now','GTT','Analyse Now','Later')),
    notes         TEXT,
    status        VARCHAR(12)   NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','CONVERTED','DROPPED')),
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jopp_symbol ON journal_opportunities (symbol);
CREATE INDEX IF NOT EXISTS idx_jopp_status ON journal_opportunities (status);

CREATE TABLE IF NOT EXISTS journal_trades (
    id             BIGSERIAL     PRIMARY KEY,
    opportunity_id BIGINT        REFERENCES journal_opportunities(id) ON DELETE SET NULL,
    order_type     VARCHAR(10)   CHECK (order_type IN ('GTT','Instant')),
    cap_bucket     VARCHAR(10)   CHECK (cap_bucket IN ('Large','Mid','Small','Micro')),
    symbol         VARCHAR(20)   NOT NULL,
    buy_date       DATE          NOT NULL,
    buy_price      NUMERIC(12,2) NOT NULL CHECK (buy_price > 0),
    qty            INT           NOT NULL CHECK (qty > 0),
    strategy       VARCHAR(60),
    target_price   NUMERIC(12,2),
    status         VARCHAR(10)   NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN','CLOSED')),
    close_label    VARCHAR(20),   -- 'Fully Booked' | 'Partially Booked' | 'Stop Loss' ...
    sell_date      DATE,
    sell_price     NUMERIC(12,2),
    comments       TEXT,
    risk_notes     TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    -- A CLOSED row must carry its exit; an OPEN row must not.
    CONSTRAINT journal_trades_exit_consistency CHECK (
        (status = 'CLOSED' AND sell_date IS NOT NULL AND sell_price IS NOT NULL)
        OR (status = 'OPEN' AND sell_date IS NULL AND sell_price IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_jtrade_symbol_status ON journal_trades (symbol, status);
CREATE INDEX IF NOT EXISTS idx_jtrade_status        ON journal_trades (status);

-- updated_at touch triggers (function defined in 001).
DROP TRIGGER IF EXISTS trg_jset_touch ON journal_settings;
CREATE TRIGGER trg_jset_touch
    BEFORE UPDATE ON journal_settings
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

DROP TRIGGER IF EXISTS trg_jopp_touch ON journal_opportunities;
CREATE TRIGGER trg_jopp_touch
    BEFORE UPDATE ON journal_opportunities
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

DROP TRIGGER IF EXISTS trg_jtrade_touch ON journal_trades;
CREATE TRIGGER trg_jtrade_touch
    BEFORE UPDATE ON journal_trades
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- RLS: service_role only (the FastAPI backend). anon: no policy = deny.
ALTER TABLE journal_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_trades        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS jset_service_write ON journal_settings;
CREATE POLICY jset_service_write ON journal_settings
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS jopp_service_write ON journal_opportunities;
CREATE POLICY jopp_service_write ON journal_opportunities
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS jtrade_service_write ON journal_trades;
CREATE POLICY jtrade_service_write ON journal_trades
    FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE
    ON journal_settings, journal_opportunities, journal_trades
    TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
