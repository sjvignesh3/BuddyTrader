-- =============================================================
-- 030_fundamentals_leverage.sql -- leverage inputs on the fundamentals row
-- =============================================================
-- Source of truth: plutus/registry/fields.py (table='fundamentals'); the
-- same ALTERs are appended to 004_fundamentals.sql.
--
-- The quarterly Screener sync already has the company page. From its
-- #profit-loss (TTM column) and #balance-sheet (latest column) it now keeps:
--   * operating_profit_ttm  -- Screener's "Operating Profit" = EBITDA
--   * depreciation_ttm
--   * interest_ttm
--   * borrowings            -- gross debt (cash sits in an Ajax schedule the
--                              page does not carry, so no net debt)
-- all in absolute rupees like `sales`. The API derives, in Decimal:
--   interest coverage = (operating_profit_ttm − depreciation_ttm) / interest_ttm
--   debt / EBITDA     = borrowings / operating_profit_ttm
-- Display only (extension card + Screener tiles); the scan rules are unchanged.
-- Newest quarter row only. Nullable; safe before the new backend. Run the
-- quarterly sync once afterwards. Idempotent.
-- =============================================================

ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS operating_profit_ttm NUMERIC(20,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS depreciation_ttm     NUMERIC(20,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS interest_ttm         NUMERIC(20,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS borrowings           NUMERIC(20,2);

COMMENT ON COLUMN fundamentals.operating_profit_ttm IS 'Screener P&L Operating Profit (EBITDA), TTM, ₹ — display only';
COMMENT ON COLUMN fundamentals.depreciation_ttm     IS 'Screener P&L Depreciation, TTM, ₹';
COMMENT ON COLUMN fundamentals.interest_ttm         IS 'Screener P&L Interest, TTM, ₹';
COMMENT ON COLUMN fundamentals.borrowings           IS 'Screener balance sheet Borrowings, latest, ₹ (gross debt)';
