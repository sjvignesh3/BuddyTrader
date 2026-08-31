-- =============================================================
-- 006_scans_and_results.sql -- Persisted scan outputs
-- =============================================================

CREATE TABLE IF NOT EXISTS scans (
    id                    BIGSERIAL PRIMARY KEY,
    pool_code             VARCHAR(20),
    triggered_by          VARCHAR(30)  NOT NULL,
    snapshot_date         DATE,
    strategy_ids          TEXT[]       NOT NULL DEFAULT '{}',
    total_stocks          INT,
    opportunities_count   INT,
    duration_seconds      NUMERIC(8,2),
    started_at            TIMESTAMPTZ,
    finished_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scans_pool_date
    ON scans (pool_code, snapshot_date DESC);

-- Idempotency key for same-day rerun (Stage 6 ScanEngine conflict tuple).
CREATE UNIQUE INDEX IF NOT EXISTS ux_scans_pool_date_trigger
    ON scans (pool_code, snapshot_date, triggered_by);

CREATE TABLE IF NOT EXISTS scan_results (
    id                    BIGSERIAL PRIMARY KEY,
    scan_id               BIGINT       NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    stock_id              BIGINT       REFERENCES stocks(id),
    symbol                VARCHAR(20)  NOT NULL,
    strategy_id           VARCHAR(50)  NOT NULL,
    status                VARCHAR(30)  NOT NULL,
    score                 NUMERIC(6,2),
    best_score            NUMERIC(6,2),
    reasons               JSONB        NOT NULL DEFAULT '[]'::jsonb,
    metrics_snapshot      JSONB        NOT NULL DEFAULT '{}'::jsonb,
    fundamentals_check    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sr_scan   ON scan_results (scan_id);
CREATE INDEX IF NOT EXISTS idx_sr_symbol ON scan_results (symbol);
CREATE INDEX IF NOT EXISTS idx_sr_status ON scan_results (status);

-- Idempotency: one row per (scan, symbol, strategy).
CREATE UNIQUE INDEX IF NOT EXISTS ux_sr_scan_symbol_strategy
    ON scan_results (scan_id, symbol, strategy_id);
