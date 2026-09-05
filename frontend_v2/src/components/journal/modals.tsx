// -----------------------------------------------------------------------------
// Journal form modals: opportunity add/edit, trade add/edit, convert, close.
// Forms keep values as strings and hand the API a cleaned draft on save.
// Numbers are validated as you type (red ring) — a bad value blocks Save
// instead of travelling to the API and failing as a 502.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import type {
  ActionFilter, CapBucket, Opportunity, OpportunityDraft, Trade, TradeDraft,
} from "../../lib/journalApi";
import { CAP_LIMITS, effectiveCap, num, type JournalCtx } from "../../lib/journal";
import { fmtMoney } from "../../lib/money";
import AllocationGauge from "./AllocationGauge";
import {
  CAP_STYLES, Field, GhostBtn, Modal, NumInput, PrimaryBtn, Segmented,
  SuggestionChips, TextArea, TextInput,
} from "./ui";

const today = () => new Date().toISOString().slice(0, 10);

const STRATEGIES = ["SR", "20% rally", "Envelope", "SMA", "52WHL", "Averaging",
                    "ABCD", "Knox", "Envelope + Knox"];

const ACTION_ACTIVE: Record<ActionFilter, string> = {
  "Buy Now": "bg-teal-700 text-white ring-teal-700",
  GTT: "bg-teal-50 text-teal-800 ring-teal-400",
  "Analyse Now": "bg-amber-100 text-amber-900 ring-amber-400",
  Later: "bg-stone-200 text-stone-700 ring-stone-300",
};

/** Segmented options for the cap bucket, coloured like the CapChip. */
function capOptions(autoLabel: string) {
  return [
    { value: "" as const, label: autoLabel, title: "Use the bucket from market data" },
    ...(Object.keys(CAP_LIMITS) as CapBucket[]).map((c) => ({
      value: c,
      label: c,
      activeCls: `${CAP_STYLES[c]} ring-1`,
      title: `${c} cap — allocation limit ${CAP_LIMITS[c]}% of capital per stock`,
    })),
  ];
}

// ---- Numeric string handling -------------------------------------------------

/** "1,234.5 " → "1234.5"; "" → null; unparseable/≤0 → null. */
function numOrNull(s: string): string | null {
  const t = s.trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? t : null;
}
/** Non-empty but not a positive number — the "block Save" state. */
function badNum(s: string): boolean {
  return s.trim() !== "" && numOrNull(s) === null;
}
function intOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Math.round(Number(t));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function badInt(s: string): boolean {
  return s.trim() !== "" && intOrNull(s) === null;
}
function toNum(s: string): number | null {
  const v = numOrNull(s);
  return v === null ? null : Number(v);
}

/** Live "the plan at a glance" strip shown inside the form footer. */
function PlanSummary({ buy, qty, target }: { buy: string; qty: string; target: string }) {
  const b = toNum(buy);
  const q = intOrNull(qty);
  const t = toNum(target);
  const needs = b !== null && q !== null ? b * q : null;
  const potPct = b !== null && t !== null ? ((t - b) / b) * 100 : null;
  const potGain = potPct !== null && q !== null ? (t! - b!) * q : null;
  if (needs === null && potPct === null) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-brand-mute
                    bg-brand-soft rounded-lg px-3 py-2 ring-1 ring-brand-border/60 mt-4">
      {needs !== null && (
        <span>Needs <b className="text-brand-text font-mono">₹{fmtMoney(needs, 0)}</b></span>
      )}
      {potPct !== null && (
        <span>Potential <b className={`font-mono ${potPct >= 0 ? "text-teal-700" : "text-rose-700"}`}>
          {potPct >= 0 ? "+" : ""}{potPct.toFixed(2)}%</b>
          {potGain !== null && <> (₹{fmtMoney(potGain, 0)})</>}
        </span>
      )}
    </div>
  );
}

// ---- Opportunity ---------------------------------------------------------------

export function OpportunityModal({ initial, prefill, ctx, onSave, onClose, busy }: {
  initial: Opportunity | null;
  /** Defaults for a NEW opportunity (e.g. from the stock page) — ignored when editing. */
  prefill?: OpportunityDraft;
  /** Capital + open lots, for the live allocation gauge. */
  ctx: JournalCtx;
  onSave: (draft: OpportunityDraft) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [f, setF] = useState({
    opp_date: initial?.opp_date ?? prefill?.opp_date ?? today(),
    symbol: initial?.symbol ?? prefill?.symbol ?? "",
    cap_bucket: initial?.cap_bucket ?? prefill?.cap_bucket ?? "",
    buy_price: initial?.buy_price ?? prefill?.buy_price ?? "",
    limit_price: initial?.limit_price ?? prefill?.limit_price ?? "",
    qty: initial?.qty?.toString() ?? prefill?.qty?.toString() ?? "",
    strategy: initial?.strategy ?? prefill?.strategy ?? "",
    target_price: initial?.target_price ?? prefill?.target_price ?? "",
    action_filter: initial?.action_filter ?? prefill?.action_filter ?? "",
    notes: initial?.notes ?? prefill?.notes ?? "",
  });
  const set = (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));
  const setV = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  // Validation — what actually blocks Save, with the reason shown.
  const problem = useMemo(() => {
    if (!f.symbol.trim()) return "Symbol is required";
    if (!f.opp_date) return "Date is required";
    if (badNum(f.buy_price)) return "Buy price must be a positive number";
    if (badNum(f.limit_price)) return "Limit price must be a positive number";
    if (badInt(f.qty)) return "Qty must be a positive whole number";
    if (badNum(f.target_price)) return "Target must be a positive number";
    return null;
  }, [f]);

  // Soft completeness — what each still-empty field would unlock. Allocation
  // itself is live in the gauge below, so this only names what's still blank.
  const missing = useMemo(() => {
    const m: string[] = [];
    if (!numOrNull(f.buy_price) || !intOrNull(f.qty)) {
      m.push("buy price + qty size the allocation above");
    }
    if (!numOrNull(f.target_price)) m.push("a target gives potential % and gain ₹");
    return m;
  }, [f]);

  const symbolKey = f.symbol.trim().toUpperCase();
  // Buy price is the trigger; fall back to the GTT limit when only that is set.
  const planPrice = toNum(f.buy_price) ?? toNum(f.limit_price);

  const save = () => onSave({
    opp_date: f.opp_date || null,
    symbol: f.symbol.trim().toUpperCase(),
    cap_bucket: (f.cap_bucket || null) as OpportunityDraft["cap_bucket"],
    buy_price: numOrNull(f.buy_price),
    limit_price: numOrNull(f.limit_price),
    qty: intOrNull(f.qty),
    strategy: f.strategy.trim() || null,
    target_price: numOrNull(f.target_price),
    action_filter: (f.action_filter || null) as OpportunityDraft["action_filter"],
    notes: f.notes.trim() || null,
  });

  return (
    <Modal title={initial ? `Edit ${initial.symbol}` : "New opportunity"} onClose={onClose}>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Symbol *">
          <TextInput value={f.symbol} onChange={set("symbol")} placeholder="RELIANCE"
                     autoFocus={!initial} style={{ textTransform: "uppercase" }} />
        </Field>
        <Field label="Date *"><TextInput type="date" value={f.opp_date} onChange={set("opp_date")} /></Field>
        <Field label="Cap bucket" span2>
          <Segmented ariaLabel="Cap bucket"
                     options={capOptions("Auto")}
                     value={(f.cap_bucket ?? "") as CapBucket | ""}
                     onChange={setV("cap_bucket")} />
        </Field>
        <Field label="Action" span2>
          <Segmented ariaLabel="Action filter"
                     options={[
                       { value: "" as const, label: "None" },
                       ...(Object.keys(ACTION_ACTIVE) as ActionFilter[]).map((a) => ({
                         value: a, label: a, activeCls: `${ACTION_ACTIVE[a]} ring-1`,
                       })),
                     ]}
                     value={(f.action_filter ?? "") as ActionFilter | ""}
                     onChange={setV("action_filter")} />
        </Field>
        <Field label="Buy price">
          <NumInput prefix="₹" inputMode="decimal" placeholder="0.00"
                    value={f.buy_price} invalid={badNum(f.buy_price)}
                    onChange={set("buy_price")} />
        </Field>
        <Field label="Limit price (GTT)">
          <NumInput prefix="₹" inputMode="decimal" placeholder="0.00"
                    value={f.limit_price} invalid={badNum(f.limit_price)}
                    onChange={set("limit_price")} />
        </Field>
        <Field label="Qty">
          <NumInput inputMode="numeric" placeholder="0"
                    value={f.qty} invalid={badInt(f.qty)} onChange={set("qty")} />
        </Field>
        <Field label="Target">
          <NumInput prefix="₹" inputMode="decimal" placeholder="0.00"
                    value={f.target_price} invalid={badNum(f.target_price)}
                    onChange={set("target_price")} />
        </Field>
        <Field label="Strategy" span2>
          <TextInput value={f.strategy} onChange={set("strategy")}
                     placeholder="Pick one below or type your own" />
          <SuggestionChips options={STRATEGIES} current={f.strategy}
                           onPick={setV("strategy")} />
        </Field>
        <Field label="Analysis notes" span2>
          <TextArea value={f.notes} onChange={set("notes")}
                    placeholder="Why this setup? Entry thesis, levels, risks…" />
        </Field>
      </div>

      <PlanSummary buy={f.buy_price} qty={f.qty} target={f.target_price} />

      <AllocationGauge
        symbol={symbolKey}
        cap={effectiveCap((f.cap_bucket || null) as CapBucket | null,
                          ctx.snaps.get(symbolKey))}
        buyPrice={planPrice} qty={intOrNull(f.qty)} ctx={ctx}
        onUseMaxQty={(q) => setF((p) => ({ ...p, qty: String(q) }))}
      />

      {problem === null && missing.length > 0 && (
        <p className="mt-2 text-[11px] text-amber-700">
          Still optional: {missing.join(" · ")}.
        </p>
      )}

      <div className="mt-5 flex items-center justify-end gap-3">
        {problem && (f.symbol.trim() || badNum(f.buy_price) || badNum(f.limit_price)
                     || badInt(f.qty) || badNum(f.target_price)) && (
          <span className="text-[11px] text-rose-600 mr-auto">{problem}</span>
        )}
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={busy || problem !== null} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Trade (add / edit; covers open and closed rows) ------------------------------

export function TradeModal({ initial, closed = false, ctx, onSave, onClose, busy }: {
  initial: Trade | null;
  /** true when editing a CLOSED row (shows sell fields). */
  closed?: boolean;
  /** Capital + open lots, for the live allocation gauge. */
  ctx: JournalCtx;
  onSave: (draft: TradeDraft) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const isClosed = closed || initial?.status === "CLOSED";
  const [f, setF] = useState({
    order_type: initial?.order_type ?? "GTT",
    cap_bucket: initial?.cap_bucket ?? "",
    symbol: initial?.symbol ?? "",
    buy_date: initial?.buy_date ?? today(),
    buy_price: initial?.buy_price ?? "",
    qty: initial?.qty?.toString() ?? "",
    strategy: initial?.strategy ?? "",
    target_price: initial?.target_price ?? "",
    sell_date: initial?.sell_date ?? today(),
    sell_price: initial?.sell_price ?? "",
    close_label: initial?.close_label ?? "Fully Booked",
    comments: initial?.comments ?? "",
    risk_notes: initial?.risk_notes ?? "",
  });
  const set = (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));
  const setV = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const problem = useMemo(() => {
    if (!f.symbol.trim()) return "Symbol is required";
    if (!f.buy_date) return "Buy date is required";
    if (!numOrNull(f.buy_price)) return "Buy price is required";
    if (!intOrNull(f.qty)) return "Qty is required (positive whole number)";
    if (badNum(f.target_price)) return "Target must be a positive number";
    if (isClosed) {
      if (!f.sell_date) return "Sell date is required";
      if (!numOrNull(f.sell_price)) return "Sell price is required";
    }
    return null;
  }, [f, isClosed]);

  const symbolKey = f.symbol.trim().toUpperCase();
  // Editing an open lot: its own value is already in openInvested, so drop it
  // before adding what the form now says — otherwise it counts twice.
  const ownHeld = initial?.status === "OPEN"
    ? (num(initial.buy_price) ?? 0) * initial.qty : 0;

  const save = () => {
    const draft: TradeDraft = {
      order_type: (f.order_type || null) as TradeDraft["order_type"],
      cap_bucket: (f.cap_bucket || null) as TradeDraft["cap_bucket"],
      symbol: f.symbol.trim().toUpperCase(),
      buy_date: f.buy_date,
      buy_price: numOrNull(f.buy_price)!,
      qty: intOrNull(f.qty)!,
      strategy: f.strategy.trim() || null,
      target_price: numOrNull(f.target_price),
      comments: f.comments.trim() || null,
      risk_notes: f.risk_notes.trim() || null,
    };
    if (isClosed) {
      draft.status = "CLOSED";
      draft.sell_date = f.sell_date;
      draft.sell_price = numOrNull(f.sell_price);
      draft.close_label = f.close_label.trim() || "Fully Booked";
    }
    onSave(draft);
  };

  return (
    <Modal onClose={onClose} wide
           title={initial ? `Edit ${initial.symbol}` : isClosed ? "New closed trade" : "New trade"}>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Symbol *">
          <TextInput value={f.symbol} onChange={set("symbol")} autoFocus={!initial}
                     placeholder="RELIANCE" style={{ textTransform: "uppercase" }} />
        </Field>
        <Field label="Order type">
          <Segmented ariaLabel="Order type"
                     options={[
                       { value: "GTT" as const, label: "GTT" },
                       { value: "Instant" as const, label: "Instant" },
                     ]}
                     value={(f.order_type ?? "GTT") as "GTT" | "Instant"}
                     onChange={setV("order_type")} />
        </Field>
        <Field label="Cap bucket" span2>
          <Segmented ariaLabel="Cap bucket"
                     options={capOptions("Auto")}
                     value={(f.cap_bucket ?? "") as CapBucket | ""}
                     onChange={setV("cap_bucket")} />
        </Field>
        <Field label="Buy date *"><TextInput type="date" value={f.buy_date} onChange={set("buy_date")} /></Field>
        <Field label="Buy price *">
          <NumInput prefix="₹" inputMode="decimal" placeholder="0.00"
                    value={f.buy_price} invalid={badNum(f.buy_price)}
                    onChange={set("buy_price")} />
        </Field>
        <Field label="Qty *">
          <NumInput inputMode="numeric" placeholder="0"
                    value={f.qty} invalid={badInt(f.qty)} onChange={set("qty")} />
        </Field>
        <Field label="Target">
          <NumInput prefix="₹" inputMode="decimal" placeholder="0.00"
                    value={f.target_price} invalid={badNum(f.target_price)}
                    onChange={set("target_price")} />
        </Field>
        <Field label="Strategy" span2>
          <TextInput value={f.strategy} onChange={set("strategy")}
                     placeholder="Pick one below or type your own" />
          <SuggestionChips options={STRATEGIES} current={f.strategy}
                           onPick={setV("strategy")} />
        </Field>
        {isClosed && (
          <>
            <Field label="Sell date *"><TextInput type="date" value={f.sell_date} onChange={set("sell_date")} /></Field>
            <Field label="Sell price *">
              <NumInput prefix="₹" inputMode="decimal" placeholder="0.00"
                        value={f.sell_price} invalid={badNum(f.sell_price)}
                        onChange={set("sell_price")} />
            </Field>
            <Field label="Close label" span2>
              <TextInput value={f.close_label} onChange={set("close_label")} />
              <SuggestionChips
                options={["Fully Booked", "Partially Booked", "Stop Loss", "Exit on thesis break"]}
                current={f.close_label} onPick={setV("close_label")} />
            </Field>
          </>
        )}
        <Field label="Comments" span2><TextArea value={f.comments} onChange={set("comments")} /></Field>
        <Field label="Risk notes" span2><TextArea value={f.risk_notes} onChange={set("risk_notes")} /></Field>
      </div>

      <PlanSummary buy={f.buy_price} qty={f.qty} target={f.target_price} />

      {!isClosed && (
        <AllocationGauge
          symbol={symbolKey}
          cap={effectiveCap((f.cap_bucket || null) as CapBucket | null,
                            ctx.snaps.get(symbolKey))}
          buyPrice={toNum(f.buy_price)} qty={intOrNull(f.qty)} ctx={ctx}
          excludeHeld={ownHeld}
          onUseMaxQty={(q) => setF((p) => ({ ...p, qty: String(q) }))}
        />
      )}

      <div className="mt-5 flex items-center justify-end gap-3">
        {problem && f.symbol.trim() !== "" && (
          <span className="text-[11px] text-rose-600 mr-auto">{problem}</span>
        )}
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={busy || problem !== null} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Convert opportunity → open trade ----------------------------------------------

export function ConvertModal({ opp, ctx, onConvert, onClose, busy }: {
  opp: Opportunity;
  /** Capital + open lots, for the live allocation gauge. */
  ctx: JournalCtx;
  onConvert: (overrides: TradeDraft) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [f, setF] = useState({
    buy_date: today(),
    buy_price: opp.limit_price ?? opp.buy_price ?? "",
    qty: opp.qty?.toString() ?? "",
    order_type: opp.action_filter === "GTT" ? "GTT" : "Instant",
  });
  const set = (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));
  const setV = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const valid = f.buy_date && numOrNull(f.buy_price) && intOrNull(f.qty);
  return (
    <Modal title={`Take position — ${opp.symbol}`} onClose={onClose}>
      <p className="text-xs text-brand-mute mb-3">
        Creates an open trade from this opportunity and marks it converted.
        Strategy, target and cap carry over.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Buy date *"><TextInput type="date" value={f.buy_date} onChange={set("buy_date")} /></Field>
        <Field label="Order type">
          <Segmented ariaLabel="Order type"
                     options={[
                       { value: "GTT" as const, label: "GTT" },
                       { value: "Instant" as const, label: "Instant" },
                     ]}
                     value={f.order_type as "GTT" | "Instant"}
                     onChange={setV("order_type")} />
        </Field>
        <Field label="Buy price *">
          <NumInput prefix="₹" inputMode="decimal" placeholder="0.00"
                    value={f.buy_price} invalid={badNum(f.buy_price)}
                    onChange={set("buy_price")} />
        </Field>
        <Field label="Qty *">
          <NumInput inputMode="numeric" placeholder="0"
                    value={f.qty} invalid={badInt(f.qty)} onChange={set("qty")} />
        </Field>
      </div>
      <PlanSummary buy={f.buy_price} qty={f.qty} target={opp.target_price ?? ""} />
      <AllocationGauge
        symbol={opp.symbol}
        cap={effectiveCap(opp.cap_bucket, ctx.snaps.get(opp.symbol))}
        buyPrice={toNum(f.buy_price)} qty={intOrNull(f.qty)} ctx={ctx}
        onUseMaxQty={(q) => setF((p) => ({ ...p, qty: String(q) }))}
      />
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={busy || !valid} onClick={() => onConvert({
          buy_date: f.buy_date,
          buy_price: numOrNull(f.buy_price)!,
          qty: intOrNull(f.qty)!,
          order_type: f.order_type as TradeDraft["order_type"],
        })}>
          {busy ? "Converting…" : "Open trade"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Close (sell) an open trade ------------------------------------------------------

export function CloseTradeModal({ trade, onCloseTrade, onClose, busy }: {
  trade: Trade;
  onCloseTrade: (p: { sell_date: string; sell_price: string; qty: number }) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [f, setF] = useState({
    sell_date: today(),
    sell_price: trade.target_price ?? "",
    qty: trade.qty.toString(),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  const qty = intOrNull(f.qty);
  const valid = f.sell_date && numOrNull(f.sell_price) && qty && qty <= trade.qty;
  const partial = qty !== null && qty < trade.qty;
  return (
    <Modal title={`Book ${trade.symbol}`} onClose={onClose}>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Sell date *"><TextInput type="date" value={f.sell_date} onChange={set("sell_date")} /></Field>
        <Field label="Sell price *">
          <NumInput prefix="₹" inputMode="decimal" placeholder="0.00"
                    value={f.sell_price} invalid={badNum(f.sell_price)}
                    onChange={set("sell_price")} />
        </Field>
        <Field label={`Qty (open: ${trade.qty})`}>
          <NumInput inputMode="numeric" value={f.qty}
                    invalid={badInt(f.qty) || (qty !== null && qty > trade.qty)}
                    onChange={set("qty")} />
        </Field>
      </div>
      {partial && (
        <p className="mt-3 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 ring-1 ring-amber-200">
          Partial booking — {qty} sold as a closed trade, {trade.qty - qty!} stays open.
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={busy || !valid} onClick={() => onCloseTrade({
          sell_date: f.sell_date, sell_price: numOrNull(f.sell_price)!, qty: qty!,
        })}>
          {busy ? "Booking…" : partial ? "Book partial" : "Book fully"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}
