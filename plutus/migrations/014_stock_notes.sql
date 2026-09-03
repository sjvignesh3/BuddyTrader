-- =============================================================
-- 014_stock_notes.sql -- Per-stock dated research notes
-- =============================================================
-- One row per note entry: the user's view on a stock at a point in
-- time, tracked over quarters/months/years and sorted by note_date.
-- Free-form TEXT (no length cap). Written ONLY through the FastAPI
-- journal endpoints (service_role); anon has no access.
-- =============================================================

CREATE TABLE IF NOT EXISTS journal_stock_notes (
    id          BIGSERIAL    PRIMARY KEY,
    symbol      VARCHAR(20)  NOT NULL,          -- plain NSE symbol (journal convention)
    note_date   DATE         NOT NULL DEFAULT CURRENT_DATE,
    content     TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jnote_symbol_date
    ON journal_stock_notes (symbol, note_date DESC);

-- updated_at touch trigger (function defined in 001).
DROP TRIGGER IF EXISTS trg_jnote_touch ON journal_stock_notes;
CREATE TRIGGER trg_jnote_touch
    BEFORE UPDATE ON journal_stock_notes
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- RLS: service_role only (the FastAPI backend). anon: no policy = deny.
ALTER TABLE journal_stock_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS jnote_service_write ON journal_stock_notes;
CREATE POLICY jnote_service_write ON journal_stock_notes
    FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON journal_stock_notes TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
