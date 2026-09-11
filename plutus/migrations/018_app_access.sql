-- =============================================================
-- 018_app_access.sql -- view-only access credential (personal tool gate)
-- =============================================================
-- The OWNER password lives in the PLUTUS_APP_PASSWORD env var: it is the
-- root credential and is rotated by editing the environment.
--
-- The VIEW-ONLY password is different — it is shared with other people and
-- therefore has to be rotatable from inside the app, at any hour, without a
-- redeploy. That means it needs somewhere durable to live, which is this
-- table.
--
-- Contract:
--   * Exactly ONE row (id = 1) — this is a single-user toolbench.
--   * We store a SHA-256 hash, never the password. The plaintext is shown
--     exactly once, in the response to the rotate call, and is not
--     recoverable afterwards: losing it costs one more click, whereas
--     storing it would put a live shared credential in the database.
--   * `viewer_hint` keeps the first 4 characters so the console can show
--     WHICH password is currently live without revealing it.
--   * viewer_hash NULL (or no row at all) = view-only access is switched
--     off; only the owner can get in.
--   * Rotating changes the hash, which changes the viewer token signing
--     key — so every previously issued viewer session dies instantly.
--
-- Idempotent: safe to re-apply.
-- =============================================================

CREATE TABLE IF NOT EXISTS app_access (
    id          SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    viewer_hash TEXT,                    -- SHA-256 hex of the live password
    viewer_hint TEXT,                    -- first 4 chars, for display only
    rotated_at  TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Seed the singleton row with view-only access OFF.
INSERT INTO app_access (id, viewer_hash, viewer_hint, rotated_at)
VALUES (1, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- updated_at touch trigger (function defined in 001).
DROP TRIGGER IF EXISTS trg_appaccess_touch ON app_access;
CREATE TRIGGER trg_appaccess_touch
    BEFORE UPDATE ON app_access
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- -------------------------------------------------------------
-- RLS: service_role only. The anon key must never see this row —
-- a leaked hash would let an attacker verify guesses offline.
-- -------------------------------------------------------------
ALTER TABLE app_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS appaccess_service_write ON app_access;
CREATE POLICY appaccess_service_write ON app_access
    FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON app_access FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_access TO service_role;
