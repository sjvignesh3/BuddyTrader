// -----------------------------------------------------------------------------
// Journal form modals: opportunity add/edit, trade add/edit, convert, close.
// Forms keep values as strings and hand the API a cleaned draft on save.
// -----------------------------------------------------------------------------
import { useState } from "react";
import type {
  CapBucket, Opportunity, OpportunityDraft, Trade, TradeDraft,
} from "../../lib/journalApi";
import {
  Field, GhostBtn, Modal, PrimaryBtn, Select, StrategyDatalist, TextArea, TextInput,
} from "./ui";

const CAPS: (CapBucket | "")[] = ["", "Large", "Mid", "Small", "Micro"];
const today = () => new Date().toISOString().slice(0, 10);

function numOrNull(s: string): string | null {
  const t = s.trim().replace(/,/g, "");
  return t === "" ? null : t;
}
function intOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Math.round(Number(t));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---- Opportunity ---------------------------------------------------------------

export function OpportunityModal({ initial, onSave, onClose, busy }: {
  initial: Opportunity | null;
  onSave: (draft: OpportunityDraft) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [f, setF] = useState({
    opp_date: initial?.opp_date ?? today(),
    symbol: initial?.symbol ?? "",
    cap_bucket: initial?.cap_bucket ?? "",
    buy_price: initial?.buy_price ?? "",
    limit_price: initial?.limit_price ?? "",
    qty: initial?.qty?.toString() ?? "",
    strategy: initial?.strategy ?? "",
    target_price: initial?.target_price ?? "",
    action_filter: initial?.action_filter ?? "",
    notes: initial?.notes ?? "",
  });
  const set = (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));

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
        <Field label="Symbol">
          <TextInput value={f.symbol} onChange={set("symbol")} placeholder="RELIANCE"
                     autoFocus={!initial} />
        </Field>
        <Field label="Date"><TextInput type="date" value={f.opp_date} onChange={set("opp_date")} /></Field>
        <Field label="Cap bucket">
          <Select value={f.cap_bucket} onChange={set("cap_bucket")}>
            {CAPS.map((c) => <option key={c} value={c}>{c || "Auto (from data)"}</option>)}
          </Select>
        </Field>
        <Field label="Action filter">
          <Select value={f.action_filter} onChange={set("action_filter")}>
            {["", "Buy Now", "GTT", "Analyse Now", "Later"].map((a) => (
              <option key={a} value={a}>{a || "—"}</option>
            ))}
          </Select>
        </Field>
        <Field label="Buy price ₹"><TextInput inputMode="decimal" value={f.buy_price} onChange={set("buy_price")} /></Field>
        <Field label="Limit price ₹"><TextInput inputMode="decimal" value={f.limit_price} onChange={set("limit_price")} /></Field>
        <Field label="Qty"><TextInput inputMode="numeric" value={f.qty} onChange={set("qty")} /></Field>
        <Field label="Target ₹"><TextInput inputMode="decimal" value={f.target_price} onChange={set("target_price")} /></Field>
        <Field label="Strategy" span2>
          <TextInput list="jr-strategies" value={f.strategy} onChange={set("strategy")} />
          <StrategyDatalist id="jr-strategies" />
        </Field>
        <Field label="Analysis notes" span2>
          <TextArea value={f.notes} onChange={set("notes")} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={busy || !f.symbol.trim()} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Trade (add / edit; covers open and closed rows) ------------------------------

export function TradeModal({ initial, closed = false, onSave, onClose, busy }: {
  initial: Trade | null;
  /** true when editing a CLOSED row (shows sell fields). */
  closed?: boolean;
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
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));

  const valid = f.symbol.trim() && f.buy_date && numOrNull(f.buy_price) && intOrNull(f.qty)
    && (!isClosed || (f.sell_date && numOrNull(f.sell_price)));

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
        <Field label="Symbol">
          <TextInput value={f.symbol} onChange={set("symbol")} autoFocus={!initial} />
        </Field>
        <Field label="Order type">
          <Select value={f.order_type ?? "GTT"} onChange={set("order_type")}>
            <option value="GTT">GTT</option>
            <option value="Instant">Instant</option>
          </Select>
        </Field>
        <Field label="Cap bucket">
          <Select value={f.cap_bucket} onChange={set("cap_bucket")}>
            {CAPS.map((c) => <option key={c} value={c}>{c || "Auto (from data)"}</option>)}
          </Select>
        </Field>
        <Field label="Buy date"><TextInput type="date" value={f.buy_date} onChange={set("buy_date")} /></Field>
        <Field label="Buy price ₹"><TextInput inputMode="decimal" value={f.buy_price} onChange={set("buy_price")} /></Field>
        <Field label="Qty"><TextInput inputMode="numeric" value={f.qty} onChange={set("qty")} /></Field>
        <Field label="Strategy">
          <TextInput list="jr-strategies-t" value={f.strategy} onChange={set("strategy")} />
          <StrategyDatalist id="jr-strategies-t" />
        </Field>
        <Field label="Target ₹"><TextInput inputMode="decimal" value={f.target_price} onChange={set("target_price")} /></Field>
        {isClosed && (
          <>
            <Field label="Sell date"><TextInput type="date" value={f.sell_date} onChange={set("sell_date")} /></Field>
            <Field label="Sell price ₹"><TextInput inputMode="decimal" value={f.sell_price} onChange={set("sell_price")} /></Field>
            <Field label="Close label" span2>
              <TextInput list="jr-close-labels" value={f.close_label} onChange={set("close_label")} />
              <datalist id="jr-close-labels">
                {["Fully Booked", "Partially Booked", "Stop Loss", "Exit on thesis break"]
                  .map((s) => <option key={s} value={s} />)}
              </datalist>
            </Field>
          </>
        )}
        <Field label="Comments" span2><TextArea value={f.comments} onChange={set("comments")} /></Field>
        <Field label="Risk notes" span2><TextArea value={f.risk_notes} onChange={set("risk_notes")} /></Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={busy || !valid} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Convert opportunity → open trade ----------------------------------------------

export function ConvertModal({ opp, onConvert, onClose, busy }: {
  opp: Opportunity;
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
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));
  const valid = f.buy_date && numOrNull(f.buy_price) && intOrNull(f.qty);
  return (
    <Modal title={`Take position — ${opp.symbol}`} onClose={onClose}>
      <p className="text-xs text-brand-mute mb-3">
        Creates an open trade from this opportunity and marks it converted.
        Strategy, target and cap carry over.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Buy date"><TextInput type="date" value={f.buy_date} onChange={set("buy_date")} /></Field>
        <Field label="Order type">
          <Select value={f.order_type} onChange={set("order_type")}>
            <option value="GTT">GTT</option>
            <option value="Instant">Instant</option>
          </Select>
        </Field>
        <Field label="Buy price ₹"><TextInput inputMode="decimal" value={f.buy_price} onChange={set("buy_price")} /></Field>
        <Field label="Qty"><TextInput inputMode="numeric" value={f.qty} onChange={set("qty")} /></Field>
      </div>
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
        <Field label="Sell date"><TextInput type="date" value={f.sell_date} onChange={set("sell_date")} /></Field>
        <Field label="Sell price ₹"><TextInput inputMode="decimal" value={f.sell_price} onChange={set("sell_price")} /></Field>
        <Field label={`Qty (open: ${trade.qty})`}>
          <TextInput inputMode="numeric" value={f.qty} onChange={set("qty")} />
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
