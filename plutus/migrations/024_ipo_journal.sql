-- =============================================================
-- 024_ipo_journal.sql -- IPO applications + their sell legs (Journal → IPOs tab)
-- =============================================================
-- Two tables:
--   * ipo_applications -- one row per application (per account). Holds what
--                         the owner types from the broker app (issue price,
--                         lot size, lots applied, allotment) plus the listing
--                         day prices, which the API fills from yfinance.
--   * ipo_sells        -- one row per sell of allotted shares (partial exits
--                         are several rows). Deleting an application deletes
--                         its sells.
--
-- Stage (applied / allotted / listed / holding / sold) and every gain, %,
-- days-held and money-locked figure are DERIVED at read time — never stored.
-- Charges are deliberately not tracked (profit = gross).
-- Written ONLY through the FastAPI journal endpoints (service_role);
-- anon has no access.
-- =============================================================

CREATE TABLE IF NOT EXISTS ipo_applications (
    id               BIGSERIAL     PRIMARY KEY,
    account          VARCHAR(30)   NOT NULL DEFAULT 'Self'
                       CHECK (length(btrim(account)) > 0),
    ipo_name         VARCHAR(80)   NOT NULL CHECK (length(btrim(ipo_name)) > 0),
    symbol           VARCHAR(20),               -- plain NSE symbol, known at listing
    apply_date       DATE          NOT NULL,
    issue_price      NUMERIC(12,2) NOT NULL CHECK (issue_price > 0),
    lot_size         INT           NOT NULL CHECK (lot_size > 0),
    lots_applied     INT           NOT NULL CHECK (lots_applied > 0),
    status           VARCHAR(12)   NOT NULL DEFAULT 'APPLIED'
                       CHECK (status IN ('APPLIED','ALLOTTED','NOT_ALLOTTED')),
    allotment_date   DATE,                      -- shares credited / money refunded
    shares_allotted  INT,
    listing_date     DATE,
    listing_open     NUMERIC(12,2) CHECK (listing_open > 0),
    listing_close    NUMERIC(12,2) CHECK (listing_close > 0),
    notes            TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    -- Only an ALLOTTED row carries shares, and never more than were bid for.
    CONSTRAINT ipo_applications_allotment_consistency CHECK (
        (status = 'ALLOTTED' AND shares_allotted > 0
            AND shares_allotted <= lots_applied * lot_size)
        OR (status <> 'ALLOTTED' AND shares_allotted IS NULL)
    ),
    CONSTRAINT ipo_applications_date_order CHECK (
        (allotment_date IS NULL OR allotment_date >= apply_date)
        AND (listing_date IS NULL OR listing_date >= apply_date)
    )
);

CREATE INDEX IF NOT EXISTS idx_ipo_apply_date ON ipo_applications (apply_date DESC);
CREATE INDEX IF NOT EXISTS idx_ipo_symbol     ON ipo_applications (symbol);

CREATE TABLE IF NOT EXISTS ipo_sells (
    id          BIGSERIAL     PRIMARY KEY,
    ipo_id      BIGINT        NOT NULL REFERENCES ipo_applications(id) ON DELETE CASCADE,
    sell_date   DATE          NOT NULL,
    sell_price  NUMERIC(12,2) NOT NULL CHECK (sell_price > 0),
    qty         INT           NOT NULL CHECK (qty > 0),
    notes       TEXT,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ipo_sells_ipo ON ipo_sells (ipo_id, sell_date);

-- updated_at touch triggers (function defined in 001).
DROP TRIGGER IF EXISTS trg_ipo_app_touch ON ipo_applications;
CREATE TRIGGER trg_ipo_app_touch
    BEFORE UPDATE ON ipo_applications
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

DROP TRIGGER IF EXISTS trg_ipo_sell_touch ON ipo_sells;
CREATE TRIGGER trg_ipo_sell_touch
    BEFORE UPDATE ON ipo_sells
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- RLS: service_role only (the FastAPI backend). anon: no policy = deny.
ALTER TABLE ipo_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ipo_sells        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ipo_app_service_write ON ipo_applications;
CREATE POLICY ipo_app_service_write ON ipo_applications
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ipo_sell_service_write ON ipo_sells;
CREATE POLICY ipo_sell_service_write ON ipo_sells
    FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON ipo_applications, ipo_sells TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
