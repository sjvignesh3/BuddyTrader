-- =============================================================
-- 028_watchlist_color.sql -- a colour per watchlist (extension "labels")
-- =============================================================
-- The TradingView panel shows a watchlist as a label: a coloured dot on
-- every row that belongs to it, a popover to tick a stock into several
-- lists at once, and a slicer to narrow the list to one label. A label IS
-- a watchlist — nothing else is stored, so the web app's lists and the
-- extension's labels stay one thing.
--
--   * watchlists.color  '#rrggbb' or NULL (NULL = no colour, plain list)
--
-- Deploy order: apply BEFORE the new backend (the new code selects and
-- writes `color`; the old code ignores an extra column).
-- Idempotent: safe to re-run.
-- =============================================================

ALTER TABLE watchlists ADD COLUMN IF NOT EXISTS color VARCHAR(7);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'watchlists_color_hex'
    ) THEN
        ALTER TABLE watchlists
            ADD CONSTRAINT watchlists_color_hex
            CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$');
    END IF;
END $$;

COMMENT ON COLUMN watchlists.color IS 'label colour #rrggbb (lower-case) or NULL; display only';
