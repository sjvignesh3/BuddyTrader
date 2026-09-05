-- =============================================================
-- 016_sizing_plans.sql -- Position Sizer (personal tool)
-- =============================================================
-- Two changes:
--   1. journal_opportunities / journal_trades gain a `stop_price` so the
--      journal can carry the exit that defines a trade's risk. The
--      Position Sizer's "portfolio heat" (aggregate open risk) is computed
--      ONLY from open lots that have a stop — no stop, no assumed risk.
--   2. sizing_plans -- saved pre-trade plans. Each row is a snapshot of the
--      inputs the user sized with (capital, risk %, entry, stop, qty) plus
--      the reward targets and GTT entry ladder as JSONB. Every derived
--      value (₹ risk, R multiples, allocation %, room left) is recomputed
--      at read time from these inputs and the live journal/capital — never
--      persisted. `opportunity_id` links a plan to the journal opportunity
--      it was converted into (the existing Journal flow; no second model).
--
-- Written ONLY through the FastAPI endpoints (service_role); anon has no
-- access. Money is NUMERIC (FLOAT banned, see README).
-- =============================================================

ALTER TABLE journal_opportunities ADD COLUMN IF NOT EXISTS stop_price NUMERIC(12,2);
ALTER TABLE journal_trades        ADD COLUMN IF NOT EXISTS stop_price NUMERIC(12,2);

CREATE TABLE IF NOT EXISTS sizing_plans (
    id              BIGSERIAL     PRIMARY KEY,
    symbol          VARCHAR(20)   NOT NULL,
    cap_bucket      VARCHAR(10)   CHECK (cap_bucket IN ('Large','Mid','Small','Micro')),
    capital         NUMERIC(14,2) NOT NULL CHECK (capital > 0),
    risk_pct        NUMERIC(5,2)  NOT NULL CHECK (risk_pct > 0),
    entry           NUMERIC(12,2) NOT NULL CHECK (entry > 0),
    stop            NUMERIC(12,2) NOT NULL CHECK (stop > 0),
    qty             INT           NOT NULL CHECK (qty > 0),
    -- [{"price": "500.00"}, ...] — reward targets, ascending.
    targets         JSONB         NOT NULL DEFAULT '[]'::jsonb,
    -- [{"trigger": "450.00", "qty": 20}, ...] — GTT entry tranches.
    ladder          JSONB         NOT NULL DEFAULT '[]'::jsonb,
    notes           TEXT,
    opportunity_id  BIGINT        REFERENCES journal_opportunities(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    -- A long plan's stop must sit below its entry, or there is no risk to size.
    CONSTRAINT sizing_plans_stop_below_entry CHECK (stop < entry)
);

CREATE INDEX IF NOT EXISTS idx_splan_symbol  ON sizing_plans (symbol);
CREATE INDEX IF NOT EXISTS idx_splan_created ON sizing_plans (created_at DESC);

DROP TRIGGER IF EXISTS trg_splan_touch ON sizing_plans;
CREATE TRIGGER trg_splan_touch
    BEFORE UPDATE ON sizing_plans
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- RLS: service_role only (the FastAPI backend). anon: no policy = deny.
ALTER TABLE sizing_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS splan_service_write ON sizing_plans;
CREATE POLICY splan_service_write ON sizing_plans
    FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON sizing_plans TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
