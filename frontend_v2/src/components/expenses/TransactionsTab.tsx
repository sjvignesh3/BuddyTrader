// -----------------------------------------------------------------------------
// Transactions — grouped history (Today / Yesterday / dates) with search,
// category / intent filters and per-row edit · duplicate · delete. Scoped to
// the selected month by default; "All history" widens the net for searches.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import type { CategoryMaps } from "../../lib/expenses";
import { monthKey, monthLabel, num, todayIso } from "../../lib/expenses";
import { fmtMoney } from "../../lib/money";
import type { Expense, Intent } from "../../lib/expensesApi";
import { EmptyState, GhostBtn, RowBtn, Segmented } from "../journal/ui";
import { CategoryChip, IntentDot } from "./ui";

interface Props {
  expenses: Expense[];             // all history, date desc
  maps: CategoryMaps;
  monthSel: string;
  /** Root category filter pushed from the Overview drill-down (0 = uncategorised). */
  rootFilter: number | null;
  onRootFilter: (id: number | null) => void;
  onEdit: (e: Expense) => void;
  onDuplicate: (e: Expense) => void;
  onDelete: (e: Expense) => void;
}

const dateHeading = (iso: string): string => {
  const today = todayIso();
  if (iso === today) return "Today";
  const y = new Date(`${today}T00:00:00`);
  y.setDate(y.getDate() - 1);
  const yIso = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  if (iso === yIso) return "Yesterday";
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short", day: "2-digit", month: "short", year: "numeric",
  });
};

export default function TransactionsTab({
  expenses, maps, monthSel, rootFilter, onRootFilter,
  onEdit, onDuplicate, onDelete,
}: Props) {
  const [q, setQ] = useState("");
  const [intent, setIntent] = useState<Intent | "all">("all");
  const [scope, setScope] = useState<"month" | "all">("month");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return expenses.filter((e) => {
      if (scope === "month" && monthKey(e.expense_date) !== monthSel) return false;
      if (rootFilter !== null &&
          (maps.rootOf(e.category_id)?.id ?? 0) !== rootFilter) return false;
      if (intent !== "all" && maps.intentOf(e) !== intent) return false;
      if (needle) {
        const hay = `${e.name} ${e.merchant ?? ""} ${e.notes ?? ""} ${
          maps.label(e.category_id)}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [expenses, maps, monthSel, rootFilter, intent, q, scope]);

  const groups = useMemo(() => {
    const map = new Map<string, Expense[]>();
    for (const e of filtered) {
      const list = map.get(e.expense_date) ?? [];
      list.push(e);
      map.set(e.expense_date, list);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  const total = filtered.reduce(
    (s, e) => s + (maps.isExcluded(e.category_id) ? 0 : num(e.amount)), 0);

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, merchant, notes…"
          className="w-56 rounded-lg ring-1 ring-brand-border bg-white px-2.5 py-1.5 text-sm
                     focus:outline-none focus:ring-2 focus:ring-teal-600/50
                     placeholder:text-brand-mute/60"
        />
        <select
          value={rootFilter === null ? "" : String(rootFilter)}
          onChange={(e) => onRootFilter(e.target.value === "" ? null : Number(e.target.value))}
          className="rounded-lg ring-1 ring-brand-border bg-white px-2 py-1.5 text-sm
                     focus:outline-none focus:ring-2 focus:ring-teal-600/50">
          <option value="">All categories</option>
          {maps.roots.map((r) => (
            <option key={r.id} value={r.id}>{r.icon} {r.name}</option>
          ))}
          <option value="0">Uncategorised</option>
        </select>
        <Segmented<Intent | "all">
          ariaLabel="Intent filter"
          options={[
            { value: "all", label: "All" },
            { value: "need", label: "Needs", activeCls: "bg-sky-700 text-white ring-sky-700" },
            { value: "want", label: "Wants", activeCls: "bg-amber-600 text-white ring-amber-600" },
          ]}
          value={intent} onChange={setIntent}
        />
        <Segmented<"month" | "all">
          ariaLabel="Scope"
          options={[
            { value: "month", label: monthLabel(monthSel, true) },
            { value: "all", label: "All history" },
          ]}
          value={scope} onChange={setScope}
        />
        <span className="ml-auto text-[12px] text-brand-mute tabular-nums">
          {filtered.length} entr{filtered.length === 1 ? "y" : "ies"} ·
          spend <b className="text-brand-text">₹{fmtMoney(total, 0)}</b>
        </span>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          text={q || rootFilter !== null || intent !== "all"
            ? "Nothing matches these filters."
            : `No expenses in ${monthLabel(monthSel)} yet — add one above.`}
          action={(q || rootFilter !== null) ? (
            <GhostBtn onClick={() => { setQ(""); onRootFilter(null); setIntent("all"); }}>
              Clear filters
            </GhostBtn>
          ) : undefined}
        />
      ) : (
        <div className="space-y-3">
          {groups.map(([iso, rows]) => {
            const dayTotal = rows.reduce(
              (s, e) => s + (maps.isExcluded(e.category_id) ? 0 : num(e.amount)), 0);
            return (
              <section key={iso}
                       className="rounded-2xl bg-brand-panel ring-1 ring-brand-border
                                  shadow-card overflow-hidden">
                <header className="flex items-center justify-between px-3.5 py-2
                                   bg-brand-soft border-b border-brand-border/60">
                  <span className="text-[11px] font-bold uppercase tracking-wider
                                   text-brand-mute">
                    {dateHeading(iso)}
                  </span>
                  <span className="text-[12px] font-semibold tabular-nums">
                    ₹{fmtMoney(dayTotal, 0)}
                  </span>
                </header>
                <ul className="divide-y divide-brand-border/40">
                  {rows.map((e) => {
                    const excluded = maps.isExcluded(e.category_id);
                    return (
                      <li key={e.id}
                          className="group flex items-center gap-2.5 px-3.5 py-2 hover:bg-brand-soft/60">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[13px] font-medium truncate">{e.name}</span>
                            <IntentDot intent={maps.intentOf(e)} />
                            {e.recurring_id !== null && (
                              <span title="From a recurring template" aria-hidden
                                    className="text-[10px]">🔁</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 min-w-0">
                            <CategoryChip categoryId={e.category_id} maps={maps} />
                            {e.payment_method && (
                              <span className="text-[10px] text-brand-mute">{e.payment_method}</span>
                            )}
                            {(e.merchant || e.notes) && (
                              <span className="text-[10px] text-brand-mute truncate"
                                    title={[e.merchant, e.notes].filter(Boolean).join(" — ")}>
                                {[e.merchant, e.notes].filter(Boolean).join(" — ")}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className={`text-[13px] font-semibold tabular-nums whitespace-nowrap ${
                          excluded ? "text-brand-mute line-through decoration-brand-mute/40" : ""}`}
                              title={excluded ? "Excluded from spending totals" : undefined}>
                          ₹{fmtMoney(e.amount, num(e.amount) % 1 ? 2 : 0)}
                        </span>
                        <span className="flex items-center opacity-0 group-hover:opacity-100
                                         transition-opacity">
                          <RowBtn title="Edit" onClick={() => onEdit(e)}>✎</RowBtn>
                          <RowBtn title="Repeat today (duplicate)" onClick={() => onDuplicate(e)}>⧉</RowBtn>
                          <RowBtn danger title="Delete" onClick={() => onDelete(e)}>🗑</RowBtn>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
