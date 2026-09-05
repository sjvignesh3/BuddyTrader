// -----------------------------------------------------------------------------
// Net Worth modals — asset, liability, quick value update, milestone, monthly
// income and financial-freedom settings. Form state lives as strings; drafts
// are cleaned on save (journal modal conventions).
// -----------------------------------------------------------------------------
import { useState } from "react";
import { monthLabel, todayIso } from "../../lib/expenses";
import { fmtMoney } from "../../lib/money";
import type {
  Asset, AssetClass, AssetDraft, IncomeRow, Liability, LiabilityDraft, LiabilityKind,
  Milestone, MilestoneDraft, NetWorthSettings, SettingsDraft,
} from "../../lib/networthApi";
import { ASSET_CLASSES, LIABILITY_KINDS } from "../../lib/networthApi";
import { Field, GhostBtn, Modal, NumInput, PrimaryBtn, Segmented, TextArea, TextInput } from "../journal/ui";
import { CLASS_ICON } from "./ui";

const badMoney = (s: string): boolean =>
  s.trim() !== "" && !(Number.isFinite(Number(s.replace(/,/g, ""))) && Number(s.replace(/,/g, "")) >= 0);
const clean = (s: string): string | null => {
  const t = s.trim().replace(/,/g, "");
  return t === "" ? null : t;
};

// ---- Asset -------------------------------------------------------------------------

export function AssetModal({ initial, busy, onClose, onSave }: {
  initial: Asset | null;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: AssetDraft) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [cls, setCls] = useState<AssetClass>(initial?.asset_class ?? "Cash");
  const [institution, setInstitution] = useState(initial?.institution ?? "");
  const [value, setValue] = useState(initial?.current_value ?? "");
  const [cost, setCost] = useState(initial?.cost_basis ?? "");
  const [asOf, setAsOf] = useState(initial?.as_of_date ?? todayIso());
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const valid = name.trim() !== "" && clean(value) !== null && !badMoney(value) && !badMoney(cost) && !!asOf;

  return (
    <Modal title={initial ? `Edit ${initial.name}` : "Add asset"} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" span2>
          <TextInput value={name} autoFocus placeholder="HDFC savings, Axis FD, PPF…"
                     onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Asset class" span2>
          <Segmented<AssetClass> ariaLabel="Asset class"
            options={ASSET_CLASSES.map((c) => ({ value: c, label: <>{CLASS_ICON[c]} {c}</> }))}
            value={cls} onChange={setCls} />
        </Field>
        <Field label="Current value (₹)">
          <NumInput prefix="₹" inputMode="decimal" value={value} invalid={badMoney(value)}
                    onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="As of">
          <TextInput type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
        <Field label="Cost basis (₹, optional)">
          <NumInput prefix="₹" inputMode="decimal" value={cost} invalid={badMoney(cost)}
                    placeholder="what you put in" onChange={(e) => setCost(e.target.value)} />
        </Field>
        <Field label="Institution">
          <TextInput value={institution} placeholder="Optional"
                     onChange={(e) => setInstitution(e.target.value)} />
        </Field>
        <Field label="Notes" span2>
          <TextArea value={notes} placeholder="Maturity date, nominee, folio…"
                    onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={!valid || busy}
                    onClick={() => onSave({
                      name: name.trim(), asset_class: cls, institution: institution.trim() || null,
                      current_value: clean(value)!, cost_basis: clean(cost), as_of_date: asOf,
                      notes: notes.trim() || null,
                    })}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add asset"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

/** Quick "update value" — the most frequent asset edit, kept to two fields. */
export function UpdateValueModal({ asset, busy, onClose, onSave }: {
  asset: Asset; busy: boolean; onClose: () => void;
  onSave: (draft: AssetDraft) => void;
}) {
  const [value, setValue] = useState(asset.current_value);
  const [asOf, setAsOf] = useState(todayIso());
  const valid = clean(value) !== null && !badMoney(value) && !!asOf;
  const delta = Number(clean(value) ?? 0) - Number(asset.current_value);
  return (
    <Modal title={`Update ${asset.name}`} onClose={onClose}>
      <p className="text-xs text-brand-mute mb-3">
        Was ₹{fmtMoney(asset.current_value, 0)} as of {asset.as_of_date}.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="New value (₹)">
          <NumInput prefix="₹" inputMode="decimal" value={value} autoFocus invalid={badMoney(value)}
                    onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="As of">
          <TextInput type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
      </div>
      {valid && delta !== 0 && (
        <p className={`mt-3 text-[12px] ${delta > 0 ? "text-teal-700" : "text-rose-700"}`}>
          {delta > 0 ? "▲" : "▼"} ₹{fmtMoney(Math.abs(delta), 0)} vs the last entry
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={!valid || busy}
                    onClick={() => onSave({ current_value: clean(value)!, as_of_date: asOf })}>
          {busy ? "Saving…" : "Update"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Liability ------------------------------------------------------------------------

export function LiabilityModal({ initial, busy, onClose, onSave }: {
  initial: Liability | null;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: LiabilityDraft) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<LiabilityKind>(initial?.kind ?? "Personal Loan");
  const [outstanding, setOutstanding] = useState(initial?.outstanding ?? "");
  const [rate, setRate] = useState(initial?.interest_rate ?? "");
  const [emi, setEmi] = useState(initial?.emi ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const valid = name.trim() !== "" && clean(outstanding) !== null && !badMoney(outstanding)
    && !badMoney(rate) && !badMoney(emi);

  return (
    <Modal title={initial ? `Edit ${initial.name}` : "Add liability"} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" span2>
          <TextInput value={name} autoFocus placeholder="Car loan, HDFC credit card…"
                     onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Type" span2>
          <Segmented<LiabilityKind> ariaLabel="Liability type"
            options={LIABILITY_KINDS.map((k) => ({ value: k, label: k }))}
            value={kind} onChange={setKind} />
        </Field>
        <Field label="Outstanding (₹)">
          <NumInput prefix="₹" inputMode="decimal" value={outstanding} invalid={badMoney(outstanding)}
                    onChange={(e) => setOutstanding(e.target.value)} />
        </Field>
        <Field label="Interest rate % p.a.">
          <NumInput suffix="%" inputMode="decimal" value={rate} invalid={badMoney(rate)}
                    placeholder="optional" onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Field label="EMI / month (₹)">
          <NumInput prefix="₹" inputMode="decimal" value={emi} invalid={badMoney(emi)}
                    placeholder="optional" onChange={(e) => setEmi(e.target.value)} />
        </Field>
        <Field label="Notes" span2>
          <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={!valid || busy}
                    onClick={() => onSave({
                      name: name.trim(), kind, outstanding: clean(outstanding)!,
                      interest_rate: clean(rate), emi: clean(emi), notes: notes.trim() || null,
                    })}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add liability"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Milestone ---------------------------------------------------------------------------

const MILESTONE_PRESETS: { label: string; target: string }[] = [
  { label: "₹10L", target: "1000000" }, { label: "₹25L", target: "2500000" },
  { label: "₹50L", target: "5000000" }, { label: "₹1Cr", target: "10000000" },
  { label: "₹2Cr", target: "20000000" }, { label: "₹5Cr", target: "50000000" },
];

export function MilestoneModal({ initial, busy, onClose, onSave }: {
  initial: Milestone | null; busy: boolean; onClose: () => void;
  onSave: (draft: MilestoneDraft) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [target, setTarget] = useState(initial?.target ?? "");
  const valid = clean(target) !== null && Number(clean(target)) > 0;
  return (
    <Modal title={initial ? "Edit milestone" : "Add a net-worth milestone"} onClose={onClose}>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {MILESTONE_PRESETS.map((p) => (
          <button key={p.target} type="button"
                  onClick={() => { setTarget(p.target); if (!label.trim() || MILESTONE_PRESETS.some((x) => x.label === label)) setLabel(p.label); }}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ring-1 ${
                    target === p.target ? "bg-teal-700 text-white ring-teal-700"
                      : "bg-brand-soft text-brand-mute ring-brand-border hover:text-brand-text"}`}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Target (₹)">
          <NumInput prefix="₹" inputMode="numeric" value={target} invalid={badMoney(target)}
                    onChange={(e) => setTarget(e.target.value)} />
        </Field>
        <Field label="Label">
          <TextInput value={label} placeholder="e.g. House down payment"
                     onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={!valid || busy}
                    onClick={() => onSave({ label: label.trim() || undefined, target: clean(target)! })}>
          {busy ? "Saving…" : initial ? "Save" : "Add milestone"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Monthly income -----------------------------------------------------------------------

export function IncomeModal({ monthKey, existing, busy, onClose, onSave }: {
  monthKey: string;                 // "YYYY-MM"
  existing: IncomeRow | null;
  busy: boolean;
  onClose: () => void;
  onSave: (month: string, amount: string, notes: string | null) => void;
}) {
  const [month, setMonth] = useState(monthKey);
  const [amount, setAmount] = useState(existing?.amount ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const valid = /^\d{4}-\d{2}$/.test(month) && clean(amount) !== null && !badMoney(amount);
  return (
    <Modal title={`Income — ${monthLabel(month)}`} onClose={onClose}>
      <p className="text-xs text-brand-mute mb-3">
        Take-home for the month. Savings rate = (income − expenses) ÷ income, with expenses
        from the Expense Tracker.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Month">
          <TextInput type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
        <Field label="Take-home income (₹)">
          <NumInput prefix="₹" inputMode="numeric" value={amount} autoFocus invalid={badMoney(amount)}
                    onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Notes" span2>
          <TextInput value={notes} placeholder="Bonus, arrears… (optional)"
                     onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={!valid || busy}
                    onClick={() => onSave(month, clean(amount)!, notes.trim() || null)}>
          {busy ? "Saving…" : "Save income"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

// ---- Financial-freedom settings ---------------------------------------------------------------

export function FreedomSettingsModal({ settings, defaultSavings, busy, onClose, onSave }: {
  settings: NetWorthSettings;
  /** Derived monthly savings (income − expenses) shown as the default. */
  defaultSavings: number | null;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: SettingsDraft) => void;
}) {
  const [target, setTarget] = useState(settings.ff_target_corpus ?? "");
  const [ret, setRet] = useState(settings.ff_real_return_pct ?? "6");
  const [savings, setSavings] = useState(settings.ff_monthly_savings ?? "");
  const valid = !badMoney(target) && !badMoney(ret) && clean(ret) !== null && !badMoney(savings);
  return (
    <Modal title="Financial freedom inputs" onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Target corpus (₹)" span2>
          <NumInput prefix="₹" inputMode="numeric" value={target} invalid={badMoney(target)}
                    placeholder="e.g. 3,00,00,000" onChange={(e) => setTarget(e.target.value)} />
        </Field>
        <Field label="Expected real return % p.a.">
          <NumInput suffix="%" inputMode="decimal" value={ret} invalid={badMoney(ret)}
                    onChange={(e) => setRet(e.target.value)} />
        </Field>
        <Field label="Monthly savings (₹)">
          <NumInput prefix="₹" inputMode="numeric" value={savings} invalid={badMoney(savings)}
                    placeholder={defaultSavings !== null ? `${Math.round(defaultSavings)} (derived)` : "derived when data exists"}
                    onChange={(e) => setSavings(e.target.value)} />
        </Field>
      </div>
      <p className="mt-3 text-[11px] text-brand-mute">
        Real return = after inflation. Leave savings blank to use your 3-month average of
        income − expenses.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={!valid || busy}
                    onClick={() => onSave({
                      ff_target_corpus: clean(target), ff_real_return_pct: clean(ret)!,
                      ff_monthly_savings: clean(savings),
                    })}>
          {busy ? "Saving…" : "Save"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}
