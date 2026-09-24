-- 020_watchlists.sql — named custom watchlists for the browser extension
-- and the web app (replaces the per-browser localStorage PlayArea list as
-- the place where ad-hoc chart-navigation lists live).
--
-- Contract:
--   * A watchlist is a NAME + an ordered list of symbols in yfinance form
--     ("TCS.NS"). Symbols need NOT be in the universe — these lists are
--     for navigating TradingView quickly, not for scans. Adding a symbol to
--     the PlayArea POOL still goes through /api/universe (source of truth).
--   * Personal data: RLS on, service_role only, no anon policy — the
--     FastAPI backend (X-Plutus-Auth owner token) is the only writer/reader.
--   * Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS watchlists (
    id             BIGSERIAL     PRIMARY KEY,
    name           VARCHAR(60)   NOT NULL,
    symbols        TEXT[]        NOT NULL DEFAULT '{}',
    display_order  INT           NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT watchlists_name_unique UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_watchlists_order ON watchlists (display_order, id);

DROP TRIGGER IF EXISTS trg_watchlists_touch ON watchlists;
CREATE TRIGGER trg_watchlists_touch
    BEFORE UPDATE ON watchlists
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- RLS: personal table — service_role only, anon denied entirely.
ALTER TABLE watchlists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS watchlists_service_write ON watchlists;
CREATE POLICY watchlists_service_write ON watchlists
    FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON watchlists TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Seed the four scratch lists the extension shows by default. Empty, and
-- only when the table is brand new (ON CONFLICT keeps user edits).
INSERT INTO watchlists (name, display_order) VALUES
    ('S1', 10), ('S2', 20), ('S3', 30), ('S4', 40)
ON CONFLICT (name) DO NOTHING;
