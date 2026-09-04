-- =============================================================
-- 015_expenses.sql -- Personal Expense Intelligence module
-- =============================================================
-- Manual-first expense tracker: no bank/UPI integrations by design.
-- Written ONLY through the FastAPI expense endpoints (service_role);
-- anon has no access. Money is NUMERIC (FLOAT banned, see README).
--
-- Tables:
--   expense_categories  two-level hierarchy (parent_id NULL = top level),
--                       per-category need/want default and an
--                       exclude_from_spending flag (investments, ATM
--                       withdrawals) so spend totals stay honest.
--   expense_items       the "item memory" — learns category / intent /
--                       payment method / typical amount per item name so
--                       quick entry autofills everything.
--   expense_recurring   recurring templates (rent, subscriptions). No
--                       auto-posting: the UI offers one-click logging.
--   expenses            the journal itself.
--   expense_budgets     optional monthly budgets (category_id NULL = overall).
-- =============================================================

-- ---- Categories -------------------------------------------------------

CREATE TABLE IF NOT EXISTS expense_categories (
    id                    BIGSERIAL    PRIMARY KEY,
    name                  VARCHAR(60)  NOT NULL,
    parent_id             BIGINT       REFERENCES expense_categories(id) ON DELETE CASCADE,
    icon                  VARCHAR(8),                    -- emoji for chips/tiles
    default_intent        VARCHAR(4)   CHECK (default_intent IN ('need','want')),
    exclude_from_spending BOOLEAN      NOT NULL DEFAULT FALSE,
    sort_order            INT          NOT NULL DEFAULT 0,
    archived              BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness per level (NULL parents collapse to 0).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ecat_name_parent
    ON expense_categories (lower(name), COALESCE(parent_id, 0));

DROP TRIGGER IF EXISTS trg_ecat_touch ON expense_categories;
CREATE TRIGGER trg_ecat_touch
    BEFORE UPDATE ON expense_categories
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- ---- Recurring templates ---------------------------------------------

CREATE TABLE IF NOT EXISTS expense_recurring (
    id             BIGSERIAL     PRIMARY KEY,
    name           VARCHAR(120)  NOT NULL,
    category_id    BIGINT        REFERENCES expense_categories(id) ON DELETE SET NULL,
    amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    frequency      VARCHAR(10)   NOT NULL DEFAULT 'monthly'
                   CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
    due_day        INT           CHECK (due_day BETWEEN 1 AND 31),  -- monthly only
    intent         VARCHAR(4)    CHECK (intent IN ('need','want')),
    payment_method VARCHAR(20),
    start_date     DATE          NOT NULL DEFAULT CURRENT_DATE,
    end_date       DATE,
    active         BOOLEAN       NOT NULL DEFAULT TRUE,
    notes          TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_erec_touch ON expense_recurring;
CREATE TRIGGER trg_erec_touch
    BEFORE UPDATE ON expense_recurring
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- ---- Expenses ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS expenses (
    id             BIGSERIAL     PRIMARY KEY,
    expense_date   DATE          NOT NULL DEFAULT CURRENT_DATE,
    name           VARCHAR(120)  NOT NULL,
    amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    category_id    BIGINT        REFERENCES expense_categories(id) ON DELETE SET NULL,
    intent         VARCHAR(4)    CHECK (intent IN ('need','want')),
    payment_method VARCHAR(20),
    merchant       VARCHAR(120),
    notes          TEXT,
    tags           TEXT[],
    recurring_id   BIGINT        REFERENCES expense_recurring(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (expense_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses (category_id);

DROP TRIGGER IF EXISTS trg_expense_touch ON expenses;
CREATE TRIGGER trg_expense_touch
    BEFORE UPDATE ON expenses
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- ---- Item memory ------------------------------------------------------

CREATE TABLE IF NOT EXISTS expense_items (
    id             BIGSERIAL     PRIMARY KEY,
    name           VARCHAR(120)  NOT NULL,
    category_id    BIGINT        REFERENCES expense_categories(id) ON DELETE SET NULL,
    intent         VARCHAR(4)    CHECK (intent IN ('need','want')),
    payment_method VARCHAR(20),
    last_amount    NUMERIC(12,2),
    use_count      INT           NOT NULL DEFAULT 0,
    pinned         BOOLEAN       NOT NULL DEFAULT FALSE,
    last_used_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eitem_name ON expense_items (lower(name));

DROP TRIGGER IF EXISTS trg_eitem_touch ON expense_items;
CREATE TRIGGER trg_eitem_touch
    BEFORE UPDATE ON expense_items
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- ---- Budgets ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS expense_budgets (
    id             BIGSERIAL     PRIMARY KEY,
    category_id    BIGINT        REFERENCES expense_categories(id) ON DELETE CASCADE,
    monthly_amount NUMERIC(12,2) NOT NULL CHECK (monthly_amount > 0),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- One budget per category; category_id NULL = the overall monthly budget.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ebudget_category
    ON expense_budgets (COALESCE(category_id, 0));

DROP TRIGGER IF EXISTS trg_ebudget_touch ON expense_budgets;
CREATE TRIGGER trg_ebudget_touch
    BEFORE UPDATE ON expense_budgets
    FOR EACH ROW EXECUTE FUNCTION plutus_touch_updated_at();

-- ---- RLS: service_role only (the FastAPI backend); anon: no policy = deny.

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_recurring  ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_budgets    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ecat_service_write ON expense_categories;
CREATE POLICY ecat_service_write ON expense_categories
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS erec_service_write ON expense_recurring;
CREATE POLICY erec_service_write ON expense_recurring
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS expense_service_write ON expenses;
CREATE POLICY expense_service_write ON expenses
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS eitem_service_write ON expense_items;
CREATE POLICY eitem_service_write ON expense_items
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ebudget_service_write ON expense_budgets;
CREATE POLICY ebudget_service_write ON expense_budgets
    FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON expense_categories, expense_recurring,
    expenses, expense_items, expense_budgets TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- =============================================================
-- Seed: category taxonomy (idempotent). Derived from the user's
-- Google Sheet history, cleaned up: Travel/Commute/Bike merged
-- under Transport; Investments/Gold/Chit flagged as transfers so
-- they never inflate spending totals.
-- =============================================================

INSERT INTO expense_categories (name, icon, default_intent, exclude_from_spending, sort_order)
VALUES
    ('Food & Dining',            '🍽️', NULL,  FALSE, 1),
    ('Transport',                '🚌', 'need', FALSE, 2),
    ('Housing',                  '🏠', 'need', FALSE, 3),
    ('Health',                   '🩺', 'need', FALSE, 4),
    ('Personal Care',            '🧴', NULL,  FALSE, 5),
    ('Connectivity',             '📱', 'need', FALSE, 6),
    ('Entertainment',            '🎬', 'want', FALSE, 7),
    ('Shopping',                 '🛍️', 'want', FALSE, 8),
    ('Travel & Trips',           '🧳', 'want', FALSE, 9),
    ('Money & Fees',             '🏦', 'need', FALSE, 10),
    ('Investments & Transfers',  '📈', NULL,  TRUE,  11),
    ('Miscellaneous',            '📦', NULL,  FALSE, 12)
ON CONFLICT (lower(name), COALESCE(parent_id, 0)) DO NOTHING;

INSERT INTO expense_categories (name, parent_id, default_intent, exclude_from_spending, sort_order)
SELECT sub.name, p.id, sub.intent::VARCHAR(4), sub.excl, sub.ord
FROM (VALUES
    -- Food & Dining
    ('Groceries',            'Food & Dining',           'need', FALSE, 1),
    ('Restaurants',          'Food & Dining',           'want', FALSE, 2),
    ('Snacks & Cravings',    'Food & Dining',           'want', FALSE, 3),
    ('Food Delivery',        'Food & Dining',           'want', FALSE, 4),
    -- Transport
    ('Commute',              'Transport',               'need', FALSE, 1),
    ('Fuel',                 'Transport',               'need', FALSE, 2),
    ('Cab & Auto',           'Transport',               NULL,   FALSE, 3),
    ('Vehicle Maintenance',  'Transport',               'need', FALSE, 4),
    -- Housing
    ('Rent',                 'Housing',                 'need', FALSE, 1),
    ('Electricity',          'Housing',                 'need', FALSE, 2),
    ('Water & Gas',          'Housing',                 'need', FALSE, 3),
    ('Household Supplies',   'Housing',                 'need', FALSE, 4),
    ('Furnishing',           'Housing',                 'want', FALSE, 5),
    -- Health
    ('Medical & Pharmacy',   'Health',                  'need', FALSE, 1),
    ('Fitness',              'Health',                  'need', FALSE, 2),
    ('Insurance',            'Health',                  'need', FALSE, 3),
    -- Personal Care
    ('Grooming',             'Personal Care',           'need', FALSE, 1),
    ('Clothing',             'Personal Care',           NULL,   FALSE, 2),
    ('Toiletries',           'Personal Care',           'need', FALSE, 3),
    -- Connectivity
    ('Mobile Recharge',      'Connectivity',            'need', FALSE, 1),
    ('Internet',             'Connectivity',            'need', FALSE, 2),
    -- Entertainment
    ('Movies',               'Entertainment',           'want', FALSE, 1),
    ('Subscriptions',        'Entertainment',           'want', FALSE, 2),
    ('Activities & Events',  'Entertainment',           'want', FALSE, 3),
    ('Games',                'Entertainment',           'want', FALSE, 4),
    -- Shopping
    ('Electronics & Gadgets','Shopping',                'want', FALSE, 1),
    ('General Shopping',     'Shopping',                'want', FALSE, 2),
    ('Gifts',                'Shopping',                'want', FALSE, 3),
    -- Travel & Trips
    ('Trips & Tours',        'Travel & Trips',          'want', FALSE, 1),
    -- Money & Fees
    ('Loans & EMI',          'Money & Fees',            'need', FALSE, 1),
    ('Bank Charges',         'Money & Fees',            'need', FALSE, 2),
    ('Cash Withdrawal',      'Money & Fees',            NULL,   TRUE,  3),
    -- Investments & Transfers (excluded from spending)
    ('Investments',          'Investments & Transfers', NULL,   TRUE,  1),
    ('Gold',                 'Investments & Transfers', NULL,   TRUE,  2),
    ('Chit',                 'Investments & Transfers', NULL,   TRUE,  3),
    -- Miscellaneous
    ('Unexpected',           'Miscellaneous',           NULL,   FALSE, 1),
    ('Other',                'Miscellaneous',           NULL,   FALSE, 2)
) AS sub(name, parent, intent, excl, ord)
JOIN expense_categories p ON p.name = sub.parent AND p.parent_id IS NULL
ON CONFLICT (lower(name), COALESCE(parent_id, 0)) DO NOTHING;

-- =============================================================
-- Seed: item memory from the user's existing Item→Category lookup
-- sheet, remapped onto the new taxonomy. Makes quick entry
-- autofill from day one.
-- =============================================================

INSERT INTO expense_items (name, category_id, intent)
SELECT it.name, c.id, it.intent::VARCHAR(4)
FROM (VALUES
    ('Food',            'Restaurants',           'want'),
    ('Cravings',        'Snacks & Cravings',     'want'),
    ('Snacks',          'Snacks & Cravings',     'want'),
    ('Treat',           'Restaurants',           'want'),
    ('Chicken',         'Groceries',             'need'),
    ('Fish',            'Groceries',             'need'),
    ('Grocery',         'Groceries',             'need'),
    ('Rice',            'Groceries',             'need'),
    ('Bus Charges',     'Commute',               'need'),
    ('Train Charges',   'Commute',               'need'),
    ('Bus Pass',        'Commute',               'need'),
    ('Train Pass',      'Commute',               'need'),
    ('Parking Charges', 'Commute',               'need'),
    ('Toll Charge',     'Commute',               'need'),
    ('Local Travel',    'Cab & Auto',            NULL),
    ('Petrol',          'Fuel',                  'need'),
    ('Bike Service',    'Vehicle Maintenance',   'need'),
    ('Rent',            'Rent',                  'need'),
    ('Electricity',     'Electricity',           'need'),
    ('Gas',             'Water & Gas',           'need'),
    ('Water Bill',      'Water & Gas',           'need'),
    ('Household',       'Household Supplies',    'need'),
    ('Toiletries',      'Toiletries',            'need'),
    ('Medical',         'Medical & Pharmacy',    'need'),
    ('Pharmacy',        'Medical & Pharmacy',    'need'),
    ('Gym',             'Fitness',               'need'),
    ('Badminton',       'Fitness',               'need'),
    ('Turf',            'Fitness',               'want'),
    ('Insurance',       'Insurance',             'need'),
    ('Hair Cut',        'Grooming',              'need'),
    ('Trim',            'Grooming',              'need'),
    ('Cosmetics',       'Grooming',              'want'),
    ('Sunscreen',       'Grooming',              'need'),
    ('Cloth Shopping',  'Clothing',              'want'),
    ('Footwear',        'Clothing',              NULL),
    ('Airtel',          'Mobile Recharge',       'need'),
    ('Jio',             'Mobile Recharge',       'need'),
    ('Data Addon',      'Mobile Recharge',       'need'),
    ('Internet',        'Internet',              'need'),
    ('Cinema',          'Movies',                'want'),
    ('Netflix',         'Subscriptions',         'want'),
    ('Amazon Prime',    'Subscriptions',         'want'),
    ('Theme Park',      'Activities & Events',   'want'),
    ('Boating',         'Activities & Events',   'want'),
    ('Skating',         'Activities & Events',   'want'),
    ('Mobile',          'Electronics & Gadgets', 'want'),
    ('Headset',         'Electronics & Gadgets', 'want'),
    ('Bags',            'General Shopping',      'want'),
    ('Gift',            'Gifts',                 'want'),
    ('Trip',            'Trips & Tours',         'want'),
    ('Tour',            'Trips & Tours',         'want'),
    ('Personal Loan',   'Loans & EMI',           'need'),
    ('Bank Charges',    'Bank Charges',          'need'),
    ('ATM',             'Cash Withdrawal',       NULL),
    ('Stocks',          'Investments',           NULL),
    ('Mutual Funds',    'Investments',           NULL),
    ('RD',              'Investments',           NULL),
    ('SGB',             'Gold',                  NULL),
    ('GoldBees',        'Gold',                  NULL),
    ('Chit',            'Chit',                  NULL),
    ('Emergency',       'Unexpected',            NULL),
    ('Unaccounted',     'Other',                 NULL)
) AS it(name, category, intent)
JOIN expense_categories c ON c.name = it.category AND c.parent_id IS NOT NULL
ON CONFLICT (lower(name)) DO NOTHING;
