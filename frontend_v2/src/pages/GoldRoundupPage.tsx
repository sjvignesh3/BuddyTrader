// -----------------------------------------------------------------------------
// Gold Round-Up — the one public tool. Type the day's gold rate and it finds
// the payment that the plan rounds up to the most gold per rupee, splits a
// day's budget into those payments, and lets you test any amount.
//
// Public on purpose (see App.tsx): it is pure arithmetic in lib/goldRoundup.ts,
// reads no API and no personal data, so it sits outside the password gate and
// can be shared by link. Only the last rate typed is kept, in this browser.
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import {
  evaluatePayment, planPayments, splitBudget, topOptions, type PaymentResult,
} from "../lib/goldRoundup";
import { Field, NumInput } from "../components/journal/ui";

const RATE_KEY = "plutus.goldRoundup.rate";
const EXAMPLE_RATE = "13150";   // last rate in the GRT passbook, 6 Nov 2026

const toPaise = (s: string) => {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const inr = (rupees: number, digits = 0) =>
  "₹" + rupees.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const rs = (paise: number) => (paise % 100 === 0 ? inr(paise / 100) : inr(paise / 100, 2));
const grams = (mgOrG: number, isMg = true) => `${(isMg ? mgOrG / 1000 : mgOrG).toFixed(3)} g`;
const signedPct = (f: number, d = 1) => `${f >= 0 ? "+" : ""}${(f * 100).toFixed(d)}%`;

function readSavedRate(): string {
  try { return localStorage.getItem(RATE_KEY) || EXAMPLE_RATE; } catch { return EXAMPLE_RATE; }
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`p-4 sm:p-5 rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card ${className}`}>
      {children}
    </section>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="font-display font-semibold text-lg mb-3">{children}</h2>;
}

function Check({ checked, onChange, children }: {
  checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-xs text-brand-mute cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
             className="w-4 h-4 accent-teal-700" />
      {children}
    </label>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-900/70">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-amber-950">{value}</div>
    </div>
  );
}

function Bar({ label, g, max, highlight = false }: { label: string; g: number; max: number; highlight?: boolean }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr_auto] sm:grid-cols-[9rem_1fr_auto] items-center gap-3 text-sm">
      <span className={highlight ? "font-semibold" : "text-brand-mute"}>{label}</span>
      <div className="h-2.5 rounded-full bg-brand-soft ring-1 ring-brand-border overflow-hidden">
        <div className={`h-full rounded-full ${highlight ? "bg-brand-gold" : "bg-brand-mute/50"}`}
             style={{ width: `${max > 0 ? (g / max) * 100 : 0}%` }} />
      </div>
      <span className="tabular-nums text-right min-w-[5.5rem]">{g.toFixed(3)} g</span>
    </div>
  );
}

export default function GoldRoundupPage() {
  const [rate, setRate] = useState(readSavedRate);
  const [benefit, setBenefit] = useState("7");
  const [minPay, setMinPay] = useState("100");
  const [buffer, setBuffer] = useState("0");
  const [whole, setWhole] = useState(true);
  const [skipEdge, setSkipEdge] = useState(true);
  const [budget, setBudget] = useState("5000");
  const [testAmt, setTestAmt] = useState("109");
  const [testRate, setTestRate] = useState("");
  const [copied, setCopied] = useState(false);

  const ratePaise = toPaise(rate);
  const rateOk = ratePaise !== null && ratePaise >= 100_000;   // ₹1,000/g floor guards typos
  const benefitBp = Math.round((Number(benefit) || 0) * 100);
  const opts = useMemo(() => ({
    benefitBp,
    minPaise: toPaise(minPay) ?? 100,
    bufferPaise: toPaise(buffer) ?? 0,
    wholeRupees: whole,
    skipEdge,
  }), [benefitBp, minPay, buffer, whole, skipEdge]);

  const plan = useMemo(() => (rateOk ? planPayments(ratePaise!, opts) : null), [rateOk, ratePaise, opts]);
  const best = plan?.best ?? null;

  useEffect(() => {
    if (!rateOk) return;
    try { localStorage.setItem(RATE_KEY, rate); } catch { /* private mode: fine */ }
  }, [rate, rateOk]);

  async function copyAmount() {
    if (!best) return;
    const v = (best.amountPaise / 100).toFixed(best.amountPaise % 100 ? 2 : 0);
    try { await navigator.clipboard.writeText(v); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard refused: the amount is on screen to copy by hand */ }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="mt-2">
        <div className="text-[11px] font-bold uppercase tracking-widest text-brand-gold">
          Gold savings plan · 3-decimal rounding
        </div>
        <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">Gold Round-Up</h1>
        <p className="mt-1.5 text-sm text-brand-mute max-w-xl">
          Type today's gold rate. It finds the payment the plan rounds up to the most gold
          per rupee, and shows what you gain over a normal purchase.
        </p>
      </div>

      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="col-span-2">
            <Field label="Today's gold rate (₹ per gram)">
              <NumInput prefix="₹" inputMode="decimal" value={rate} invalid={!rateOk}
                        onChange={(e) => setRate(e.target.value)} />
            </Field>
          </div>
          <Field label="Benefit">
            <NumInput suffix="%" inputMode="decimal" value={benefit} onChange={(e) => setBenefit(e.target.value)} />
          </Field>
          <Field label="Minimum payment">
            <NumInput prefix="₹" inputMode="decimal" value={minPay} onChange={(e) => setMinPay(e.target.value)} />
          </Field>
          <Field label="Safety buffer">
            <NumInput prefix="₹" inputMode="decimal" value={buffer} onChange={(e) => setBuffer(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          <Check checked={whole} onChange={setWhole}>Whole rupees only</Check>
          <Check checked={skipEdge} onChange={setSkipEdge}>Skip amounts sitting exactly on a rounding edge</Check>
        </div>
        {rate === EXAMPLE_RATE && (
          <p className="mt-3 text-xs text-brand-mute">
            ₹13,150 is an example rate (6 Nov 2026). Replace it with today's.
          </p>
        )}
      </Card>

      {!rateOk || !best ? (
        <Card><p className="text-sm text-brand-danger font-semibold">Enter the gold rate per gram, for example 13150.</p></Card>
      ) : (
        <>
          <PayCard best={best} ratePaise={ratePaise!} stepPaise={whole ? 100 : 1}
                   benefitBp={benefitBp} copied={copied} onCopy={copyAmount} />
          <BudgetCard best={best} ratePaise={ratePaise!} benefitBp={benefitBp}
                      budget={budget} setBudget={setBudget} />
          <Card>
            <CardTitle>Other amounts at this rate</CardTitle>
            <p className="-mt-2 mb-3 text-xs text-brand-mute">
              The cheapest payment for each credited weight. Paying ₹1 less than a row drops you to the row above.
            </p>
            <div className="overflow-x-auto -mx-1">
              <table className="min-w-full text-[13px] tabular-nums">
                <thead>
                  <tr className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
                    {["Pay", "Weight", "Benefit", "Cost / g", "Vs. rate", "Extra vs. honest", "Works under"].map((h, i) => (
                      <th key={h} className={`px-2 py-2 whitespace-nowrap ${i ? "text-right" : "text-left"}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {topOptions(plan!, 7).map((r) => {
                    const isBest = r === best;
                    return (
                      <tr key={r.amountPaise}
                          className={`border-t border-brand-border ${isBest ? "bg-amber-50 font-semibold" : ""}`}>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {rs(r.amountPaise)}
                          {isBest && <span className="ml-1.5 text-[9px] uppercase tracking-widest text-brand-gold">best</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right">{grams(r.weightMg)}</td>
                        <td className="px-2 py-1.5 text-right">{grams(r.benefitMg)}</td>
                        <td className="px-2 py-1.5 text-right">{inr(r.costPerG)}</td>
                        <td className="px-2 py-1.5 text-right">{(-r.discount * 100).toFixed(1)}%</td>
                        <td className="px-2 py-1.5 text-right text-emerald-700">{signedPct(r.edge)}</td>
                        <td className="px-2 py-1.5 text-right">{r.holdsUntilPaise ? inr(r.holdsUntilPaise / 100) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <TestCard amt={testAmt} setAmt={setTestAmt} rate={testRate} setRate={setTestRate}
                fallbackRatePaise={rateOk ? ratePaise! : null} benefitBp={benefitBp} />

      <div className="text-xs text-brand-mute space-y-1.5 max-w-2xl pb-2">
        <p>
          <span className="font-semibold text-brand-text">Rule used:</span> weight = payment ÷ rate,
          rounded to the nearest 0.001 g (0.0005 rounds up). Benefit = benefit % of that credited
          weight, rounded the same way. This matches all 56 rows of a GRT Insta Gold passbook,
          31 Oct to 6 Nov 2026.
        </p>
        <p>
          "Extra vs. honest" compares with an exact, unrounded scheme: payment ÷ rate × (1 + benefit).
          If the plan ever recalculates from rupees paid, this extra is what goes away; the gold
          and benefit for the money paid stay.
        </p>
      </div>
    </div>
  );
}

function PayCard({ best, ratePaise, stepPaise, benefitBp, copied, onCopy }: {
  best: PaymentResult; ratePaise: number; stepPaise: number; benefitBp: number;
  copied: boolean; onCopy: () => void;
}) {
  const below = evaluatePayment(best.amountPaise - stepPaise, ratePaise, benefitBp);
  const margin = best.holdsUntilPaise ? best.holdsUntilPaise / ratePaise - 1 : 0;
  const tight = margin < 0.003;
  return (
    <section aria-live="polite"
             className="p-5 sm:p-6 rounded-2xl bg-gradient-to-br from-amber-100 to-amber-50
                        ring-1 ring-amber-300/70 shadow-card space-y-4">
      <div>
        <div className="text-[11px] font-bold uppercase tracking-widest text-amber-900/70">Pay per transaction</div>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div className="font-display text-6xl sm:text-7xl font-bold tracking-tight text-amber-950 tabular-nums">
            {rs(best.amountPaise)}
          </div>
          <button type="button" onClick={onCopy}
                  className="px-4 py-2 rounded-xl bg-amber-950 text-amber-50 text-sm font-semibold
                             shadow-card hover:bg-amber-900 transition-colors">
            {copied ? "Copied" : "Copy amount"}
          </button>
        </div>
        <div className="mt-2 text-base font-semibold tabular-nums text-amber-950">
          {grams(best.weightMg)} + {grams(best.benefitMg)} benefit = {grams(best.totalG, false)} credited
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
        <Fact label="Your cost per gram" value={inr(best.costPerG)} />
        <Fact label="Cheaper than rate" value={`${(best.discount * 100).toFixed(1)}%`} />
        <Fact label="Extra vs. honest" value={signedPct(best.edge)} />
        <Fact label="Works while rate under" value={best.holdsUntilPaise ? inr(best.holdsUntilPaise / 100, 2) : "—"} />
      </div>
      <p className="text-xs text-amber-950">
        {below.weightMg < best.weightMg && <>Paying {rs(best.amountPaise - stepPaise)} instead credits only {grams(below.weightMg)}. </>}
        {tight
          ? <><span className="font-bold underline">Tight:</span> a rate rise of {(margin * 100).toFixed(2)}% flips this. Consider a ₹1 buffer.</>
          : <>The rate can rise {(margin * 100).toFixed(2)}% before this amount drops a step.</>}
      </p>
    </section>
  );
}

function BudgetCard({ best, ratePaise, benefitBp, budget, setBudget }: {
  best: PaymentResult; ratePaise: number; benefitBp: number;
  budget: string; setBudget: (v: string) => void;
}) {
  const budgetPaise = toPaise(budget) ?? 0;
  const s = splitBudget(best, budgetPaise, ratePaise, benefitBp);
  const extra = s.creditedG - s.fairG;
  return (
    <Card>
      <CardTitle>Today's investment</CardTitle>
      <div className="grid sm:grid-cols-2 gap-3 items-end">
        <Field label="Amount you plan to put in today">
          <NumInput prefix="₹" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
        <div className="text-sm tabular-nums pb-1.5">
          {s.payments > 0 ? (
            <>
              <span className="font-semibold">{s.payments} payments × {rs(best.amountPaise)}</span> = {rs(s.spentPaise)}
              {s.leftoverPaise > 0 && <span className="text-brand-mute"> · {rs(s.leftoverPaise)} left over</span>}
            </>
          ) : <span className="text-brand-mute">Budget is below one payment.</span>}
        </div>
      </div>
      {s.payments > 0 && (
        <>
          <div className="mt-4 space-y-2">
            <Bar label="Buy directly" g={s.directG} max={s.creditedG} />
            <Bar label="Honest benefit" g={s.fairG} max={s.creditedG} />
            <Bar label="Your payments" g={s.creditedG} max={s.creditedG} highlight />
          </div>
          <p className="mt-3 text-sm">
            You get <span className="font-semibold text-emerald-700">{signedPct(s.creditedG / s.directG - 1)}</span> more
            gold than buying {rs(s.spentPaise)} directly, and{" "}
            <span className="font-semibold text-emerald-700">
              {extra.toFixed(3)} g ({inr((extra * ratePaise) / 100)})
            </span>{" "}
            beyond what the benefit alone gives.
          </p>
        </>
      )}
    </Card>
  );
}

function TestCard({ amt, setAmt, rate, setRate, fallbackRatePaise, benefitBp }: {
  amt: string; setAmt: (v: string) => void; rate: string; setRate: (v: string) => void;
  fallbackRatePaise: number | null; benefitBp: number;
}) {
  const a = toPaise(amt);
  const r = toPaise(rate) ?? fallbackRatePaise;
  const res = a && r && r >= 100_000 ? evaluatePayment(a, r, benefitBp) : null;
  return (
    <Card>
      <CardTitle>Test a payment</CardTitle>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Payment">
          <NumInput prefix="₹" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
        </Field>
        <Field label="At rate (blank = today's)">
          <NumInput prefix="₹" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 text-sm tabular-nums">
        {res ? (
          <>
            <div>
              {rs(res.amountPaise)} at {rs(r!)}/g → exact {res.exactG.toFixed(5)} g → credited{" "}
              <span className="font-semibold">{grams(res.weightMg)} + {grams(res.benefitMg)} = {grams(res.totalG, false)}</span>
            </div>
            <div className="text-brand-mute">
              cost {inr(res.costPerG)}/g · extra vs. honest:{" "}
              <span className={res.edge >= 0 ? "text-emerald-700 font-semibold" : "text-brand-danger font-semibold"}>
                {signedPct(res.edge)}
              </span>
            </div>
            {res.onEdge && (
              <div className="text-brand-danger font-semibold">
                Sits exactly on a rounding edge. The plan may round this either way.
              </div>
            )}
          </>
        ) : <span className="text-brand-mute">Enter a payment and a rate.</span>}
      </div>
    </Card>
  );
}
