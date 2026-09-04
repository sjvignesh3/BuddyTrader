// -----------------------------------------------------------------------------
// QuickAdd — the hero of the expense tracker. One row, two keystrokes:
// type a name (item memory autofills category / intent / payment method and
// suggests the usual amount), type the amount, Enter. Focus returns to the
// name field so a stack of receipts can be entered without touching the
// mouse. Frequent items surface as one-click chips underneath.
// -----------------------------------------------------------------------------
import { useMemo, useRef, useState } from "react";
import type { CategoryMaps } from "../../lib/expenses";
import { num, todayIso } from "../../lib/expenses";
import { fmtMoney } from "../../lib/money";
import type { ExpenseDraft, Intent, ItemMemory } from "../../lib/expensesApi";
import { PAYMENT_METHODS } from "../../lib/expensesApi";
import { GhostBtn, PrimaryBtn, Segmented, TextInput } from "../journal/ui";
// (TextInput used for the Notes field only — the name field needs a ref.)
import { CategorySelect } from "./ui";

interface Props {
  items: ItemMemory[];              // sorted by use_count desc (API order)
  maps: CategoryMaps;
  busy: boolean;
  onAdd: (draft: ExpenseDraft) => void;
}

const MAX_SUGGESTIONS = 7;

export default function QuickAdd({ items, maps, busy, onAdd }: Props) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayIso());
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [intent, setIntent] = useState<Intent | "">("");
  const [payment, setPayment] = useState<string>("UPI");
  const [notes, setNotes] = useState("");
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);            // highlighted suggestion
  const [amountHint, setAmountHint] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    const q = name.trim().toLowerCase();
    if (!q) return [];
    const starts: ItemMemory[] = [];
    const contains: ItemMemory[] = [];
    for (const it of items) {
      const n = it.name.toLowerCase();
      if (n === q) continue;                    // exact match needs no dropdown
      if (n.startsWith(q)) starts.push(it);
      else if (n.includes(q)) contains.push(it);
    }
    return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
  }, [name, items]);

  const frequent = useMemo(() => {
    const ranked = [...items].sort((a, b) =>
      Number(b.pinned) - Number(a.pinned) || b.use_count - a.use_count);
    return ranked.filter((i) => i.use_count > 0 || i.pinned).slice(0, 8);
  }, [items]);

  const applyItem = (it: ItemMemory, focusAmount = true) => {
    setName(it.name);
    if (it.category_id !== null) setCategoryId(it.category_id);
    setIntent(it.intent ?? maps.intentOf({ intent: null, category_id: it.category_id }) ?? "");
    if (it.payment_method) setPayment(it.payment_method);
    setAmountHint(it.last_amount);
    setOpen(false);
    if (focusAmount) amountRef.current?.focus();
  };

  /** When the typed name exactly matches a known item, adopt its defaults. */
  const syncKnownItem = (value: string) => {
    const hit = items.find((i) => i.name.toLowerCase() === value.trim().toLowerCase());
    if (hit) {
      if (hit.category_id !== null) setCategoryId(hit.category_id);
      setIntent(hit.intent ?? "");
      if (hit.payment_method) setPayment(hit.payment_method);
      setAmountHint(hit.last_amount);
    } else {
      setAmountHint(null);
    }
  };

  const amountNum = num(amount);
  const valid = name.trim() !== "" && amount.trim() !== ""
    && Number.isFinite(Number(amount)) && Number(amount) >= 0;
  const badAmount = amount.trim() !== "" && !(Number.isFinite(Number(amount)) && Number(amount) >= 0);

  const reset = () => {
    setName(""); setAmount(""); setNotes("");
    setCategoryId(null); setIntent(""); setAmountHint(null);
    setOpen(false);
    nameRef.current?.focus();
  };

  const submit = () => {
    if (!valid || busy) return;
    onAdd({
      name: name.trim(),
      amount,
      expense_date: date,
      category_id: categoryId,
      intent: intent || null,
      payment_method: payment || null,
      notes: notes.trim() || null,
    });
    reset();
  };

  const onNameKey = (e: React.KeyboardEvent) => {
    if (open && suggestions.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % suggestions.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === "Enter") { e.preventDefault(); applyItem(suggestions[hi]!); return; }
      if (e.key === "Escape") { setOpen(false); return; }
    }
    if (e.key === "Enter") { e.preventDefault(); amountRef.current?.focus(); }
  };

  return (
    <div className="p-4 rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card mb-4">
      <div className="flex flex-wrap items-end gap-2.5">
        {/* Name + suggestions */}
        <div className="relative flex-1 min-w-[180px]">
          <span className="block text-[10px] font-bold uppercase tracking-wider
                           text-brand-mute mb-1">What did you spend on?</span>
          {/* Raw input (not TextInput) — needs a ref for refocus-after-save. */}
          <input
            ref={nameRef}
            value={name}
            placeholder="Tea, Bus Charges, Groceries…"
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              setOpen(true); setHi(0);
              syncKnownItem(e.target.value);
            }}
            onFocus={() => name && setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onKeyDown={onNameKey}
            className="w-full rounded-lg ring-1 ring-brand-border bg-white px-2.5 py-1.5
                       text-sm focus:outline-none focus:ring-2 focus:ring-teal-600/50
                       placeholder:text-brand-mute/60"
          />
          {open && suggestions.length > 0 && (
            <ul className="absolute z-20 mt-1 w-full rounded-xl bg-brand-panel ring-1
                           ring-brand-border shadow-pop overflow-hidden">
              {suggestions.map((it, i) => (
                <li key={it.id}>
                  <button type="button"
                          onMouseDown={(e) => { e.preventDefault(); applyItem(it); }}
                          onMouseEnter={() => setHi(i)}
                          className={`w-full flex items-center justify-between gap-2 px-3 py-1.5
                                      text-left text-sm ${i === hi ? "bg-brand-soft" : ""}`}>
                    <span className="truncate">
                      {it.name}
                      <span className="ml-2 text-[10px] text-brand-mute">
                        {maps.label(it.category_id)}
                      </span>
                    </span>
                    {it.last_amount && (
                      <span className="text-[11px] text-brand-mute tabular-nums shrink-0">
                        ₹{fmtMoney(it.last_amount, 0)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Amount */}
        <div className="w-28">
          <span className="block text-[10px] font-bold uppercase tracking-wider
                           text-brand-mute mb-1">Amount</span>
          <span className="relative block">
            <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2
                                         -translate-y-1/2 text-brand-mute text-sm">₹</span>
            <input
              ref={amountRef}
              value={amount}
              inputMode="decimal"
              placeholder={amountHint ? fmtMoney(amountHint, 0) : "0"}
              aria-invalid={badAmount || undefined}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // Enter with an empty box adopts the usual amount, if known.
                  if (!amount.trim() && amountHint) { setAmount(String(num(amountHint))); return; }
                  submit();
                }
              }}
              className={`w-full rounded-lg ring-1 pl-7 pr-2.5 py-1.5 text-sm tabular-nums
                          focus:outline-none focus:ring-2 placeholder:text-brand-mute/60 ${
                badAmount ? "ring-rose-400 bg-rose-50/60 focus:ring-rose-500/60"
                          : "ring-brand-border bg-white focus:ring-teal-600/50"}`}
            />
          </span>
        </div>

        {/* Date */}
        <div className="w-36">
          <span className="block text-[10px] font-bold uppercase tracking-wider
                           text-brand-mute mb-1">Date</span>
          <input type="date" value={date} max={todayIso()}
                 onChange={(e) => setDate(e.target.value || todayIso())}
                 className="w-full rounded-lg ring-1 ring-brand-border bg-white px-2 py-1.5
                            text-sm focus:outline-none focus:ring-2 focus:ring-teal-600/50" />
        </div>

        {/* Category */}
        <div className="w-48">
          <span className="block text-[10px] font-bold uppercase tracking-wider
                           text-brand-mute mb-1">Category</span>
          <CategorySelect value={categoryId} onChange={setCategoryId} maps={maps} />
        </div>

        {/* Intent */}
        <div>
          <span className="block text-[10px] font-bold uppercase tracking-wider
                           text-brand-mute mb-1">Need / Want</span>
          <Segmented<Intent | "">
            ariaLabel="Need or want"
            options={[
              { value: "need", label: "Need", activeCls: "bg-sky-700 text-white ring-sky-700" },
              { value: "want", label: "Want", activeCls: "bg-amber-600 text-white ring-amber-600" },
              { value: "", label: "—", title: "Not classified" },
            ]}
            value={intent}
            onChange={setIntent}
          />
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <GhostBtn onClick={() => setMore((m) => !m)} title="Payment method & notes">
            {more ? "Less ▴" : "More ▾"}
          </GhostBtn>
          <PrimaryBtn disabled={!valid || busy} onClick={submit}>
            {busy ? "Saving…" : `Add${valid && amountNum > 0 ? ` ₹${fmtMoney(amountNum, 0)}` : ""}`}
          </PrimaryBtn>
        </div>
      </div>

      {/* Extra fields — hidden by default to keep entry frictionless */}
      {more && (
        <div className="flex flex-wrap items-end gap-2.5 mt-3 pt-3 border-t border-brand-border/60">
          <div>
            <span className="block text-[10px] font-bold uppercase tracking-wider
                             text-brand-mute mb-1">Payment</span>
            <Segmented<string>
              ariaLabel="Payment method"
              options={PAYMENT_METHODS.map((p) => ({ value: p, label: p }))}
              value={payment}
              onChange={setPayment}
            />
          </div>
          <div className="flex-1 min-w-[200px]">
            <span className="block text-[10px] font-bold uppercase tracking-wider
                             text-brand-mute mb-1">Notes</span>
            <TextInput value={notes} placeholder="Optional context…"
                       onChange={(e) => setNotes(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && submit()} />
          </div>
        </div>
      )}

      {/* Frequent-item chips */}
      {frequent.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          <span className="text-[10px] font-bold uppercase tracking-wider text-brand-mute mr-1">
            Frequent
          </span>
          {frequent.map((it) => (
            <button key={it.id} type="button"
                    onClick={() => applyItem(it)}
                    title={`${maps.label(it.category_id)} — used ${it.use_count}×`}
                    className="px-2.5 py-1 rounded-full text-[11px] font-medium ring-1
                               ring-brand-border bg-brand-soft text-brand-text
                               hover:bg-teal-50 hover:ring-teal-300 transition-colors">
              {it.pinned && <span aria-hidden className="mr-0.5">📌</span>}
              {it.name}
              {it.last_amount && (
                <span className="ml-1 text-brand-mute tabular-nums">
                  ₹{fmtMoney(it.last_amount, 0)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
