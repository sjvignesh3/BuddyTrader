-- =============================================================
-- 002_pools.sql -- Pool reference table (F40, E40, S200, PlayArea)
-- =============================================================

CREATE TABLE IF NOT EXISTS pools (
    code           VARCHAR(20)  PRIMARY KEY,
    name           VARCHAR(100) NOT NULL,
    description    TEXT,
    display_order  INT          NOT NULL DEFAULT 0,
    strategies     TEXT[]       NOT NULL DEFAULT '{}',
    metadata       JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_pools_touch ON pools;
CREATE TRIGGER trg_pools_touch
    BEFORE UPDATE ON pools
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- Seed the canonical pools. Idempotent via ON CONFLICT DO NOTHING.
INSERT INTO pools (code, name, description, display_order) VALUES
    ('F40',      'Flagship 40',    'Qualitative flagship names',   10),
    ('E40',      'Emerging 40',    'Qualitative emerging names',   20),
    ('S200',     'Smartpick 200',  'Quantitative broad universe',  30),
    ('PlayArea', 'Play Area',      'Tactical / speculative bucket', 40)
ON CONFLICT (code) DO NOTHING;
