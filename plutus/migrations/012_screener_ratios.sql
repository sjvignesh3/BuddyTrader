-- =============================================================
-- 012_screener_ratios.sql — Weekly Screener.in valuation ratios
-- =============================================================
-- Source decision (2026-09-01): PE / PB / Market Cap come from
-- Screener.in, refreshed WEEKLY (Saturday 05:00 IST workflow).
-- The daily sync stamps these latest values into each day's
-- daily_snapshots row (pe_current / pb_current / market_cap), so
-- scans compare Screener PE against Screener 5Y-avg PE — the
-- same-source rule legacy Buddy enforced.
--
-- One row per symbol, overwritten weekly. NUMERIC only.
-- =============================================================

CREATE TABLE IF NOT EXISTS screener_ratios (
    symbol         VARCHAR(20) PRIMARY KEY,
    market_cap     NUMERIC(20,2),      -- ABSOLUTE rupees (page prints ₹ Cr)
    pe             NUMERIC(10,2),      -- Screener "Stock P/E"
    pb             NUMERIC(10,2),      -- Current Price / Book Value
    current_price  NUMERIC(12,2),
    book_value     NUMERIC(12,2),
    raw_ratios     JSONB        NOT NULL DEFAULT '{}'::jsonb,
    fetched_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_screener_ratios_touch ON screener_ratios;
CREATE TRIGGER trg_screener_ratios_touch
    BEFORE UPDATE ON screener_ratios
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- RLS: anon read, service write (same baseline as every read table).
ALTER TABLE screener_ratios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ratios_anon_read     ON screener_ratios;
DROP POLICY IF EXISTS ratios_service_write ON screener_ratios;
CREATE POLICY ratios_anon_read     ON screener_ratios FOR SELECT TO anon         USING (true);
CREATE POLICY ratios_service_write ON screener_ratios FOR ALL    TO service_role USING (true) WITH CHECK (true);

-- Explicit privileges (newer Supabase no longer auto-grants — see 010).
GRANT SELECT ON screener_ratios TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON screener_ratios TO service_role;
