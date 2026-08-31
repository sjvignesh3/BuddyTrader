-- =============================================================
-- 008_sync_jobs.sql -- Audit trail for every sync run
--
-- Stage 4 rewrite: aligned with plutus/registry/fields.py so the
-- daily sync worker can upsert directly with column names from the
-- registry (no manual mapping).
-- =============================================================

CREATE TABLE IF NOT EXISTS sync_jobs (
    id                  BIGSERIAL PRIMARY KEY,
    job_id              UUID          NOT NULL,
    job_type            VARCHAR(30)   NOT NULL,
    as_of_date          DATE          NOT NULL,
    started_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    finished_at         TIMESTAMPTZ,
    status              VARCHAR(20)   NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','ok','partial','failed')),
    symbols_total       INT,
    symbols_ok          INT,
    symbols_failed      INT,
    snapshots_written   INT,
    payload_json        JSONB         NOT NULL DEFAULT '{}'::jsonb,

    -- Same-day idempotency: (job_type, as_of_date) is the natural key.
    UNIQUE (job_type, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_type_time
    ON sync_jobs (job_type, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_as_of
    ON sync_jobs (as_of_date DESC);
