// -----------------------------------------------------------------------------
// Expense modals — full expense editor, recurring template, budget, and the
// category manager. Form state lives as strings; drafts are cleaned on save
// (journal modal conventions).
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import type { CategoryMaps } from "../../lib/expenses";
import { todayIso } from "../../lib/expenses";
import type {
  Budget, Category, CategoryDraft, Expense, ExpenseDraft, Frequency,
  Intent, Recurring, RecurringDraft,
} from "../../lib/expensesApi";
import { PAYMENT_METHODS } from "../../lib/expensesApi";
import {
  Field, GhostBtn, Modal, NumInput, PrimaryBtn, RowBtn, Segmented, TextArea,
  TextInput,
} from "../journal/ui";
import { CategorySelect } from "./ui";

const badNum = (s: string): boolean =>
  s.trim() !== "" && !(Number.isFinite(Number(s)) && Number(s) >= 0);

// ---- Expense editor ---------------------------------------------------------------

export function ExpenseModal({ initial, maps, busy, onClose, onSave }: {
  initial: Expense | null;          // null = new full-form entry
  maps: CategoryMaps;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: ExpenseDraft) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [date, setDate] = useState(initial?.expense_date ?? todayIso());
  const [categoryId, setCategoryId] = useState<number | null>(initial?.category_id ?? null);
  const [intent, setIntent] = useState<Intent | "">(initial?.intent ?? "");
  const [payment, setPayment] = useState(initial?.payment_method ?? "UPI");
  const [merchant, setMerchant] = useState(initial?.merchant ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const valid = name.trim() !== "" && amount.trim() !== "" && !badNum(amount) && !!date;

  return (
    <Modal title={initial ? "Edit expense" : "Add expense"} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" span2>
          <TextInput value={name} autoFocus placeholder="Tea, Rent, Cinema…"
                     onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Amount (₹)">
          <NumInput prefix="₹" value={amount} inputMode="decimal"
                    invalid={badNum(amount)}
                    onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Date">
          <input type="date" value={date}
                 onChange={(e) => setDate(e.target.value)}
                 className="w-full rounded-lg ring-1 ring-brand-border bg-white px-2 py-1.5
                            text-sm focus:outline-none focus:ring-2 focus:ring-teal-600/50" />
        </Field>
        <Field label="Category" span2>
          <CategorySelect value={categoryId} onChange={setCategoryId} maps={maps} />
        </Field>
        <Field label="Need / Want">
          <Segmented<Intent | "">
            ariaLabel="Need or want"
            options={[
              { value: "need", label: "Need", activeCls: "bg-sky-700 text-white ring-sky-700" },
              { value: "want", label: "Want", activeCls: "bg-amber-600 text-white ring-amber-600" },
              { value: "", label: "—" },
            ]}
            value={intent} onChange={setIntent} />
        </Field>
        <Field label="Payment">
          <Segmented<string>
            ariaLabel="Payment method"
            options={PAYMENT_METHODS.map((p) => ({ value: p, label: p }))}
            value={payment || "UPI"} onChange={setPayment} />
        </Field>
        <Field label="Merchant / vendor">
          <TextInput value={merchant} placeholder="Optional"
                     onChange={(e) => setMerchant(e.target.value)} />
        </Field>
        <Field label="Notes" span2>
          <TextArea value={notes} placeholder="Optional context…"
                    onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={!valid || busy}
                    onClick={() => onSave({
                      name: name.trim(), amount, expense_date: date,
                      category_id: categoryId, intent: intent || null,
                      payment_method: payment || null,
                      merchant: merchant.trim() || null,
                      notes: notes.trim() || null,
                    })}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add expense"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Recurring template -------------------------------------------------------------

export function RecurringModal({ initial, maps, busy, onClose, onSave }: {
  initial: Recurring | null;
  maps: CategoryMaps;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: RecurringDraft) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [frequency, setFrequency] = useState<Frequency>(initial?.frequency ?? "monthly");
  const [dueDay, setDueDay] = useState(initial?.due_day ? String(initial.due_day) : "");
  const [categoryId, setCategoryId] = useState<number | null>(initial?.category_id ?? null);
  const [intent, setIntent] = useState<Intent | "">(initial?.intent ?? "need");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const badDay = dueDay.trim() !== "" &&
    !(Number.isInteger(Number(dueDay)) && Number(dueDay) >= 1 && Number(dueDay) <= 31);
  const valid = name.trim() !== "" && amount.trim() !== "" && !badNum(amount) && !badDay;

  return (
    <Modal title={initial ? "Edit recurring" : "New recurring commitment"} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" span2>
          <TextInput value={name} autoFocus placeholder="Rent, Netflix, Internet…"
                     onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Expected amount (₹)">
          <NumInput prefix="₹" value={amount} inputMode="decimal" invalid={badNum(amount)}
                    onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Frequency">
          <Segmented<Frequency>
            ariaLabel="Frequency"
            options={[
              { value: "weekly", label: "Wk" }, { value: "monthly", label: "Mo" },
              { value: "quarterly", label: "Qtr" }, { value: "yearly", label: "Yr" },
            ]}
            value={frequency} onChange={setFrequency} />
        </Field>
        {frequency === "monthly" && (
          <Field label="Due day of month">
            <NumInput value={dueDay} inputMode="numeric" placeholder="e.g. 11"
                      invalid={badDay}
                      onChange={(e) => setDueDay(e.target.value)} />
          </Field>
        )}
        <Field label="Category" span2>
          <CategorySelect value={categoryId} onChange={setCategoryId} maps={maps} />
        </Field>
        <Field label="Need / Want">
          <Segmented<Intent | "">
            ariaLabel="Need or want"
            options={[
              { value: "need", label: "Need", activeCls: "bg-sky-700 text-white ring-sky-700" },
              { value: "want", label: "Want", activeCls: "bg-amber-600 text-white ring-amber-600" },
              { value: "", label: "—" },
            ]}
            value={intent} onChange={setIntent} />
        </Field>
        <Field label="Notes" span2>
          <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={!valid || busy}
                    onClick={() => onSave({
                      name: name.trim(), amount, frequency,
                      due_day: dueDay.trim() ? Number(dueDay) : null,
                      category_id: categoryId, intent: intent || null,
                      notes: notes.trim() || null,
                    })}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add recurring"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Budget --------------------------------------------------------------------------

export function BudgetModal({ initial, maps, busy, existing, onClose, onSave }: {
  initial: Budget | null;
  maps: CategoryMaps;
  busy: boolean;
  /** category ids that already carry a budget (excluded from the picker). */
  existing: (number | null)[];
  onClose: () => void;
  onSave: (categoryId: number | null, amount: string) => void;
}) {
  const [categoryId, setCategoryId] = useState<number | null>(initial?.category_id ?? null);
  const [amount, setAmount] = useState(initial?.monthly_amount ?? "");
  const locked = initial !== null;    // editing = amount only

  const options = useMemo(() => {
    const taken = new Set(existing.map((v) => v ?? 0));
    const opts: { value: string; label: string }[] = [];
    if (!taken.has(0) || (locked && initial?.category_id === null)) {
      opts.push({ value: "", label: "Overall (all spending)" });
    }
    maps.roots.forEach((r) => {
      if (!taken.has(r.id) || (locked && initial?.category_id === r.id)) {
        opts.push({ value: String(r.id), label: `${r.icon ?? ""} ${r.name}`.trim() });
      }
    });
    return opts;
  }, [maps, existing, locked, initial]);

  const valid = amount.trim() !== "" && !badNum(amount) && Number(amount) > 0;

  return (
    <Modal title={locked ? "Edit budget" : "Set a budget"} onClose={onClose}>
      <div className="grid gap-3">
        <Field label="Scope">
          <select
            value={categoryId === null ? "" : String(categoryId)}
            disabled={locked}
            onChange={(e) => setCategoryId(e.target.value === "" ? null : Number(e.target.value))}
            className="w-full rounded-lg ring-1 ring-brand-border bg-white px-2 py-1.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-teal-600/50
                       disabled:opacity-60">
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Monthly limit (₹)">
          <NumInput prefix="₹" value={amount} inputMode="decimal" autoFocus={locked}
                    invalid={badNum(amount)}
                    onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={!valid || busy}
                    onClick={() => onSave(categoryId, amount)}>
          {busy ? "Saving…" : "Save budget"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Category manager -----------------------------------------------------------------

export function CategoryManagerModal({ maps, busy, onClose, onCreate, onUpdate }: {
  maps: CategoryMaps;
  busy: boolean;
  onClose: () => void;
  onCreate: (draft: CategoryDraft) => void;
  onUpdate: (id: number, draft: CategoryDraft) => void;
}) {
  const [addingUnder, setAddingUnder] = useState<number | null | "root">(null);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<Category | null>(null);
  const [renameTo, setRenameTo] = useState("");

  const submitAdd = () => {
    if (!newName.trim()) return;
    onCreate({
      name: newName.trim(),
      parent_id: addingUnder === "root" || addingUnder === null ? null : addingUnder,
    });
    setNewName(""); setAddingUnder(null);
  };

  const intentCycle: (Intent | null)[] = ["need", "want", null];
  const intentBadge = (c: Category) => {
    const label = c.default_intent === "need" ? "Need"
      : c.default_intent === "want" ? "Want" : "—";
    const cls = c.default_intent === "need" ? "bg-sky-50 text-sky-800 ring-sky-200"
      : c.default_intent === "want" ? "bg-amber-50 text-amber-800 ring-amber-200"
      : "bg-brand-soft text-brand-mute ring-brand-border";
    const next = intentCycle[(intentCycle.indexOf(c.default_intent) + 1) % 3] ?? null;
    return (
      <button disabled={busy} title="Default need/want for this category — click to cycle"
              onClick={() => onUpdate(c.id, { default_intent: next })}
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ring-1 ${cls}`}>
        {label}
      </button>
    );
  };

  const row = (c: Category, isRoot: boolean) => (
    <div key={c.id}
         className={`flex items-center gap-2 py-1 ${isRoot ? "" : "pl-6"}`}>
      {renaming?.id === c.id ? (
        <span className="flex items-center gap-1.5 flex-1">
          <TextInput value={renameTo} autoFocus
                     onChange={(e) => setRenameTo(e.target.value)}
                     onKeyDown={(e) => {
                       if (e.key === "Enter" && renameTo.trim()) {
                         onUpdate(c.id, { name: renameTo.trim() });
                         setRenaming(null);
                       }
                       if (e.key === "Escape") setRenaming(null);
                     }} />
          <PrimaryBtn disabled={!renameTo.trim() || busy}
                      onClick={() => { onUpdate(c.id, { name: renameTo.trim() }); setRenaming(null); }}>
            ✓
          </PrimaryBtn>
        </span>
      ) : (
        <>
          <span className={`flex-1 truncate text-[13px] ${isRoot ? "font-semibold" : ""} ${
            c.archived ? "line-through text-brand-mute" : ""}`}>
            {isRoot && c.icon && <span aria-hidden className="mr-1">{c.icon}</span>}
            {c.name}
            {c.exclude_from_spending && (
              <span title="Excluded from spending totals (transfers/investments)"
                    className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-stone-100
                               ring-1 ring-stone-200 text-stone-500 font-bold uppercase">
                excluded
              </span>
            )}
          </span>
          {intentBadge(c)}
          <RowBtn title="Rename"
                  onClick={() => { setRenaming(c); setRenameTo(c.name); }}>✎</RowBtn>
          {isRoot && (
            <RowBtn title="Add sub-category"
                    onClick={() => { setAddingUnder(c.id); setNewName(""); }}>＋</RowBtn>
          )}
          <RowBtn danger={!c.archived}
                  title={c.archived ? "Restore" : "Archive (hidden from pickers; history kept)"}
                  onClick={() => onUpdate(c.id, { archived: !c.archived })}>
            {c.archived ? "↺" : "🗄"}
          </RowBtn>
        </>
      )}
    </div>
  );

  // Include archived roots/subs so they can be restored.
  const allRoots = [...maps.byId.values()]
    .filter((c) => c.parent_id === null)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  return (
    <Modal title="Manage categories" onClose={onClose} wide>
      <p className="text-[12px] text-brand-mute mb-3">
        Two levels: top-level groups and sub-categories. The Need/Want chip sets the
        default for new expenses in that category (each expense can still override it).
      </p>
      <div className="max-h-[52vh] overflow-y-auto pr-1 divide-y divide-brand-border/40">
        {allRoots.map((root) => {
          const kids = [...maps.byId.values()]
            .filter((c) => c.parent_id === root.id)
            .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
          return (
            <div key={root.id} className="py-1.5">
              {row(root, true)}
              {kids.map((k) => row(k, false))}
              {addingUnder === root.id && (
                <div className="flex items-center gap-1.5 pl-6 py-1">
                  <TextInput value={newName} autoFocus placeholder={`New sub-category of ${root.name}`}
                             onChange={(e) => setNewName(e.target.value)}
                             onKeyDown={(e) => e.key === "Enter" && submitAdd()} />
                  <PrimaryBtn disabled={!newName.trim() || busy} onClick={submitAdd}>Add</PrimaryBtn>
                  <GhostBtn onClick={() => setAddingUnder(null)}>✕</GhostBtn>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 pt-3 border-t border-brand-border/60">
        {addingUnder === "root" ? (
          <div className="flex items-center gap-1.5">
            <TextInput value={newName} autoFocus placeholder="New top-level category"
                       onChange={(e) => setNewName(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && submitAdd()} />
            <PrimaryBtn disabled={!newName.trim() || busy} onClick={submitAdd}>Add</PrimaryBtn>
            <GhostBtn onClick={() => setAddingUnder(null)}>✕</GhostBtn>
          </div>
        ) : (
          <GhostBtn onClick={() => { setAddingUnder("root"); setNewName(""); }}>
            + Top-level category
          </GhostBtn>
        )}
      </div>
    </Modal>
  );
}
