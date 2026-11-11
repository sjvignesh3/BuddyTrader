-- =============================================================
-- 027_journal_markets.sql -- US market, phase 2: the Trading Journal
--                            (opportunities, trades, portfolio) per market
-- =============================================================
-- The journal stores PLAIN symbols ('TCS', not 'TCS.NS'), so a symbol alone
-- cannot say which market a row belongs to — and a US ticker may spell the
-- same as an NSE symbol. Every journal table therefore gets a `market`
-- column ('IN' | 'US'). It defaults to 'IN', so every existing row and every
-- existing write keeps working unchanged.
--
--   * journal_opportunities / journal_trades / journal_stock_notes /
--     sizing_plans                      -> + market
--   * journal_settings                  -> + capital_usd (the US capital; the
--     existing `capital` stays the Indian capital in rupees). NULL = not set.
--   * journal_opportunities.qty / journal_trades.qty: INT -> NUMERIC(14,4).
--     US brokers used from India sell fractional shares. Indian rows must
--     still be whole numbers (CHECK below), so nothing changes for them.
--
-- Money is never converted: a US row's prices are dollars, an Indian row's
-- are rupees, and the two are never added together.
--
-- Written ONLY through the FastAPI journal endpoints (service_role).
-- Idempotent: safe to re-run.
-- =============================================================

ALTER TABLE journal_opportunities ADD COLUMN IF NOT EXISTS market VARCHAR(2) NOT NULL DEFAULT 'IN';
ALTER TABLE journal_trades        ADD COLUMN IF NOT EXISTS market VARCHAR(2) NOT NULL DEFAULT 'IN';
ALTER TABLE journal_stock_notes   ADD COLUMN IF NOT EXISTS market VARCHAR(2) NOT NULL DEFAULT 'IN';
ALTER TABLE sizing_plans          ADD COLUMN IF NOT EXISTS market VARCHAR(2) NOT NULL DEFAULT 'IN';

ALTER TABLE journal_settings ADD COLUMN IF NOT EXISTS capital_usd NUMERIC(14,2);

-- Fractional quantities (no-op on a re-run: the type is already NUMERIC).
ALTER TABLE journal_opportunities ALTER COLUMN qty TYPE NUMERIC(14,4);
ALTER TABLE journal_trades        ALTER COLUMN qty TYPE NUMERIC(14,4);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_opportunities_market_check') THEN
        ALTER TABLE journal_opportunities ADD CONSTRAINT journal_opportunities_market_check
            CHECK (market IN ('IN', 'US'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_trades_market_check') THEN
        ALTER TABLE journal_trades ADD CONSTRAINT journal_trades_market_check
            CHECK (market IN ('IN', 'US'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_stock_notes_market_check') THEN
        ALTER TABLE journal_stock_notes ADD CONSTRAINT journal_stock_notes_market_check
            CHECK (market IN ('IN', 'US'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sizing_plans_market_check') THEN
        ALTER TABLE sizing_plans ADD CONSTRAINT sizing_plans_market_check
            CHECK (market IN ('IN', 'US'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_settings_capital_usd_check') THEN
        ALTER TABLE journal_settings ADD CONSTRAINT journal_settings_capital_usd_check
            CHECK (capital_usd IS NULL OR capital_usd > 0);
    END IF;
    -- Indian shares trade in whole numbers; only US rows may be fractional.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_trades_in_whole_qty') THEN
        ALTER TABLE journal_trades ADD CONSTRAINT journal_trades_in_whole_qty
            CHECK (market <> 'IN' OR qty = trunc(qty));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_opportunities_in_whole_qty') THEN
        ALTER TABLE journal_opportunities ADD CONSTRAINT journal_opportunities_in_whole_qty
            CHECK (market <> 'IN' OR qty IS NULL OR qty = trunc(qty));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_jtrade_market_status ON journal_trades (market, status);
CREATE INDEX IF NOT EXISTS idx_jopp_market_status   ON journal_opportunities (market, status);
CREATE INDEX IF NOT EXISTS idx_jnote_market_symbol  ON journal_stock_notes (market, symbol);

-- Stock notes written on a US stock page before this migration were saved
-- with the plain ticker and now default to 'IN'. Re-tag the ones whose
-- symbol is a US stock and is NOT also an Indian one.
UPDATE journal_stock_notes n
   SET market = 'US'
 WHERE n.market = 'IN'
   AND EXISTS (SELECT 1 FROM stocks s
                WHERE s.symbol = n.symbol AND s.symbol !~* '\.(NS|BO)$')
   AND NOT EXISTS (SELECT 1 FROM stocks s
                    WHERE s.symbol ~* '\.(NS|BO)$'
                      AND regexp_replace(s.symbol, '\.(NS|BO)$', '', 'i') = n.symbol);
