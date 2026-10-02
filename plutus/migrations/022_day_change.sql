-- =============================================================
-- 022_day_change.sql -- daily_snapshots.price_change_1d_pct (2026-10-02)
-- =============================================================
-- The Journal's Open Trades / Opportunities tables label a column "Day %"
-- but the only change figure a snapshot carried was price_change_nd_pct,
-- the 7-trading-day trend, so the column showed the weekly move. This adds
-- the true previous-session change, computed by the daily sync from the
-- adjusted close series (metrics/pipeline.py). Older rows stay NULL; the
-- UI falls back to the intraday (close - open) move for those.
-- =============================================================

ALTER TABLE daily_snapshots ADD COLUMN IF NOT EXISTS price_change_1d_pct NUMERIC(10,2);
COMMENT ON COLUMN daily_snapshots.price_change_1d_pct IS
  'Previous-session % change on adjusted closes (Journal Day %)';
