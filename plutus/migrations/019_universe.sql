-- =============================================================
-- 019_universe.sql -- The stock universe as the single source of truth
-- =============================================================
-- Until now the universe was seeded once from the master CSV and never
-- touched again. From here on the `stocks` table IS the universe: the
-- Universe page (Market Analysis → Universe) adds / edits / imports pool
-- members, every pool view, scan and journal lookup reads from it, and
-- the CSV seed becomes a one-time bootstrap only.
--
-- Three additions, all idempotent:
--   1. stocks.sector_group  — which S200 screening criteria set applies to
--      a stock: 'Banks' | 'NBFC' (ROE + Net profit) or 'Normal' (Net D/E +
--      ROCE + Net profit). The SECTOR is the key for the S200 rules, so it
--      is a first-class column, not a free-text sector string.
--   2. universe_syncs       — one row per change-set applied to a pool:
--      manual imports today, Screener screen previews/applies later. The
--      preview → consent → apply flow the S200 sync needs lives entirely in
--      this table (status 'preview' rows wait for the owner's confirmation),
--      so wiring the screen later is a worker, not a schema change.
--   3. pools.metadata.screen_criteria — the S200 thresholds shown on the
--      Universe page and used by the screen job, editable per quarter.
--
-- Journal safety: nothing here deletes a stock. Removing the last pool tag
-- only flips `active` (and the API keeps a stock active while the Trading
-- Journal still references it), so LTP for held positions keeps syncing.
-- =============================================================

-- ---------------------------------------------------------------
-- 1. stocks.sector_group
-- ---------------------------------------------------------------
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS sector_group VARCHAR(10);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'stocks_sector_group_check'
    ) THEN
        ALTER TABLE stocks ADD CONSTRAINT stocks_sector_group_check
            CHECK (sector_group IS NULL OR sector_group IN ('Banks', 'NBFC', 'Normal'));
    END IF;
END $$;

-- Backfill from the labels the CSV seed left in `sector`:
--   S200-only rows carried 'Normal' / 'NBFC' / 'Banks' in that column, the
--   curated F40/E40 rows carry real sector names ('BANKS', 'NON-BANKING',
--   'NON-BANKING-AMC', 'NON-BANKING-Insurance', 'FINANCIAL SERVICES', ...).
-- Only unambiguous labels are mapped; anything financial-but-unclear stays
-- NULL for the owner to set on the Universe page.
UPDATE stocks SET sector_group = 'Banks'
 WHERE sector_group IS NULL AND upper(coalesce(sector, '')) IN ('BANKS', 'BANK');
UPDATE stocks SET sector_group = 'NBFC'
 WHERE sector_group IS NULL AND upper(coalesce(sector, '')) IN ('NBFC', 'NON-BANKING');
UPDATE stocks SET sector_group = 'Normal'
 WHERE sector_group IS NULL
   AND sector IS NOT NULL
   AND (upper(sector) = 'NORMAL'
        OR upper(sector) LIKE 'NON-BANKING-%'          -- AMC / Insurance: Normal rules
        OR (upper(sector) NOT LIKE '%BANK%'
            AND upper(sector) NOT LIKE '%FINANC%'
            AND upper(sector) NOT LIKE '%NBFC%'));

-- 'Normal' was never a sector — it was the criteria label. Clear it so the
-- Sector column shows a dash instead of a misleading word.
UPDATE stocks SET sector = NULL WHERE sector = 'Normal';

-- Cap type: the CSV said 'Large Cap' / '#N/A'; the rest of Plutus (snapshots,
-- journal) says 'Large' | 'Mid' | 'Small' | 'Micro'. One vocabulary.
UPDATE stocks SET cap_type_manual = NULL
 WHERE cap_type_manual IS NOT NULL AND upper(cap_type_manual) IN ('#N/A', 'N/A', 'NA', '');
UPDATE stocks SET cap_type_manual = initcap(regexp_replace(cap_type_manual, '\s*[Cc]ap$', ''))
 WHERE cap_type_manual ~* '\s*cap$';

CREATE INDEX IF NOT EXISTS idx_stocks_sector_group ON stocks (sector_group);

-- ---------------------------------------------------------------
-- 2. universe_syncs — audit + consent queue for pool change-sets
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS universe_syncs (
    id            BIGSERIAL    PRIMARY KEY,
    pool_code     VARCHAR(20)  NOT NULL REFERENCES pools(code),
    -- 'import' (CSV/manual bulk), 'screen' (Screener.in quantitative screen)
    kind          VARCHAR(20)  NOT NULL CHECK (kind IN ('import', 'screen')),
    -- running  : worker still computing the candidate list (screen only)
    -- preview  : diff computed, waiting for the owner's consent
    -- applied  : diff written to `stocks`
    -- discarded: owner rejected the preview
    -- failed   : worker error (see `error`)
    status        VARCHAR(12)  NOT NULL DEFAULT 'preview'
                    CHECK (status IN ('running', 'preview', 'applied', 'discarded', 'failed')),
    mode          VARCHAR(10)  NOT NULL DEFAULT 'merge' CHECK (mode IN ('merge', 'replace')),
    -- The thresholds / query the change-set was computed with (screen), or
    -- the import's column mapping — so a row is reproducible later.
    criteria      JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- {added:[..], removed:[..], updated:[..], unchanged:n, excluded:[{symbol,reason}]}
    diff          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- Screen candidates with the metrics they were judged on (audit).
    candidates    JSONB        NOT NULL DEFAULT '[]'::jsonb,
    error         TEXT,
    triggered_by  VARCHAR(20)  NOT NULL DEFAULT 'owner',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    applied_at    TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usync_pool_created
    ON universe_syncs (pool_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usync_status
    ON universe_syncs (status);

-- updated_at touch trigger (function defined in 001).
DROP TRIGGER IF EXISTS trg_usync_touch ON universe_syncs;
CREATE TRIGGER trg_usync_touch
    BEFORE UPDATE ON universe_syncs
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- RLS: service_role only (the FastAPI backend). anon: no policy = deny.
ALTER TABLE universe_syncs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usync_service_write ON universe_syncs;
CREATE POLICY usync_service_write ON universe_syncs
    FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON universe_syncs TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ---------------------------------------------------------------
-- 3. S200 screen criteria (editable per quarter from the Universe page)
-- ---------------------------------------------------------------
-- Non-banking : Net Debt to Equity < 0.25 AND ROCE > 12 AND Net profit > 200 Cr
-- Banks & NBFC: ROE > 10 AND Net profit > 1000 Cr
-- Stored as strings so no float ever touches a threshold.
UPDATE pools
   SET metadata = metadata || jsonb_build_object(
        'screen_criteria', jsonb_build_object(
            'normal', jsonb_build_object(
                'net_debt_to_equity_max', '0.25',
                'roce_min',               '12',
                'net_profit_min_cr',      '200'),
            'banks_nbfc', jsonb_build_object(
                'roe_min',                '10',
                'net_profit_min_cr',      '1000'),
            'updated_at', to_jsonb(now())))
 WHERE code = 'S200'
   AND NOT (metadata ? 'screen_criteria');
