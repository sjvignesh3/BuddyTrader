-- =============================================================
-- 017_net_worth.sql -- Net Worth / Portfolio dashboard (personal tool)
-- =============================================================
-- Plutus already stores the equity side (journal_trades × daily_snapshots)
-- and spending (expenses). This migration adds ONLY what nothing else
-- holds:
--   networth_assets       manual, non-journal assets (cash, FD, MF, gold,
--                         EPF/PPF, real estate, ...). Current value is
--                         user-entered with an as_of_date; cost basis is
--                         optional (gain shown only where it exists).
--   networth_liabilities  debts (loans, credit cards) with EMI / rate.
--   networth_snapshots    one row per MONTH — the historical record of the
--                         financial position when "Take Snapshot" ran.
--                         snapshot_date is normalised to the 1st of the
--                         month and is UNIQUE, so re-taking a snapshot in
--                         the same month overwrites it (idempotent).
--                         `breakdown` keeps the allocation as it was.
--   networth_income       manual monthly take-home income (UNIQUE month)
--                         — Plutus has no reliable income source, so the
--                         savings rate needs this one number per month.
--   networth_milestones   user-defined net-worth goals (₹10L, ₹1Cr...).
--   networth_settings     single row: financial-freedom calculator inputs.
--
-- Live net worth (equity + assets − liabilities), allocation %, XIRR,
-- runway, savings rate and insights are DERIVED at read time and never
-- persisted — only the monthly snapshot is a genuine historical record.
--
-- Written ONLY through the FastAPI endpoints (service_role); anon has no
-- access. Money is NUMERIC (FLOAT banned, see README).
-- =============================================================

-- ---- Assets -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS networth_assets (
    id            BIGSERIAL     PRIMARY KEY,
    name          VARCHAR(120)  NOT NULL,
    asset_class   VARCHAR(20)   NOT NULL
                  CHECK (asset_class IN ('Cash','FD','Mutual Fund','Direct Stocks','Gold',
                                         'EPF/PPF','Real Estate','Crypto','Bonds','Other')),
    institution   VARCHAR(120),
    current_value NUMERIC(16,2) NOT NULL CHECK (current_value >= 0),
    cost_basis    NUMERIC(16,2) CHECK (cost_basis IS NULL OR cost_basis >= 0),
    as_of_date    DATE          NOT NULL DEFAULT CURRENT_DATE,
    notes         TEXT,
    archived      BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nwasset_class ON networth_assets (asset_class);

DROP TRIGGER IF EXISTS trg_nwasset_touch ON networth_assets;
CREATE TRIGGER trg_nwasset_touch
    BEFORE UPDATE ON networth_assets
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- ---------------------------------------------------------------
-- Idempotent evolution (safe to re-run against an existing DB).
-- 1) 'Direct Stocks' joined the asset classes after the first
--    release: shares held straight in a broker account were being
--    logged as 'Other', which hid them from the equity-exposure
--    read. CREATE TABLE IF NOT EXISTS leaves an existing table's
--    CHECK untouched, so swap the (Postgres-named) constraint here;
--    the list MUST match the inline CHECK above — the test gate
--    compares them. Existing 'Other' rows are not reclassified:
--    Plutus cannot know which of them are shares.
-- ---------------------------------------------------------------
ALTER TABLE networth_assets
    DROP CONSTRAINT IF EXISTS networth_assets_asset_class_check;
ALTER TABLE networth_assets
    ADD CONSTRAINT networth_assets_asset_class_check
    CHECK (asset_class IN ('Cash','FD','Mutual Fund','Direct Stocks','Gold',
                           'EPF/PPF','Real Estate','Crypto','Bonds','Other'));

-- ---- Liabilities -------------------------------------------------------

CREATE TABLE IF NOT EXISTS networth_liabilities (
    id            BIGSERIAL     PRIMARY KEY,
    name          VARCHAR(120)  NOT NULL,
    kind          VARCHAR(20)   NOT NULL
                  CHECK (kind IN ('Home Loan','Personal Loan','Car Loan','Credit Card','Other')),
    outstanding   NUMERIC(16,2) NOT NULL CHECK (outstanding >= 0),
    interest_rate NUMERIC(6,2)  CHECK (interest_rate IS NULL OR interest_rate >= 0),
    emi           NUMERIC(12,2) CHECK (emi IS NULL OR emi >= 0),
    notes         TEXT,
    archived      BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_nwliab_touch ON networth_liabilities;
CREATE TRIGGER trg_nwliab_touch
    BEFORE UPDATE ON networth_liabilities
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- ---- Monthly snapshots ---------------------------------------------------

CREATE TABLE IF NOT EXISTS networth_snapshots (
    id                BIGSERIAL     PRIMARY KEY,
    snapshot_date     DATE          NOT NULL,   -- always the 1st of the month
    equity_value      NUMERIC(16,2) NOT NULL DEFAULT 0,
    assets_value      NUMERIC(16,2) NOT NULL DEFAULT 0,
    liabilities_value NUMERIC(16,2) NOT NULL DEFAULT 0,
    net_worth         NUMERIC(16,2) NOT NULL,
    -- {"equity": "…", "assets": {"Cash": "…", ...}, "liabilities": {...}}
    breakdown         JSONB         NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT networth_snapshots_month_unique UNIQUE (snapshot_date),
    CONSTRAINT networth_snapshots_first_of_month
        CHECK (EXTRACT(DAY FROM snapshot_date) = 1)
);

CREATE INDEX IF NOT EXISTS idx_nwsnap_date ON networth_snapshots (snapshot_date DESC);

-- ---- Monthly income ------------------------------------------------------

CREATE TABLE IF NOT EXISTS networth_income (
    id          BIGSERIAL     PRIMARY KEY,
    month       DATE          NOT NULL,          -- always the 1st of the month
    amount      NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
    notes       TEXT,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT networth_income_month_unique UNIQUE (month),
    CONSTRAINT networth_income_first_of_month CHECK (EXTRACT(DAY FROM month) = 1)
);

DROP TRIGGER IF EXISTS trg_nwincome_touch ON networth_income;
CREATE TRIGGER trg_nwincome_touch
    BEFORE UPDATE ON networth_income
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- ---- Milestones ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS networth_milestones (
    id           BIGSERIAL     PRIMARY KEY,
    label        VARCHAR(60)   NOT NULL,
    target       NUMERIC(16,2) NOT NULL CHECK (target > 0),
    achieved_on  DATE,                           -- set when net worth first crosses it
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_nwmile_touch ON networth_milestones;
CREATE TRIGGER trg_nwmile_touch
    BEFORE UPDATE ON networth_milestones
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- ---- Settings (financial-freedom calculator inputs) -----------------------

CREATE TABLE IF NOT EXISTS networth_settings (
    id                 SMALLINT      PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    ff_target_corpus   NUMERIC(16,2) CHECK (ff_target_corpus IS NULL OR ff_target_corpus > 0),
    ff_real_return_pct NUMERIC(5,2)  NOT NULL DEFAULT 6 CHECK (ff_real_return_pct >= 0),
    ff_monthly_savings NUMERIC(14,2) CHECK (ff_monthly_savings IS NULL OR ff_monthly_savings >= 0),
    updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO networth_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_nwset_touch ON networth_settings;
CREATE TRIGGER trg_nwset_touch
    BEFORE UPDATE ON networth_settings
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- ---- RLS: service_role only (the FastAPI backend); anon: no policy = deny.

ALTER TABLE networth_assets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE networth_liabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE networth_snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE networth_income      ENABLE ROW LEVEL SECURITY;
ALTER TABLE networth_milestones  ENABLE ROW LEVEL SECURITY;
ALTER TABLE networth_settings    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nwasset_service_write ON networth_assets;
CREATE POLICY nwasset_service_write ON networth_assets
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS nwliab_service_write ON networth_liabilities;
CREATE POLICY nwliab_service_write ON networth_liabilities
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS nwsnap_service_write ON networth_snapshots;
CREATE POLICY nwsnap_service_write ON networth_snapshots
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS nwincome_service_write ON networth_income;
CREATE POLICY nwincome_service_write ON networth_income
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS nwmile_service_write ON networth_milestones;
CREATE POLICY nwmile_service_write ON networth_milestones
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS nwset_service_write ON networth_settings;
CREATE POLICY nwset_service_write ON networth_settings
    FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON networth_assets, networth_liabilities,
    networth_snapshots, networth_income, networth_milestones, networth_settings
    TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
