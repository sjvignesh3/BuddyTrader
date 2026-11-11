-- =============================================================
-- 026_markets.sql -- US market, phase 1: pools carry a market, plus the
--                    first US pool (US Mega Cap) and its 17 stocks
-- =============================================================
-- `pools.market` ('IN' | 'US') decides how a bare ticker typed into a pool is
-- read and which daily sync / scan owns the pool. Every existing pool
-- defaults to 'IN', so nothing about the Indian side changes.
--
-- `stocks` gets NO new column: a stock's market is read off its symbol.
-- Indian symbols keep their exchange suffix ('TCS.NS', '500325.BO'); US
-- symbols are the plain Yahoo ticker ('NVDA'). See plutus/markets.py.
-- `stocks.exchange` (existing column) holds NASDAQ / NYSE for US rows — the
-- prefix TradingView needs ('NASDAQ:SNDK').
--
-- US stocks have no Screener.in data: their snapshot PE / PB / market cap
-- come from Yahoo (market_cap in USD), cap_bucket stays NULL, and they are
-- never given a fundamental score in this phase.
--
-- Idempotent: safe to re-run.
-- =============================================================

ALTER TABLE pools ADD COLUMN IF NOT EXISTS market VARCHAR(2) NOT NULL DEFAULT 'IN';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pools_market_check'
    ) THEN
        ALTER TABLE pools ADD CONSTRAINT pools_market_check
            CHECK (market IN ('IN', 'US'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pools_market ON pools (market);

-- The first US pool. Price strategies only (no fundamental_screener).
INSERT INTO pools (code, name, description, display_order, strategies, market) VALUES
    ('USMEGA', 'US Mega Cap', 'US mega-cap names (NASDAQ / NYSE)', 110,
     ARRAY['envelope_200dma', 'week52_high_low', 'rally_20_percent'], 'US')
ON CONFLICT (code) DO NOTHING;

-- Its members. Name / sector / industry are filled by the US daily sync from
-- Yahoo when missing, so only what the sync cannot know is seeded here.
INSERT INTO stocks (symbol, name, exchange, active, pools, metadata) VALUES
    ('NVDA',  'NVIDIA Corporation',            'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('GOOGL', 'Alphabet Inc.',                 'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('AVGO',  'Broadcom Inc.',                 'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('META',  'Meta Platforms, Inc.',          'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('WMT',   'Walmart Inc.',                  'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('LRCX',  'Lam Research Corporation',      'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('CAT',   'Caterpillar Inc.',              'NYSE',   TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('AMAT',  'Applied Materials, Inc.',       'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('DELL',  'Dell Technologies Inc.',        'NYSE',   TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('GS',    'The Goldman Sachs Group, Inc.', 'NYSE',   TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('NFLX',  'Netflix, Inc.',                 'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('GEV',   'GE Vernova Inc.',               'NYSE',   TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('SNDK',  'Sandisk Corporation',           'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('KLAC',  'KLA Corporation',               'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('IBM',   'International Business Machines Corporation', 'NYSE', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('TMUS',  'T-Mobile US, Inc.',             'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}'),
    ('QCOM',  'QUALCOMM Incorporated',         'NASDAQ', TRUE, ARRAY['USMEGA'], '{"membership": {"USMEGA": {"source": "seed"}}}')
ON CONFLICT (symbol) DO NOTHING;
