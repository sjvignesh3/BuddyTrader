-- =============================================================
-- 009_views.sql -- Read-optimized views for the frontend
-- =============================================================

-- Latest snapshot per stock -----------------------------------------
CREATE OR REPLACE VIEW v_stocks_latest AS
SELECT DISTINCT ON (s.id)
       s.id                AS stock_id,
       s.symbol,
       s.name,
       s.sector,
       s.industry,
       s.exchange,
       s.active,
       s.pools,
       s.cap_type_manual,
       s.metadata,
       ds.snapshot_date,
       ds.open, ds.high, ds.low, ds.close, ds.adj_close, ds.volume,
       ds.market_cap, ds.cap_bucket,
       ds.pe_current, ds.forward_pe, ds.pb_current,
       ds.debt_to_equity_pct, ds.ebitda_ttm, ds.revenue_ttm, ds.profit_margin_pct,
       ds.high_52w, ds.low_52w,
       ds.dma_200, ds.below_200dma_pct,
       ds.ath, ds.fall_from_ath_pct,
       ds.distance_from_52w_low_pct, ds.distance_from_52w_high_pct,
       ds.has_valid_20pct_rally,
       ds.last_rally_pct, ds.last_rally_low, ds.last_rally_high,
       ds.last_rally_start_date, ds.last_rally_end_date, ds.days_since_last_rally,
       ds.price_change_nd_pct,
       (SELECT COUNT(*) FROM trades t
          WHERE t.symbol = s.symbol AND t.status = 'OPEN') AS open_positions
-- Join by symbol: the sync worker upserts snapshots keyed by symbol and
-- does not resolve stock_id, so an id join would never match a row.
FROM   stocks s
LEFT JOIN daily_snapshots ds ON ds.symbol = s.symbol
ORDER BY s.id, ds.snapshot_date DESC NULLS LAST;

-- Latest fundamental per stock --------------------------------------
-- Keyed by symbol (stock_id is nullable — the worker writes by symbol).
CREATE OR REPLACE VIEW v_fundamentals_latest AS
SELECT DISTINCT ON (symbol) *
FROM   fundamentals
ORDER BY symbol, quarter_end_date DESC;

-- ---------------------------------------------------------------
-- Views must run with the CALLER's privileges, not the owner's.
-- Without security_invoker, Postgres executes the view as its
-- (superuser) owner and SKIPS base-table RLS — the trades subquery
-- in v_stocks_latest would leak open-position counts to anon.
-- ---------------------------------------------------------------
ALTER VIEW v_stocks_latest       SET (security_invoker = true);
ALTER VIEW v_fundamentals_latest SET (security_invoker = true);
