-- =============================================================
-- 029_fundamentals_pe_medians.sql -- P/E history on the fundamentals row
-- =============================================================
-- Source of truth: plutus/registry/fields.py (table='fundamentals'); the
-- same ALTERs are appended to 004_fundamentals.sql so a fresh database and
-- the registry test agree.
--
-- The quarterly Screener sync already downloads ten years of the weekly
-- "Price to Earning" chart to compute the 5-year MEAN the fundamental check
-- uses. From that same response it now also keeps:
--   * pe_median_3y / pe_median_5y / pe_median_10y  -- medians ignore the
--     bubble years a mean drags along
--   * pe_low_10y / pe_high_10y                      -- the 10-year range, so
--     the card can show where today's P/E sits in it
-- Display only (extension valuation box, Screener synthetic tiles): the scan
-- rules are unchanged. Newest quarter row only, like pe_5y_avg.
--
-- Deploy order: this migration is safe BEFORE the new backend (nullable
-- columns, nothing reads them until the code lands). Run the quarterly sync
-- once afterwards to fill them.
-- Idempotent: safe to re-run.
-- =============================================================

ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS pe_median_3y   NUMERIC(10,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS pe_median_5y   NUMERIC(10,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS pe_median_10y  NUMERIC(10,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS pe_low_10y     NUMERIC(10,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS pe_high_10y    NUMERIC(10,2);

COMMENT ON COLUMN fundamentals.pe_median_3y  IS 'median weekly P/E, last 3 years (screener.in chart) — display only';
COMMENT ON COLUMN fundamentals.pe_median_5y  IS 'median weekly P/E, last 5 years (screener.in chart) — display only';
COMMENT ON COLUMN fundamentals.pe_median_10y IS 'median weekly P/E, last 10 years (screener.in chart) — display only';
COMMENT ON COLUMN fundamentals.pe_low_10y    IS 'lowest positive weekly P/E, last 10 years';
COMMENT ON COLUMN fundamentals.pe_high_10y   IS 'highest weekly P/E, last 10 years';
