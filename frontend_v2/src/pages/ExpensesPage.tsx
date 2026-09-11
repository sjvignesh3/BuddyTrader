// -----------------------------------------------------------------------------
// Expense Tracker — manual-first personal expense intelligence.
// Capture (QuickAdd) → Organise (categories, item memory) → Understand
// (Overview insights) → Improve (budgets, recurring visibility).
// All rows come from /api/expenses/*; every derived number is computed
// client-side in lib/expenses.ts.
// -----------------------------------------------------------------------------
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Budget, Expense, ExpenseDraft, Recurring, RecurringDraft, expensesApi,
} from "../lib/expensesApi";
import {
  addMonths, buildCategoryMaps, buildMonthlyStats, monthLabel, thisMonthKey,
  todayIso,
} from "../lib/expenses";
import { downloadCsv, exportExpenses, mapExpenseSheet, parseCsv } from "../lib/expenseCsv";
import { fmtMoney } from "../lib/money";
import LoadError from "../components/LoadError";
import QuickAdd from "../components/expenses/QuickAdd";
import OverviewTab from "../components/expenses/OverviewTab";
import TransactionsTab from "../components/expenses/TransactionsTab";
import PlanningTab from "../components/expenses/PlanningTab";
import {
  BudgetModal, CategoryManagerModal, ExpenseModal, RecurringModal,
} from "../components/expenses/modals";
import { ConfirmDialog, GhostBtn } from "../components/journal/ui";
import { OwnerOnly } from "../components/AuthGate";

type TabKey = "overview" | "transactions" | "planning";

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "overview", label: "Overview", icon: "🧭" },
  { key: "transactions", label: "Transactions", icon: "🧾" },
  { key: "planning", label: "Recurring & Budgets", icon: "🔁" },
];

/** Restore the tab from the URL hash so a refresh doesn't reset the view. */
const initialTab = (): TabKey => {
  const h = window.location.hash.replace("#", "");
  return TABS.some((t) => t.key === h) ? (h as TabKey) : "overview";
};

const eqk = {
  expenses: ["expenses", "rows"] as const,
  categories: ["expenses", "categories"] as const,
  items: ["expenses", "items"] as const,
  recurring: ["expenses", "recurring"] as const,
  budgets: ["expenses", "budgets"] as const,
};

export default function ExpensesPage() {
  const qc = useQueryClient();
  const [tab, setTabState] = useState<TabKey>(initialTab);
  const setTab = (k: TabKey) => {
    setTabState(k);
    window.history.replaceState(null, "", `#${k}`);
  };
  const [monthSel, setMonthSel] = useState(thisMonthKey());
  const [rootFilter, setRootFilter] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ---- Data ------------------------------------------------------------------
  const expensesQ = useQuery({ queryKey: eqk.expenses, queryFn: () => expensesApi.expenses() });
  const categoriesQ = useQuery({ queryKey: eqk.categories, queryFn: expensesApi.categories });
  const itemsQ = useQuery({ queryKey: eqk.items, queryFn: expensesApi.items });
  const recurringQ = useQuery({ queryKey: eqk.recurring, queryFn: expensesApi.recurring });
  const budgetsQ = useQuery({ queryKey: eqk.budgets, queryFn: expensesApi.budgets });

  const expenses = useMemo(
    () => expensesQ.data?.expenses ?? [], [expensesQ.data]);
  const items = itemsQ.data?.items ?? [];
  const recurring = recurringQ.data?.recurring ?? [];
  const budgets = budgetsQ.data?.budgets ?? [];

  const maps = useMemo(
    () => buildCategoryMaps(categoriesQ.data?.categories ?? []),
    [categoriesQ.data]);
  const monthly = useMemo(
    () => buildMonthlyStats(expenses, maps), [expenses, maps]);

  // ---- Mutations ---------------------------------------------------------------
  const refresh = () => qc.invalidateQueries({ queryKey: ["expenses"] });
  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  };
  const onErr = (e: unknown) => flash(`⚠ ${e instanceof Error ? e.message : String(e)}`);

  const mAdd = useMutation({
    mutationFn: (draft: ExpenseDraft) => expensesApi.createExpense(draft),
    onSuccess: (r) => {
      refresh();
      flash(`Added ${r.expense.name} — ₹${fmtMoney(r.expense.amount, 0)} ✓`);
    },
    onError: onErr,
  });
  const mSave = useMutation({
    mutationFn: (p: { id?: number; draft: ExpenseDraft }) =>
      p.id ? expensesApi.updateExpense(p.id, p.draft) : expensesApi.createExpense(p.draft),
    onSuccess: () => { refresh(); setExpenseModal(null); },
    onError: onErr,
  });
  const mDelete = useMutation({
    mutationFn: (id: number) => expensesApi.deleteExpense(id),
    onSuccess: refresh,
    onError: onErr,
  });
  const mImport = useMutation({
    mutationFn: expensesApi.bulkImport,
    onSuccess: (r) => {
      refresh();
      flash(`Imported ${r.imported} expenses${r.skipped ? ` (${r.skipped} rows skipped)` : ""} ✓`);
    },
    onError: onErr,
  });
  const mCategory = useMutation({
    mutationFn: (p: { id?: number; draft: Parameters<typeof expensesApi.createCategory>[0] }) =>
      p.id ? expensesApi.updateCategory(p.id, p.draft) : expensesApi.createCategory(p.draft),
    onSuccess: refresh,
    onError: onErr,
  });
  const mRecurring = useMutation({
    mutationFn: (p: { id?: number; draft: RecurringDraft }) =>
      p.id ? expensesApi.updateRecurring(p.id, p.draft) : expensesApi.createRecurring(p.draft),
    onSuccess: () => { refresh(); setRecurringModal(null); },
    onError: onErr,
  });
  const mDeleteRecurring = useMutation({
    mutationFn: (id: number) => expensesApi.deleteRecurring(id),
    onSuccess: refresh,
    onError: onErr,
  });
  const mLogRecurring = useMutation({
    mutationFn: (r: Recurring) => expensesApi.logRecurring(r.id, {
      expense_date: todayIso(),
    }),
    onSuccess: (r) => {
      refresh();
      flash(`Logged ${r.expense.name} — ₹${fmtMoney(r.expense.amount, 0)} ✓`);
    },
    onError: onErr,
  });
  const mBudget = useMutation({
    mutationFn: (p: { categoryId: number | null; amount: string }) =>
      expensesApi.setBudget(p.categoryId, p.amount),
    onSuccess: () => { refresh(); setBudgetModal(null); },
    onError: onErr,
  });
  const mDeleteBudget = useMutation({
    mutationFn: (id: number) => expensesApi.deleteBudget(id),
    onSuccess: refresh,
    onError: onErr,
  });

  // ---- Modal state ----------------------------------------------------------------
  const [expenseModal, setExpenseModal] = useState<{ initial: Expense | null } | null>(null);
  const [recurringModal, setRecurringModal] = useState<{ initial: Recurring | null } | null>(null);
  const [budgetModal, setBudgetModal] = useState<{ initial: Budget | null } | null>(null);
  const [catManager, setCatManager] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string; message: string; confirmLabel: string;
    danger: boolean; action: () => void;
  } | null>(null);
  const askConfirm = (title: string, message: string, confirmLabel: string,
                      danger: boolean, action: () => void) =>
    setConfirmState({ title, message, confirmLabel, danger, action });

  // ---- Import / export --------------------------------------------------------------
  const handleImportFile = async (file: File) => {
    const grid = parseCsv(await file.text());
    const result = mapExpenseSheet(grid);
    if (!result || result.rows.length === 0) {
      flash("⚠ Could not find importable rows — expected Item/Name, Amount and Date columns.");
      return;
    }
    askConfirm(
      "Import expenses?",
      `Found ${result.rows.length} importable rows` +
      (result.skipped ? ` (${result.skipped} incomplete rows will be skipped)` : "") +
      `.\n\nCategories are matched by name (new ones are created). ` +
      `Rows are ADDED — existing entries are not touched.`,
      `Import ${result.rows.length} rows`, false,
      () => mImport.mutate(result.rows),
    );
  };

  const handleExport = () => {
    downloadCsv(`plutus-expenses-${todayIso()}.csv`, exportExpenses(expenses, maps.label));
  };

  // ---- Render ------------------------------------------------------------------------
  if (expensesQ.isLoading || categoriesQ.isLoading || itemsQ.isLoading
      || recurringQ.isLoading || budgetsQ.isLoading) {
    return <LoadError loading error={null} />;
  }
  const err = expensesQ.error ?? categoriesQ.error ?? itemsQ.error
    ?? recurringQ.error ?? budgetsQ.error;
  if (err) return <LoadError loading={false} error={err} />;

  const busy = mAdd.isPending || mSave.isPending || mImport.isPending;
  const canForward = monthSel < thisMonthKey();

  return (
    <div>
      {/* Page header + month selector */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Expense Tracker</h1>
          <p className="text-sm text-brand-mute">
            Capture in seconds — Plutus does the organising and the noticing.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <GhostBtn onClick={() => setMonthSel(addMonths(monthSel, -1))} title="Previous month">
            ‹
          </GhostBtn>
          <span className="px-3 py-1.5 rounded-lg bg-brand-panel ring-1 ring-brand-border
                           shadow-card text-sm font-display font-semibold min-w-[110px]
                           text-center select-none">
            {monthLabel(monthSel)}
          </span>
          <GhostBtn onClick={() => canForward && setMonthSel(addMonths(monthSel, 1))}
                    disabled={!canForward} title="Next month"
                    className={canForward ? "" : "opacity-40"}>
            ›
          </GhostBtn>
          {monthSel !== thisMonthKey() && (
            <GhostBtn onClick={() => setMonthSel(thisMonthKey())}>Today</GhostBtn>
          )}
        </div>
      </div>

      {/* Quick add — always on top: capture first, everything else second.
          A view-only session has nothing to capture, so the whole panel goes. */}
      <OwnerOnly>
        <QuickAdd items={items} maps={maps} busy={mAdd.isPending}
                  onAdd={(draft) => mAdd.mutate(draft)} />
      </OwnerOnly>

      {/* Tabs + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div role="tablist" aria-label="Expense sections"
             className="inline-flex max-w-full overflow-x-auto no-scrollbar rounded-2xl
                        ring-1 ring-brand-border bg-brand-panel shadow-card p-1.5 gap-1">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button key={t.key} role="tab" aria-selected={active}
                onClick={() => setTab(t.key)} title={t.label}
                className={`group flex items-center gap-1.5 px-3 sm:px-3.5 py-2 rounded-xl
                            text-sm font-semibold whitespace-nowrap transition-all duration-300 ${
                  active
                    ? "bg-gradient-to-br from-teal-600 to-teal-800 text-white shadow-pop"
                    : "text-brand-mute hover:text-brand-text hover:bg-brand-soft"}`}>
                <span aria-hidden
                      className={`text-base leading-none transition-transform duration-200 ${
                        active ? "scale-110" : "grayscale group-hover:grayscale-0 group-hover:scale-110"}`}>
                  {t.icon}
                </span>
                <span className={active ? "" : "hidden md:inline"}>{t.label}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <OwnerOnly>
            <GhostBtn onClick={() => setCatManager(true)}>🗂 Categories</GhostBtn>
            <GhostBtn onClick={() => fileRef.current?.click()} disabled={busy}>
              ⬆ Import CSV
            </GhostBtn>
          </OwnerOnly>
          <GhostBtn onClick={handleExport} disabled={expenses.length === 0}>⬇ Export</GhostBtn>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                 onChange={(e) => {
                   const f = e.target.files?.[0];
                   if (f) void handleImportFile(f);
                   e.target.value = "";
                 }} />
        </div>
      </div>

      {/* Notices */}
      {notice && (
        <div className="mb-3 px-3.5 py-2 rounded-xl bg-teal-50 ring-1 ring-teal-200
                        text-teal-900 text-sm">{notice}</div>
      )}

      {/* Tab body */}
      {tab === "overview" && (
        <OverviewTab
          monthly={monthly} maps={maps} monthSel={monthSel}
          onSelectMonth={setMonthSel}
          budgets={budgets} recurring={recurring}
          onDrillCategory={(rootId) => { setRootFilter(rootId); setTab("transactions"); }}
        />
      )}
      {tab === "transactions" && (
        <TransactionsTab
          expenses={expenses} maps={maps} monthSel={monthSel}
          rootFilter={rootFilter} onRootFilter={setRootFilter}
          onEdit={(e) => setExpenseModal({ initial: e })}
          onDuplicate={(e) => mAdd.mutate({
            name: e.name, amount: e.amount, expense_date: todayIso(),
            category_id: e.category_id, intent: e.intent,
            payment_method: e.payment_method, merchant: e.merchant,
          })}
          onDelete={(e) => askConfirm(`Delete "${e.name}"?`,
            `This removes ${e.name} (₹${fmtMoney(e.amount, 0)} on ${e.expense_date}) permanently.`,
            "Delete", true, () => mDelete.mutate(e.id))}
        />
      )}
      {tab === "planning" && (
        <PlanningTab
          recurring={recurring} budgets={budgets} expenses={expenses}
          monthly={monthly} maps={maps} monthSel={monthSel}
          busy={mLogRecurring.isPending}
          onAddRecurring={() => setRecurringModal({ initial: null })}
          onEditRecurring={(r) => setRecurringModal({ initial: r })}
          onDeleteRecurring={(r) => askConfirm(`Delete "${r.name}"?`,
            `This removes the recurring template permanently (logged expenses stay).`,
            "Delete", true, () => mDeleteRecurring.mutate(r.id))}
          onToggleRecurring={(r) => mRecurring.mutate({ id: r.id, draft: { active: !r.active } })}
          onLogRecurring={(r) => mLogRecurring.mutate(r)}
          onAddBudget={() => setBudgetModal({ initial: null })}
          onEditBudget={(b) => setBudgetModal({ initial: b })}
          onDeleteBudget={(b) => askConfirm("Remove budget?",
            `Stop tracking this budget? Your expenses are untouched.`,
            "Remove", true, () => mDeleteBudget.mutate(b.id))}
        />
      )}

      {/* Modals */}
      {expenseModal && (
        <ExpenseModal
          initial={expenseModal.initial} maps={maps} busy={mSave.isPending}
          onClose={() => setExpenseModal(null)}
          onSave={(draft) => mSave.mutate({ id: expenseModal.initial?.id, draft })}
        />
      )}
      {recurringModal && (
        <RecurringModal
          initial={recurringModal.initial} maps={maps} busy={mRecurring.isPending}
          onClose={() => setRecurringModal(null)}
          onSave={(draft) => mRecurring.mutate({ id: recurringModal.initial?.id, draft })}
        />
      )}
      {budgetModal && (
        <BudgetModal
          initial={budgetModal.initial} maps={maps} busy={mBudget.isPending}
          existing={budgets.map((b) => b.category_id)}
          onClose={() => setBudgetModal(null)}
          onSave={(categoryId, amount) => mBudget.mutate({ categoryId, amount })}
        />
      )}
      {catManager && (
        <CategoryManagerModal
          maps={maps} busy={mCategory.isPending}
          onClose={() => setCatManager(false)}
          onCreate={(draft) => mCategory.mutate({ draft })}
          onUpdate={(id, draft) => mCategory.mutate({ id, draft })}
        />
      )}
      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          danger={confirmState.danger}
          busy={mDelete.isPending || mImport.isPending || mDeleteRecurring.isPending
            || mDeleteBudget.isPending}
          onCancel={() => setConfirmState(null)}
          onConfirm={() => { confirmState.action(); setConfirmState(null); }}
        />
      )}
    </div>
  );
}
