// -----------------------------------------------------------------------------
// Planning — recurring commitments and optional budgets. Recurring templates
// are never auto-posted (manual-first philosophy): each one shows whether it
// has been logged this month and offers a one-click "Log" that creates the
// linked expense.
// -----------------------------------------------------------------------------
import { useMemo } from "react";
import type { CategoryMaps, MonthStats } from "../../lib/expenses";
import { monthKey, monthLabel, num, recurringMonthlyLoad, statsFor } from "../../lib/expenses";
import { fmtMoney } from "../../lib/money";
import type { Budget, Expense, Recurring } from "../../lib/expensesApi";
import { GhostBtn, PrimaryBtn, RowBtn } from "../journal/ui";
import { BudgetBar, CategoryChip, SectionCard } from "./ui";

interface Props {
  recurring: Recurring[];
  budgets: Budget[];
  expenses: Expense[];
  monthly: Map<string, MonthStats>;
  maps: CategoryMaps;
  monthSel: string;
  busy: boolean;
  onAddRecurring: () => void;
  onEditRecurring: (r: Recurring) => void;
  onDeleteRecurring: (r: Recurring) => void;
  onToggleRecurring: (r: Recurring) => void;
  onLogRecurring: (r: Recurring) => void;
  onAddBudget: () => void;
  onEditBudget: (b: Budget) => void;
  onDeleteBudget: (b: Budget) => void;
}

const FREQ_LABEL: Record<string, string> = {
  weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly",
};

export default function PlanningTab({
  recurring, budgets, expenses, monthly, maps, monthSel, busy,
  onAddRecurring, onEditRecurring, onDeleteRecurring, onToggleRecurring,
  onLogRecurring, onAddBudget, onEditBudget, onDeleteBudget,
}: Props) {
  const cur = statsFor(monthly, monthSel);

  /** recurring id → logged amount in the selected month (0 = not logged). */
  const loggedThisMonth = useMemo(() => {
    const map = new Map<number, number>();
    for (const e of expenses) {
      if (e.recurring_id !== null && monthKey(e.expense_date) === monthSel) {
        map.set(e.recurring_id, (map.get(e.recurring_id) ?? 0) + num(e.amount));
      }
    }
    return map;
  }, [expenses, monthSel]);

  const active = recurring.filter((r) => r.active);
  const inactive = recurring.filter((r) => !r.active);
  const lockedIn = recurringMonthlyLoad(recurring);

  const budgetRows = budgets.map((b) => {
    const limit = num(b.monthly_amount);
    const spent = b.category_id === null
      ? cur.total
      : cur.byRoot.get(b.category_id) ?? cur.bySub.get(b.category_id)?.total ?? 0;
    const name = b.category_id === null
      ? "Overall monthly budget"
      : maps.label(b.category_id);
    return { budget: b, name, spent, limit };
  }).sort((a, b) => (b.spent / b.limit) - (a.spent / a.limit));

  const recurRow = (r: Recurring) => {
    const logged = loggedThisMonth.get(r.id) ?? 0;
    const isMonthlyDue = r.frequency === "monthly" || r.frequency === "weekly";
    return (
      <li key={r.id}
          className={`group flex items-center gap-2.5 px-3.5 py-2.5 ${
            r.active ? "" : "opacity-55"}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium truncate">{r.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-soft ring-1
                             ring-brand-border text-brand-mute font-semibold">
              {FREQ_LABEL[r.frequency] ?? r.frequency}
              {r.frequency === "monthly" && r.due_day ? ` · day ${r.due_day}` : ""}
            </span>
            {logged > 0 ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-50 ring-1
                               ring-teal-200 text-teal-800 font-semibold">
                ✓ logged {monthLabel(monthSel, true)}
              </span>
            ) : (r.active && isMonthlyDue && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 ring-1
                               ring-amber-200 text-amber-800 font-semibold">
                not logged yet
              </span>
            ))}
          </div>
          <div className="mt-0.5">
            <CategoryChip categoryId={r.category_id} maps={maps} />
          </div>
        </div>
        <span className="text-[13px] font-semibold tabular-nums whitespace-nowrap">
          ₹{fmtMoney(r.amount, 0)}
        </span>
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100
                         transition-opacity">
          {r.active && logged === 0 && (
            <button onClick={() => onLogRecurring(r)} disabled={busy}
                    className="px-2 py-1 rounded-lg text-[11px] font-semibold bg-teal-700
                               text-white hover:bg-teal-800 disabled:opacity-50">
              Log now
            </button>
          )}
          <RowBtn title={r.active ? "Pause" : "Resume"}
                  onClick={() => onToggleRecurring(r)}>
            {r.active ? "⏸" : "▶"}
          </RowBtn>
          <RowBtn title="Edit" onClick={() => onEditRecurring(r)}>✎</RowBtn>
          <RowBtn danger title="Delete" onClick={() => onDeleteRecurring(r)}>🗑</RowBtn>
        </span>
      </li>
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2 items-start">
      {/* ---- Recurring ---- */}
      <SectionCard
        title="Recurring commitments"
        right={<PrimaryBtn onClick={onAddRecurring}>+ Recurring</PrimaryBtn>}>
        {recurring.length === 0 ? (
          <p className="text-sm text-brand-mute py-4 text-center">
            Rent, internet, subscriptions… mark them recurring to see your
            locked-in monthly load and log them in one click.
          </p>
        ) : (
          <>
            <p className="text-[12px] text-brand-mute mb-2">
              Locked in: <b className="text-brand-text">₹{fmtMoney(lockedIn, 0)}/month</b>
              {" "}across {active.length} active commitment{active.length === 1 ? "" : "s"}.
            </p>
            <ul className="divide-y divide-brand-border/40 -mx-3.5">
              {active.map(recurRow)}
              {inactive.map(recurRow)}
            </ul>
          </>
        )}
      </SectionCard>

      {/* ---- Budgets ---- */}
      <SectionCard
        title={`Budgets — ${monthLabel(monthSel)}`}
        right={<GhostBtn onClick={onAddBudget}>+ Budget</GhostBtn>}>
        {budgetRows.length === 0 ? (
          <p className="text-sm text-brand-mute py-4 text-center">
            Budgets are optional — set one per category (or one overall cap)
            to get a quiet progress bar and an alert when it runs hot.
          </p>
        ) : (
          <div className="space-y-4">
            {budgetRows.map(({ budget, name, spent, limit }) => (
              <div key={budget.id} className="group">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12px] font-medium">{name}</span>
                  <span className="flex items-center opacity-0 group-hover:opacity-100
                                   transition-opacity">
                    <RowBtn title="Edit amount" onClick={() => onEditBudget(budget)}>✎</RowBtn>
                    <RowBtn danger title="Remove budget"
                            onClick={() => onDeleteBudget(budget)}>🗑</RowBtn>
                  </span>
                </div>
                <BudgetBar spent={spent} limit={limit} />
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
