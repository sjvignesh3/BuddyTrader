-- =============================================================
-- 021_bank_fundamentals.sql -- Banks & NBFC fundamentals (2026-09-25)
-- =============================================================
-- Lenders cannot be scored on Net Debt/Equity, ROCE or "Sales near ATH":
-- those checks always fail for a bank, so the 11-check score dipped for
-- every Banks / NBFC stock. The strategy now branches on
-- stocks.sector_group and evaluates ROA, Gross NPA %, Net NPA % and a
-- trailing-twelve-month net profit floor instead.
--
-- Four idempotent columns on `fundamentals`, all filled by the quarterly
-- Screener sync (plutus/fundamentals/screener_page.py):
--   gross_npa_pct / net_npa_pct -- per quarter, from the #quarters table
--   total_assets                -- newest row, latest #balance-sheet column
--   roa                         -- newest row: Screener "Return on assets"
--                                  quick ratio when configured, else
--                                  TTM net profit / total assets * 100
-- Nothing is dropped; non-lender rows simply keep NULLs here.
-- =============================================================

ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS gross_npa_pct NUMERIC(6,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS net_npa_pct   NUMERIC(6,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS total_assets  NUMERIC(20,2);
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS roa           NUMERIC(6,2);

COMMENT ON COLUMN fundamentals.gross_npa_pct IS 'Screener #quarters Gross NPA % (lenders only)';
COMMENT ON COLUMN fundamentals.net_npa_pct   IS 'Screener #quarters Net NPA % (lenders only)';
COMMENT ON COLUMN fundamentals.total_assets  IS 'Latest balance-sheet Total Assets, absolute rupees (newest row only)';
COMMENT ON COLUMN fundamentals.roa           IS 'Return on assets %: quick ratio or TTM net profit / total assets (newest row only)';
