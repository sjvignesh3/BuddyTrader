-- =============================================================
-- 011_canary_checks.sql — Stage 8 (Hardening)
-- =============================================================
-- Pinned "known-answer" fixtures that every sync re-verifies. Any drift
-- above a fixed threshold (checked in Python) fires a Stage 8 alert.
--
-- Contract:
--   * `symbol` + `check_date` (the anchor date whose close we pin) form
--     the natural key of a fixture — one row per (symbol, check_date).
--   * `expected_close` is the pinned value (NUMERIC — never FLOAT).
--   * `tolerance_pct` is the maximum allowed relative drift, e.g.
--     0.005 = 0.5 %. Default 0.005.
--   * `last_observed_close` / `last_drift_pct` / `last_status` /
--     `last_checked_at` are updated by the canary runner every sync.
--   * `active` lets us retire a fixture without deleting history.
--
-- Idempotent: safe to re-apply.
-- =============================================================

CREATE TABLE IF NOT EXISTS canary_checks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol              TEXT        NOT NULL,
    check_date          DATE        NOT NULL,
    expected_close      NUMERIC(18, 4) NOT NULL,
    tolerance_pct       NUMERIC(6, 4) NOT NULL DEFAULT 0.005,
    active              BOOLEAN     NOT NULL DEFAULT TRUE,
    notes               TEXT,
    last_observed_close NUMERIC(18, 4),
    last_drift_pct      NUMERIC(10, 6),
    last_status         TEXT,    -- 'ok' | 'drift' | 'missing' | 'error'
    last_checked_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (symbol, check_date)
);

CREATE INDEX IF NOT EXISTS canary_checks_active_idx
    ON canary_checks (active) WHERE active = TRUE;

DROP TRIGGER IF EXISTS trg_canary_touch ON canary_checks;
CREATE TRIGGER trg_canary_touch
    BEFORE UPDATE ON canary_checks
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- RLS: anon read (dashboards can show the canary state), service write only.
ALTER TABLE canary_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS canary_anon_read     ON canary_checks;
DROP POLICY IF EXISTS canary_service_write ON canary_checks;
CREATE POLICY canary_anon_read     ON canary_checks FOR SELECT TO anon         USING (true);
CREATE POLICY canary_service_write ON canary_checks FOR ALL    TO service_role USING (true) WITH CHECK (true);
