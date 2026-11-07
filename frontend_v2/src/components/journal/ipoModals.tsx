// -----------------------------------------------------------------------------
// IPO journal forms: application add/edit (with listing-day fetch) and the
// sell form. Values stay strings while typing; a bad value turns the field
// red and blocks Save, so nothing malformed reaches the API.
// -----------------------------------------------------------------------------
import { useState } from "react";
import {
  journalApi, type Ipo, type IpoDraft, type IpoSell, type IpoSellDraft, type IpoStatus,
} from "../../lib/journalApi";
import { localToday, type IpoDerived } from "../../lib/ipo";
import { fmtDate, fmtMoney } from "../../lib/money";
import {
  Field, GhostBtn, Modal, NumInput, Pnl, PrimaryBtn, Segmented, TextArea, TextInput,
} from "./ui";

// ---- Strict numeric parsing --------------------------------------------------------

/** "1,234.5" → "1234.5"; "" → null; not a positive number → null. */
function price(s: string): string | null {
  const t = s.trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? t : null;
}
/** Whole numbers only — "1.5" is invalid, never silently rounded. */
function whole(s: string): number | null {
  const t = s.trim().replace(/,/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}
const badPrice = (s: string) => s.trim() !== "" && price(s) === null;
const badWhole = (s: string) => s.trim() !== "" && whole(s) === null;
const SYMBOL_RE = /^[A-Z0-9&-]{1,20}$/;
const cleanSymbol = (s: string) => s.trim().toUpperCase().replace(/\.(NS|BO)$/, "");

function Section({ title, hint, children }: {
  title: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <section className="pt-4 first:pt-0">
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-brand-text">{title}</h3>
        {hint && <span className="text-[11px] text-brand-mute">{hint}</span>}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

function Notice({ tone, children }: { tone: "info" | "warn" | "error"; children: React.ReactNode }) {
  const cls = tone === "error" ? "bg-rose-50 text-rose-800 ring-rose-200"
    : tone === "warn" ? "bg-amber-50 text-amber-800 ring-amber-200"
    : "bg-teal-50 text-teal-900 ring-teal-200";
  return <p className={`sm:col-span-2 text-xs rounded-lg px-3 py-2 ring-1 ${cls}`}>{children}</p>;
}

// ---- Application add / edit ----------------------------------------------------------

const STATUS_OPTIONS: { value: IpoStatus; label: string; activeCls?: string }[] = [
  { value: "APPLIED", label: "⏳ Awaiting allotment",
    activeCls: "bg-amber-100 text-amber-900 ring-amber-400" },
  { value: "ALLOTTED", label: "✅ Allotted" },
  { value: "NOT_ALLOTTED", label: "✕ Not allotted",
    activeCls: "bg-stone-200 text-stone-700 ring-stone-300" },
];

export function IpoModal({ initial, accounts, busy, onSave, onClose }: {
  initial: Ipo | null;
  accounts: string[];
  busy: boolean;
  onSave: (draft: IpoDraft) => void;
  onClose: () => void;
}) {
  const s = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  const [f, setF] = useState({
    account: initial?.account ?? accounts[0] ?? "Self",
    ipo_name: s(initial?.ipo_name),
    symbol: s(initial?.symbol),
    apply_date: initial?.apply_date ?? localToday(),
    issue_price: s(initial?.issue_price),
    lot_size: s(initial?.lot_size),
    lots_applied: s(initial?.lots_applied ?? 1),
    status: (initial?.status ?? "APPLIED") as IpoStatus,
    allotment_date: s(initial?.allotment_date),
    shares_allotted: s(initial?.shares_allotted),
    listing_date: s(initial?.listing_date),
    listing_open: s(initial?.listing_open),
    listing_close: s(initial?.listing_close),
    notes: s(initial?.notes),
  });
  const set = (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));

  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<{ tone: "info" | "warn" | "error"; text: string } | null>(null);

  const issue = price(f.issue_price);
  const lotSize = whole(f.lot_size);
  const lots = whole(f.lots_applied);
  const maxShares = lotSize && lots ? lotSize * lots : null;
  const blocked = issue && maxShares ? Number(issue) * maxShares : null;
  const shares = whole(f.shares_allotted);
  const sym = cleanSymbol(f.symbol);
  const symBad = sym !== "" && !SYMBOL_RE.test(sym);
  const sold = initial?.sells.reduce((n, x) => n + x.qty, 0) ?? 0;

  // Rules the API enforces, mirrored so Save is blocked with a reason.
  const problems: string[] = [];
  if (f.status === "ALLOTTED") {
    if (!shares) problems.push("Enter the shares allotted.");
    else if (maxShares && shares > maxShares) problems.push(`Shares allotted can't exceed the ${maxShares} applied for.`);
    else if (shares < sold) problems.push(`${sold} shares are already sold — shares allotted can't be lower.`);
  } else if (sold) {
    problems.push("This IPO has sells recorded — delete them before changing it away from Allotted.");
  }
  for (const [label, d] of [["Allotment date", f.allotment_date], ["Listing date", f.listing_date]] as const) {
    if (d && f.apply_date && d < f.apply_date) problems.push(`${label} is before the application date.`);
  }

  const valid = f.account.trim() && f.ipo_name.trim() && f.apply_date && issue && lotSize && lots
    && !symBad && !badPrice(f.listing_open) && !badPrice(f.listing_close)
    && !badWhole(f.shares_allotted) && problems.length === 0;

  const fetchListing = async () => {
    if (!sym || symBad) return;
    setFetching(true);
    setFetchMsg(null);
    try {
      const l = await journalApi.ipoListing(sym, f.apply_date || undefined);
      setF((p) => ({
        ...p, symbol: l.symbol, listing_date: l.listing_date,
        listing_open: l.listing_open, listing_close: l.listing_close ?? "",
      }));
      setFetchMsg(l.listing_close
        ? { tone: "info", text: `Listed ${fmtDate(l.listing_date)} — open ₹${fmtMoney(l.listing_open)}, close ₹${fmtMoney(l.listing_close)}. Check against your broker before saving.` }
        : { tone: "warn", text: `Listed today — open ₹${fmtMoney(l.listing_open)}. Fetch again after market close for the closing price.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^GET \S+: /, "") : String(e);
      setFetchMsg({ tone: "error", text: msg });
    } finally {
      setFetching(false);
    }
  };

  const save = () => {
    const allotted = f.status === "ALLOTTED";
    onSave({
      account: f.account.trim(),
      ipo_name: f.ipo_name.trim(),
      symbol: sym || null,
      apply_date: f.apply_date,
      issue_price: issue!,
      lot_size: lotSize!,
      lots_applied: lots!,
      status: f.status,
      allotment_date: f.status === "APPLIED" ? null : f.allotment_date || null,
      shares_allotted: allotted ? shares : null,
      listing_date: f.listing_date || null,
      listing_open: price(f.listing_open),
      listing_close: price(f.listing_close),
      notes: f.notes.trim() || null,
    });
  };

  return (
    <Modal title={initial ? `Edit ${initial.ipo_name}` : "New IPO application"} onClose={onClose} wide>
      <div className="divide-y divide-brand-border/60 [&>section]:pb-4">
        <Section title="Application" hint="from your broker app">
          <Field label="Account *" span2>
            <Segmented ariaLabel="Account" value={f.account}
                       onChange={(v) => setF((p) => ({ ...p, account: v }))}
                       options={accounts.map((a) => ({ value: a, label: a }))} />
          </Field>
          <Field label="IPO name *">
            <TextInput value={f.ipo_name} onChange={set("ipo_name")} maxLength={80}
                       placeholder="e.g. Acme Technologies" autoFocus={!initial} />
          </Field>
          <Field label="Applied on *">
            <TextInput type="date" value={f.apply_date} onChange={set("apply_date")} />
          </Field>
          <Field label="Issue price * (upper band)">
            <NumInput prefix="₹" inputMode="decimal" placeholder="0.00" value={f.issue_price}
                      invalid={badPrice(f.issue_price)} onChange={set("issue_price")} />
          </Field>
          <Field label="Lot size * (shares per lot)">
            <NumInput inputMode="numeric" placeholder="e.g. 150" value={f.lot_size}
                      invalid={badWhole(f.lot_size)} onChange={set("lot_size")} />
          </Field>
          <Field label="Lots applied *">
            <NumInput inputMode="numeric" value={f.lots_applied}
                      invalid={badWhole(f.lots_applied)} onChange={set("lots_applied")} />
          </Field>
          <div className="self-end pb-1.5 text-sm text-brand-mute">
            Money blocked:{" "}
            <b className="text-brand-text tabular-nums">{blocked ? `₹${fmtMoney(blocked, 0)}` : "—"}</b>
            {maxShares ? <span className="text-xs"> ({maxShares} shares)</span> : null}
          </div>
        </Section>

        <Section title="Allotment">
          <Field label="Status" span2>
            <Segmented ariaLabel="Allotment status" value={f.status} options={STATUS_OPTIONS}
                       onChange={(v) => setF((p) => ({
                         ...p, status: v,
                         // Retail usually gets one lot — a sensible starting value.
                         shares_allotted: v === "ALLOTTED" && !p.shares_allotted && lotSize
                           ? String(lotSize) : p.shares_allotted,
                       }))} />
          </Field>
          {f.status !== "APPLIED" && (
            <Field label={f.status === "ALLOTTED" ? "Allotment date" : "Refund date (money unblocked)"}>
              <TextInput type="date" value={f.allotment_date} onChange={set("allotment_date")} />
            </Field>
          )}
          {f.status === "ALLOTTED" && (
            <Field label={`Shares allotted *${maxShares ? ` (max ${maxShares})` : ""}`}>
              <NumInput inputMode="numeric" value={f.shares_allotted}
                        invalid={badWhole(f.shares_allotted) || (!!shares && !!maxShares && shares > maxShares)}
                        onChange={set("shares_allotted")} />
            </Field>
          )}
        </Section>

        <Section title="Listing" hint="type the NSE symbol, then fetch">
          <Field label="NSE symbol">
            <div className="flex gap-1.5">
              <TextInput value={f.symbol} placeholder="e.g. ACMETECH" maxLength={23}
                         onChange={(e) => setF((p) => ({ ...p, symbol: e.target.value.toUpperCase() }))}
                         onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void fetchListing(); } }} />
              <GhostBtn type="button" onClick={() => void fetchListing()}
                        disabled={!sym || symBad || fetching} className="shrink-0 disabled:opacity-50">
                {fetching ? "Fetching…" : "↻ Fetch"}
              </GhostBtn>
            </div>
          </Field>
          <Field label="Listing date">
            <TextInput type="date" value={f.listing_date} onChange={set("listing_date")} />
          </Field>
          <Field label="Listing-day open">
            <NumInput prefix="₹" inputMode="decimal" value={f.listing_open}
                      invalid={badPrice(f.listing_open)} onChange={set("listing_open")} />
          </Field>
          <Field label="Listing-day close">
            <NumInput prefix="₹" inputMode="decimal" value={f.listing_close}
                      invalid={badPrice(f.listing_close)} onChange={set("listing_close")} />
          </Field>
          {symBad && <Notice tone="error">Symbol can only use A–Z, 0–9, & and -.</Notice>}
          {fetchMsg && <Notice tone={fetchMsg.tone}>{fetchMsg.text}</Notice>}
        </Section>

        <section className="pt-4">
          <Field label="Notes">
            <TextArea value={f.notes} onChange={set("notes")}
                      placeholder="GMP, subscription, why you applied…" />
          </Field>
        </section>
      </div>

      {problems.length > 0 && (
        <ul className="mt-3 text-xs text-rose-800 bg-rose-50 rounded-lg px-3 py-2 ring-1 ring-rose-200 list-disc list-inside">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={busy || !valid} onClick={save}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add IPO"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Sell add / edit ------------------------------------------------------------------

export function IpoSellModal({ ipo, d, sell, busy, onSave, onClose }: {
  ipo: Ipo;
  d: IpoDerived;
  /** Present when editing an existing sell. */
  sell: IpoSell | null;
  busy: boolean;
  onSave: (draft: IpoSellDraft) => void;
  onClose: () => void;
}) {
  // Shares available to this sell: what's held, plus its own qty when editing.
  const available = d.held + (sell?.qty ?? 0);
  const [f, setF] = useState({
    sell_date: sell?.sell_date ?? localToday(),
    sell_price: sell?.sell_price ?? (d.ltp !== null ? d.ltp.toFixed(2) : ""),
    qty: String(sell?.qty ?? available),
    notes: sell?.notes ?? "",
  });
  const set = (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setF((p) => ({ ...p, [k]: e.target.value }));

  const px = price(f.sell_price);
  const qty = whole(f.qty);
  const floor = ipo.listing_date ?? ipo.apply_date;
  const early = !!f.sell_date && f.sell_date < floor;
  const tooMany = qty !== null && qty > available;
  const valid = f.sell_date && px && qty && !tooMany && !early;
  const pnl = px && qty ? qty * (Number(px) - d.issue) : null;
  const pct = px && d.issue ? ((Number(px) - d.issue) / d.issue) * 100 : null;

  return (
    <Modal title={`${sell ? "Edit sell" : "Sell"} — ${ipo.ipo_name}`} onClose={onClose}>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Sell date *">
          <TextInput type="date" value={f.sell_date} min={floor} onChange={set("sell_date")} />
        </Field>
        <Field label="Sell price *">
          <NumInput prefix="₹" inputMode="decimal" placeholder="0.00" value={f.sell_price}
                    invalid={badPrice(f.sell_price)} onChange={set("sell_price")} />
        </Field>
        <Field label={`Qty * (available: ${available})`}>
          <NumInput inputMode="numeric" value={f.qty}
                    invalid={badWhole(f.qty) || tooMany} onChange={set("qty")} />
        </Field>
        <div className="self-end pb-1.5 text-sm">
          <span className="text-brand-mute">P&amp;L: </span>
          <Pnl value={pnl} digits={0} />{" "}
          <span className="text-xs">(<Pnl value={pct} suffix="%" />)</span>
        </div>
        <Field label="Notes" span2>
          <TextArea value={f.notes} onChange={set("notes")} placeholder="Why now? e.g. sold half at open" />
        </Field>
      </div>
      {early && (
        <p className="mt-3 text-xs text-rose-800 bg-rose-50 rounded-lg px-3 py-2 ring-1 ring-rose-200">
          Sell date is before {ipo.listing_date ? "listing" : "the application"} ({fmtDate(floor)}).
        </p>
      )}
      {qty !== null && !tooMany && qty < available && (
        <p className="mt-3 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 ring-1 ring-amber-200">
          Partial exit — {available - qty} shares stay held.
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={busy || !valid} onClick={() => onSave({
          sell_date: f.sell_date, sell_price: px!, qty: qty!, notes: f.notes.trim() || null,
        })}>
          {busy ? "Saving…" : sell ? "Save sell" : "Record sell"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}
