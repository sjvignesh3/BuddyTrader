// -----------------------------------------------------------------------------
// Expense Tracker API client — second writable surface of Plutus (after the
// journal). Money fields travel as strings (Decimal-safe); all analytics are
// derived client-side in lib/expenses.ts from the raw rows.
// -----------------------------------------------------------------------------

const BASE = import.meta.env.VITE_PLUTUS_API_URL ?? "";

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error ?? j.detail ?? msg;
    } catch { /* keep statusText */ }
    throw new Error(`${method} ${path}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

// ---- Types (wire contract) ---------------------------------------------------

export type Intent = "need" | "want";
export type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";

export const PAYMENT_METHODS = ["UPI", "Cash", "Card", "Other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface Category {
  id: number;
  name: string;
  parent_id: number | null;
  icon: string | null;
  default_intent: Intent | null;
  exclude_from_spending: boolean;
  sort_order: number;
  archived: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Expense {
  id: number;
  expense_date: string;          // ISO YYYY-MM-DD
  name: string;
  amount: string;                // NUMERIC as string
  category_id: number | null;
  intent: Intent | null;
  payment_method: string | null;
  merchant: string | null;
  notes: string | null;
  tags: string[] | null;
  recurring_id: number | null;
  created_at?: string;
  updated_at?: string;
}

/** Item memory — learns everything about "Tea" so the next entry is 2 keys. */
export interface ItemMemory {
  id: number;
  name: string;
  category_id: number | null;
  intent: Intent | null;
  payment_method: string | null;
  last_amount: string | null;
  use_count: number;
  pinned: boolean;
  last_used_at: string | null;
}

export interface Recurring {
  id: number;
  name: string;
  category_id: number | null;
  amount: string;
  frequency: Frequency;
  due_day: number | null;
  intent: Intent | null;
  payment_method: string | null;
  start_date: string;
  end_date: string | null;
  active: boolean;
  notes: string | null;
}

export interface Budget {
  id: number;
  category_id: number | null;    // null = overall monthly budget
  monthly_amount: string;
}

/** Editable payloads (id / timestamps excluded). */
export type ExpenseDraft = Partial<Omit<Expense, "id" | "created_at" | "updated_at">>;
export type CategoryDraft = Partial<Omit<Category, "id" | "created_at" | "updated_at">>;
export type ItemDraft = Partial<Pick<ItemMemory,
  "name" | "category_id" | "intent" | "payment_method" | "last_amount" | "pinned">>;
export type RecurringDraft = Partial<Omit<Recurring, "id">>;

/** Import rows may carry a category NAME — the backend resolves/creates it. */
export type ImportRow = ExpenseDraft & { category?: string };

// ---- Endpoints ---------------------------------------------------------------

export const expensesApi = {
  expenses: (fromIso?: string, toIso?: string) => {
    const p = new URLSearchParams();
    if (fromIso) p.set("from", fromIso);
    if (toIso) p.set("to", toIso);
    const qs = p.toString();
    return send<{ expenses: Expense[]; count: number }>(
      "GET", `/api/expenses${qs ? `?${qs}` : ""}`);
  },
  createExpense: (draft: ExpenseDraft) =>
    send<{ expense: Expense }>("POST", "/api/expenses", draft),
  updateExpense: (id: number, draft: ExpenseDraft) =>
    send<{ expense: Expense }>("PUT", `/api/expenses/${id}`, draft),
  deleteExpense: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/expenses/${id}`),
  bulkImport: (rows: ImportRow[]) =>
    send<{ imported: number; skipped: number }>(
      "POST", "/api/expenses/import", { expenses: rows }),

  items: () => send<{ items: ItemMemory[]; count: number }>(
    "GET", "/api/expenses/items"),
  updateItem: (id: number, draft: ItemDraft) =>
    send<{ item: ItemMemory }>("PUT", `/api/expenses/items/${id}`, draft),
  deleteItem: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/expenses/items/${id}`),

  categories: () => send<{ categories: Category[]; count: number }>(
    "GET", "/api/expenses/categories"),
  createCategory: (draft: CategoryDraft) =>
    send<{ category: Category }>("POST", "/api/expenses/categories", draft),
  updateCategory: (id: number, draft: CategoryDraft) =>
    send<{ category: Category }>("PUT", `/api/expenses/categories/${id}`, draft),
  deleteCategory: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/expenses/categories/${id}`),

  recurring: () => send<{ recurring: Recurring[]; count: number }>(
    "GET", "/api/expenses/recurring"),
  createRecurring: (draft: RecurringDraft) =>
    send<{ recurring: Recurring }>("POST", "/api/expenses/recurring", draft),
  updateRecurring: (id: number, draft: RecurringDraft) =>
    send<{ recurring: Recurring }>("PUT", `/api/expenses/recurring/${id}`, draft),
  deleteRecurring: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/expenses/recurring/${id}`),
  logRecurring: (id: number, overrides: ExpenseDraft = {}) =>
    send<{ expense: Expense }>("POST", `/api/expenses/recurring/${id}/log`, overrides),

  budgets: () => send<{ budgets: Budget[]; count: number }>(
    "GET", "/api/expenses/budgets"),
  setBudget: (categoryId: number | null, monthlyAmount: string | number) =>
    send<{ budget: Budget }>("POST", "/api/expenses/budgets",
      { category_id: categoryId, monthly_amount: monthlyAmount }),
  deleteBudget: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/expenses/budgets/${id}`),
};
