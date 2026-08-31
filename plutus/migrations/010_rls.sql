-- =============================================================
-- 010_rls.sql — Row Level Security baseline (Stage 7)
-- =============================================================
-- Deferred from Stage 4/5 per Plutus_Phased_Development.MD.
--
-- Contract:
--   * service_role: FULL read + write on every Plutus table. Used only by the
--                   Python sync worker, quarterly worker, and scan engine.
--   * anon:         READ-ONLY on read tables and views. NO write access
--                   anywhere. Frontend uses the anon key exclusively.
--   * trades:       Writable only by authenticated admin (auth JWT).
--                   Wired in Stage 8 when the journal UI lands.
--
-- Idempotent: safe to re-apply. Every policy is dropped before recreation.
-- =============================================================

-- Enable RLS on every persistent table. Views inherit from their base tables.
ALTER TABLE stocks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE pools            ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fundamentals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans            ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_results     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_jobs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades           ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------
-- Helper: anon-read + service-write policy pair for read tables.
-- -----------------------------------------------------------------

-- stocks -----------------------------------------------------------
DROP POLICY IF EXISTS stocks_anon_read     ON stocks;
DROP POLICY IF EXISTS stocks_service_write ON stocks;
CREATE POLICY stocks_anon_read     ON stocks     FOR SELECT TO anon         USING (true);
CREATE POLICY stocks_service_write ON stocks     FOR ALL    TO service_role USING (true) WITH CHECK (true);

-- pools ------------------------------------------------------------
DROP POLICY IF EXISTS pools_anon_read     ON pools;
DROP POLICY IF EXISTS pools_service_write ON pools;
CREATE POLICY pools_anon_read     ON pools      FOR SELECT TO anon         USING (true);
CREATE POLICY pools_service_write ON pools      FOR ALL    TO service_role USING (true) WITH CHECK (true);

-- daily_snapshots --------------------------------------------------
DROP POLICY IF EXISTS ds_anon_read     ON daily_snapshots;
DROP POLICY IF EXISTS ds_service_write ON daily_snapshots;
CREATE POLICY ds_anon_read     ON daily_snapshots FOR SELECT TO anon         USING (true);
CREATE POLICY ds_service_write ON daily_snapshots FOR ALL    TO service_role USING (true) WITH CHECK (true);

-- fundamentals -----------------------------------------------------
DROP POLICY IF EXISTS fund_anon_read     ON fundamentals;
DROP POLICY IF EXISTS fund_service_write ON fundamentals;
CREATE POLICY fund_anon_read     ON fundamentals FOR SELECT TO anon         USING (true);
CREATE POLICY fund_service_write ON fundamentals FOR ALL    TO service_role USING (true) WITH CHECK (true);

-- strategy_configs -------------------------------------------------
DROP POLICY IF EXISTS sc_anon_read     ON strategy_configs;
DROP POLICY IF EXISTS sc_service_write ON strategy_configs;
CREATE POLICY sc_anon_read     ON strategy_configs FOR SELECT TO anon         USING (true);
CREATE POLICY sc_service_write ON strategy_configs FOR ALL    TO service_role USING (true) WITH CHECK (true);

-- scans ------------------------------------------------------------
DROP POLICY IF EXISTS scans_anon_read     ON scans;
DROP POLICY IF EXISTS scans_service_write ON scans;
CREATE POLICY scans_anon_read     ON scans      FOR SELECT TO anon         USING (true);
CREATE POLICY scans_service_write ON scans      FOR ALL    TO service_role USING (true) WITH CHECK (true);

-- scan_results -----------------------------------------------------
DROP POLICY IF EXISTS sr_anon_read     ON scan_results;
DROP POLICY IF EXISTS sr_service_write ON scan_results;
CREATE POLICY sr_anon_read     ON scan_results FOR SELECT TO anon         USING (true);
CREATE POLICY sr_service_write ON scan_results FOR ALL    TO service_role USING (true) WITH CHECK (true);

-- sync_jobs --------------------------------------------------------
DROP POLICY IF EXISTS sj_anon_read     ON sync_jobs;
DROP POLICY IF EXISTS sj_service_write ON sync_jobs;
CREATE POLICY sj_anon_read     ON sync_jobs  FOR SELECT TO anon         USING (true);
CREATE POLICY sj_service_write ON sync_jobs  FOR ALL    TO service_role USING (true) WITH CHECK (true);

-- trades -----------------------------------------------------------
-- Anon: NO access at all (no policy = deny). service_role: full access.
-- Authenticated admin write policies are added in Stage 8 with the journal.
DROP POLICY IF EXISTS trades_service_write ON trades;
CREATE POLICY trades_service_write ON trades  FOR ALL    TO service_role USING (true) WITH CHECK (true);

-- =============================================================
-- Verification (non-destructive): count policies per table.
-- Run after applying to confirm the expected policy set.
-- =============================================================
-- SELECT tablename, COUNT(*) AS policies FROM pg_policies
--  WHERE schemaname='public' GROUP BY tablename ORDER BY tablename;
