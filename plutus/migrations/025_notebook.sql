-- =============================================================
-- 025_notebook.sql -- Notes page: tasks, targets/limits, watch ideas,
--                     free notes and Plutus change ideas in ONE list
-- =============================================================
-- One table, one row per item. `kind` is the only thing that separates a
-- task from a target or a note — there are no boards, groups or tags.
--   TASK    -- something to do (checkbox, optional due date)
--   TARGET  -- a price target / stop, or a personal rule (max trades, monthly %)
--   WATCH   -- a stock being waited on, with the reason
--   NOTE    -- anything free-form
--   PLUTUS  -- a change or idea for Plutus itself (checkbox)
--
-- `market` (IN / US / NULL) tags an item so the page can filter by market.
-- `symbol` is free text: an NSE symbol for IN, a US ticker for US — it is
-- never validated against `stocks`, because the universe is NSE-only.
-- Nothing is derived or priced: a target is text the owner reads, not an alert.
-- Not related to journal_stock_notes (014), the per-stock research diary.
-- Written ONLY through the FastAPI journal endpoints (service_role);
-- anon has no access.
-- =============================================================

CREATE TABLE IF NOT EXISTS notebook_items (
    id          BIGSERIAL     PRIMARY KEY,
    kind        VARCHAR(10)   NOT NULL DEFAULT 'NOTE'
                  CHECK (kind IN ('TASK','TARGET','WATCH','NOTE','PLUTUS')),
    title       VARCHAR(200)  NOT NULL CHECK (length(btrim(title)) > 0),
    body        TEXT,
    market      VARCHAR(2)    CHECK (market IN ('IN','US')),
    symbol      VARCHAR(20),
    due_date    DATE,
    done        BOOLEAN       NOT NULL DEFAULT FALSE,
    pinned      BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notebook_kind ON notebook_items (kind, done);
CREATE INDEX IF NOT EXISTS idx_notebook_due  ON notebook_items (due_date);

-- updated_at touch trigger (function defined in 001).
DROP TRIGGER IF EXISTS trg_notebook_touch ON notebook_items;
CREATE TRIGGER trg_notebook_touch
    BEFORE UPDATE ON notebook_items
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- RLS: service_role only (the FastAPI backend). anon: no policy = deny.
ALTER TABLE notebook_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notebook_service_write ON notebook_items;
CREATE POLICY notebook_service_write ON notebook_items
    FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON notebook_items TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
