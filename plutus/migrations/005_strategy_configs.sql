-- =============================================================
-- 005_strategy_configs.sql -- Replaces UserData/strategy_rules.json
-- =============================================================

CREATE TABLE IF NOT EXISTS strategy_configs (
    id                VARCHAR(50)  PRIMARY KEY,
    name              VARCHAR(100) NOT NULL,
    enabled           BOOLEAN      NOT NULL DEFAULT TRUE,
    strategy_type     VARCHAR(30),
    applies_to_pools  TEXT[]       NOT NULL DEFAULT '{}',
    priority          INT          NOT NULL DEFAULT 0,
    inputs            JSONB        NOT NULL DEFAULT '{}'::jsonb,
    rules             JSONB        NOT NULL DEFAULT '{}'::jsonb,
    score_map         JSONB        NOT NULL DEFAULT '{}'::jsonb,
    version           INT          NOT NULL DEFAULT 1,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_strategy_configs_touch ON strategy_configs;
CREATE TRIGGER trg_strategy_configs_touch
    BEFORE UPDATE ON strategy_configs
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();
