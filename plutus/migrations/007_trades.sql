-- =============================================================
-- 007_trades.sql -- Trading journal (Phase 2)
-- =============================================================

CREATE TABLE IF NOT EXISTS trades (
    id               BIGSERIAL PRIMARY KEY,
    stock_id         BIGINT       REFERENCES stocks(id),
    symbol           VARCHAR(20)  NOT NULL,
    side             VARCHAR(4)   NOT NULL CHECK (side IN ('BUY','SELL')),
    entry_date       DATE,
    entry_price      NUMERIC(12,2),
    quantity         INT,
    exit_date        DATE,
    exit_price       NUMERIC(12,2),
    strategy_id      VARCHAR(50),
    scan_result_id   BIGINT       REFERENCES scan_results(id),
    status           VARCHAR(20)  NOT NULL DEFAULT 'OPEN'
                       CHECK (status IN ('OPEN','CLOSED','CANCELLED')),
    pnl              NUMERIC(14,2) GENERATED ALWAYS AS (
                        CASE
                          WHEN exit_price IS NOT NULL AND entry_price IS NOT NULL AND quantity IS NOT NULL
                            THEN (exit_price - entry_price) * quantity
                                 * (CASE WHEN side='BUY' THEN 1 ELSE -1 END)
                          ELSE NULL
                        END
                     ) STORED,
    notes            TEXT,
    tags             TEXT[]       NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_symbol_status ON trades (symbol, status);
CREATE INDEX IF NOT EXISTS idx_trades_status        ON trades (status);

DROP TRIGGER IF EXISTS trg_trades_touch ON trades;
CREATE TRIGGER trg_trades_touch
    BEFORE UPDATE ON trades
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();
