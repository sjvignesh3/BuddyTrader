// -----------------------------------------------------------------------------
// Passbook report — drop in GRT passbook PDFs, see what the scheme and the
// rounding actually earned, per payment / day / week / month.
//
// Every figure is worked out per payment (lib/goldPassbookReport.ts) and only
// then summed, and each panel prints the formula it uses.
//
// Files are read in this browser (lib/pdfText.ts) and never uploaded or
// stored; that is what lets this stay on the public Gold Round-Up page.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { readPdfText } from "../../lib/pdfText";
import {
  checkTotals, mergeTxns, parseGrtPassbook, type ParsedPassbook, type TotalsCheck,
} from "../../lib/grtPassbook";
import {
  analyseTxns, fmtDay, groupInsights, pctOfPaid, redemption, totalInsights, valueToday,
  windowProgress, WINDOW_DAYS, type GroupStats, type Grouping, type TxnInsight,
} from "../../lib/goldPassbookReport";
import type { RoundupOptions } from "../../lib/goldRoundup";
import { localToday } from "../../lib/ipo";
import { Field, NumInput, Segmented } from "../journal/ui";

interface LoadedFile { name: string; book: ParsedPassbook; check: TotalsCheck | null }

const inr = (v: number, d = 0) =>
  `${v < -0.004 ? "−" : ""}₹${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const pct = (f: number, d = 1) => `${(f * 100).toFixed(d)}%`;
const g3 = (g: number) => `${g.toFixed(3)} g`;
const fmtFull = (day: string) => `${fmtDay(day)} ${day.slice(0, 4)}`;
const rate = (paise: number) => inr(paise / 100);

// The three gain parts, in the order they appear everywhere.
const PARTS = [
  { key: "weight", label: "Weight rounded up", dot: "bg-amber-500" },
  { key: "honest", label: "7% benefit", dot: "bg-teal-600" },
  { key: "benefit", label: "Benefit rounded up", dot: "bg-amber-800" },
] as const;

function partsOf(s: GroupStats) {
  return [
    { ...PARTS[0], rs: s.weightRoundRs, g: s.weightRoundG },
    { ...PARTS[1], rs: s.honestRs, g: s.honestG },
    { ...PARTS[2], rs: s.benefitRoundRs, g: s.benefitRoundG },
  ];
}
const gainOf = (s: GroupStats) => s.honestRs + s.roundingRs;

function Stat({ label, value, sub, dot }: { label: string; value: string; sub?: string; dot?: string }) {
  return (
    <div className="min-w-0 p-3.5 rounded-xl bg-brand-soft ring-1 ring-brand-border">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-mute flex items-center gap-1.5">
        {dot && <span className={`w-2.5 h-2.5 rounded-sm ${dot}`} aria-hidden />}{label}
      </div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-brand-mute tabular-nums">{sub}</div>}
    </div>
  );
}

function Panel({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="p-4 sm:p-5 rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="font-display font-semibold text-lg">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** How a panel's numbers are calculated. A = payment, R = that day's rate. */
function Formula({ lines }: { lines: [string, string][] }) {
  return (
    <div className="mt-3 p-3 rounded-xl bg-brand-soft ring-1 ring-brand-border text-xs">
      <div className="font-semibold text-brand-mute uppercase tracking-wide text-[10px] mb-1.5">How it's calculated</div>
      <dl className="grid sm:grid-cols-[minmax(0,12rem)_1fr] gap-x-4 gap-y-1">
        {lines.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-semibold">{k}</dt>
            <dd className="font-mono text-[11.5px] text-brand-text/80 break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const PER_PAYMENT_FORMULAS: [string, string][] = [
  ["Exact gold E", "A ÷ R"],
  ["Weight rounded up", "(credited weight − E) × R"],
  ["7% benefit", "7% × A   (= 7% × E × R; never rounded)"],
  ["Benefit rounded up", "(credited benefit − 7% × E) × R"],
  ["Total gain", "(credited weight + credited benefit) × R − A"],
  ["Each %", "that ₹ ÷ A paid"],
];

export default function PassbookReport({ ratePaise, opts }: { ratePaise: number | null; opts: RoundupOptions }) {
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);
  const [grouping, setGrouping] = useState<Grouping>("day");
  const [startOverride, setStartOverride] = useState("");
  const [making, setMaking] = useState("2");
  const [gst, setGst] = useState("3");

  async function addFiles(list: FileList | null) {
    const pdfs = [...(list ?? [])].filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    if (!pdfs.length) { setError("Choose a GRT passbook PDF."); return; }
    setBusy(true);
    setError("");
    try {
      const loaded: LoadedFile[] = [];
      for (const f of pdfs) {
        const book = parseGrtPassbook(await readPdfText(f));
        if (!book.txns.length) {
          setError(`${f.name}: no passbook rows found. This reads GRT Insta Gold passbook PDFs only.`);
          continue;
        }
        loaded.push({ name: f.name, book, check: checkTotals(book) });
      }
      setFiles((prev) => [...prev.filter((p) => !loaded.some((l) => l.name === p.name)), ...loaded]);
    } catch (e) {
      setError(`Could not read the PDF: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const merged = useMemo(() => mergeTxns(files.map((f) => f.book)), [files]);
  const firstDay = merged.txns[0]?.day ?? "";
  const start = startOverride || firstDay;
  const ins = useMemo(() => (start ? analyseTxns(merged.txns, opts, start) : []), [merged, opts, start]);
  const total = useMemo(() => totalInsights(ins), [ins]);
  const groups = useMemo(() => groupInsights(ins, grouping), [ins, grouping]);
  const members = new Set(files.map((f) => f.book.membershipNo).filter(Boolean));
  const skipped = merged.txns.length - ins.length;
  const latest = ins[ins.length - 1];

  return (
    <div className="space-y-5">
      <Panel title="Passbook report">
        <p className="text-sm text-brand-mute max-w-2xl">
          Add your GRT Insta Gold passbook PDF, weekly or monthly. Add several and overlapping payments are
          counted once. The file is read here in your browser and is never uploaded or saved.
        </p>
        <label
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void addFiles(e.dataTransfer.files); }}
          className={`mt-3 flex flex-col items-center justify-center gap-1 p-6 rounded-xl border-2 border-dashed
                      cursor-pointer text-center transition-colors
                      ${drag ? "border-teal-600 bg-teal-50" : "border-brand-border bg-brand-soft hover:border-teal-600/60"}`}>
          <input type="file" accept="application/pdf,.pdf" multiple className="sr-only"
                 onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
          <span className="text-sm font-semibold">{busy ? "Reading…" : "Choose passbook PDFs"}</span>
          <span className="text-xs text-brand-mute">or drop them here</span>
        </label>
        {error && <p role="alert" className="mt-2 text-sm text-brand-danger font-semibold">{error}</p>}

        {files.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {files.map((f) => (
              <li key={f.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-medium break-all">{f.name}</span>
                <span className="text-brand-mute tabular-nums">{f.book.txns.length} payments</span>
                <TotalsBadge check={f.check} />
                {f.book.problems.length > 0 && (
                  <span className="text-brand-danger text-xs font-semibold">
                    Could not read: {f.book.problems.join(", ")}
                  </span>
                )}
                <button type="button" className="text-xs font-semibold text-brand-mute hover:text-brand-text"
                        onClick={() => setFiles((p) => p.filter((x) => x !== f))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {ins.length > 0 && latest && (
        <>
          <Checks total={total} ins={ins} duplicates={merged.duplicates} skipped={skipped}
                  members={members.size} first={ins[0]!.txn.day} last={latest.txn.day} />

          <GainedPanel total={total} />
          <WorkedExample i={latest} />

          {ratePaise !== null && <ValuePanel ins={ins} total={total} ratePaise={ratePaise}
                                             making={making} setMaking={setMaking} gst={gst} setGst={setGst} />}

          <WindowPanel ins={ins} start={start} firstDay={firstDay}
                       onStart={(d) => setStartOverride(d === firstDay ? "" : d)} />

          <Panel title="By period" aside={
            <Segmented<Grouping> ariaLabel="Group by" value={grouping} onChange={setGrouping}
              options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
          }>
            <PeriodTable groups={groups} total={total} />
            <Formula lines={[
              ...PER_PAYMENT_FORMULAS.slice(1, 5),
              ["Period row", "each column = sum of that column over the period's payments"],
              ["Each %", "that ₹ ÷ Paid in the period"],
              ["Gain / payment", "Total gain ₹ ÷ Payments"],
            ]} />
          </Panel>

          <TxnTable ins={ins} />
        </>
      )}
    </div>
  );
}

function TotalsBadge({ check }: { check: TotalsCheck | null }) {
  if (!check) return <span className="text-xs text-brand-mute">no Total row to check against</span>;
  if (check.ok) return <span className="text-xs font-semibold text-emerald-700">✓ matches the passbook total</span>;
  const names: Record<string, string> = { amountPaise: "amount", weightMg: "weight", benefitMg: "benefit", totalMg: "total weight" };
  return (
    <span className="text-xs font-semibold text-brand-danger">
      ⚠ differs from the passbook total ({check.diffs.map((d) => names[d.field]).join(", ")})
    </span>
  );
}

function Checks({ total, ins, duplicates, skipped, members, first, last }: {
  total: GroupStats; ins: TxnInsight[]; duplicates: number; skipped: number; members: number; first: string; last: string;
}) {
  const mismatched = ins.filter((i) => !i.ruleMatch).length;
  const notBest = ins.filter((i) => i.missedRs > 0).length;
  const lost = ins.filter((i) => i.roundingG < 0).length;
  const notes: { tone: "ok" | "warn"; text: string }[] = [
    { tone: "ok", text: `${total.payments} payments from ${fmtFull(first)} to ${fmtFull(last)}.` },
    notBest === 0
      ? { tone: "ok", text: "Every payment was the best amount for its day's rate." }
      : { tone: "warn", text: `${notBest} payments weren't the best amount for their rate, leaving ${inr(total.missedRs, 2)} of gold on the table.` },
  ];
  if (lost) notes.push({ tone: "warn", text: `${lost} payments were rounded down and lost gold.` });
  if (mismatched) notes.push({ tone: "warn", text: `${mismatched} payments don't follow the usual rounding rule. Check those rows below.` });
  if (duplicates) notes.push({ tone: "ok", text: `${duplicates} repeated payments across files were counted once.` });
  if (skipped) notes.push({ tone: "warn", text: `${skipped} payments that aren't marked completed were left out.` });
  if (members > 1) notes.push({ tone: "warn", text: "These files are from different membership numbers." });
  return (
    <ul className="space-y-1 text-sm">
      {notes.map((n) => (
        <li key={n.text} className={n.tone === "ok" ? "text-brand-text" : "text-amber-800 font-medium"}>
          <span aria-hidden className="mr-1.5">{n.tone === "ok" ? "✓" : "⚠"}</span>{n.text}
        </li>
      ))}
    </ul>
  );
}

function GainedPanel({ total }: { total: GroupStats }) {
  const parts = partsOf(total);
  const gain = gainOf(total);
  const bar = [{ key: "money", label: "Your money buys", dot: "bg-brand-mute/40", g: total.exactG, rs: total.paidRs }, ...parts];
  return (
    <Panel title="What you've gained">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Paid" value={inr(total.paidRs)} sub={`${total.payments} payments · ${total.days} days`} />
        <Stat label="Gold credited" value={g3(total.creditedG)} sub={`money alone buys ${g3(total.exactG)}`} />
        <Stat label="Total gain" value={inr(gain, 2)} sub={`${pct(pctOfPaid(gain, total), 2)} of what you paid`} />
        <Stat label="Gain per payment" value={inr(gain / total.payments, 2)} sub={`of which rounding ${inr(total.roundingRs / total.payments, 2)}`} />
      </div>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {parts.map((p) => (
          <Stat key={p.key} dot={p.dot} label={p.label} value={inr(p.rs, 2)}
                sub={`${pct(pctOfPaid(p.rs, total), 2)} of paid · ${inr(p.rs / total.payments, 2)} per payment`} />
        ))}
      </div>

      <div className="mt-4">
        <div className="flex h-3.5 rounded-full overflow-hidden ring-1 ring-brand-border" aria-hidden>
          {bar.map((p) => (
            <div key={p.key} className={p.dot} style={{ width: `${Math.max(0, (p.g / total.creditedG) * 100)}%` }} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
          {bar.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1.5 tabular-nums">
              <span className={`w-2.5 h-2.5 rounded-sm ${p.dot}`} aria-hidden />
              {p.label} <span className="font-semibold">{p.g.toFixed(4)} g</span>
              <span className="text-brand-mute">({pct(p.g / total.creditedG)} of your gold)</span>
            </span>
          ))}
        </div>
      </div>

      <Formula lines={[
        ...PER_PAYMENT_FORMULAS,
        ["Totals above", "sum of each payment's figure, worked out one payment at a time"],
        ["Gold credited", `Σ passbook Total Wt = ${g3(total.creditedG)}`],
        ["Check", `${inr(total.paidRs, 2)} + ${inr(total.weightRoundRs, 2)} + ${inr(total.honestRs, 2)} + ${inr(total.benefitRoundRs, 2)} = credited gold at each day's rate`],
      ]} />
    </Panel>
  );
}

/** The latest payment, step by step — the same arithmetic every row uses. */
function WorkedExample({ i }: { i: TxnInsight }) {
  const t = i.txn;
  const A = t.amountPaise / 100;
  const R = t.ratePaise / 100;
  const W = t.weightMg / 1000;
  const B = t.benefitMg / 1000;
  const bpPct = i.benefitBp / 100;
  const rows: { step: string; formula: string; grams: string; rs: string; strong?: boolean }[] = [
    { step: "Your money buys exactly", formula: `${A} ÷ ${R}`, grams: i.exactG.toFixed(7), rs: inr(A, 2) },
    { step: "Credited weight (passbook)", formula: "rounded to 0.001 g", grams: W.toFixed(3), rs: inr(W * R, 2) },
    { step: "Weight rounded up", formula: `(${W.toFixed(3)} − ${i.exactG.toFixed(7)}) × ${R}`, grams: i.weightRoundG.toFixed(7), rs: inr(i.weightRoundRs, 2), strong: true },
    { step: `${bpPct}% benefit, exact`, formula: `${bpPct}% × ${i.exactG.toFixed(7)}`, grams: i.honestG.toFixed(7), rs: inr(i.honestRs, 2), strong: true },
    { step: "Credited benefit (passbook)", formula: "rounded to 0.001 g", grams: B.toFixed(3), rs: inr(B * R, 2) },
    { step: "Benefit rounded up", formula: `(${B.toFixed(3)} − ${i.honestG.toFixed(7)}) × ${R}`, grams: i.benefitRoundG.toFixed(7), rs: inr(i.benefitRoundRs, 2), strong: true },
    { step: "Total gain", formula: `(${W.toFixed(3)} + ${B.toFixed(3)}) × ${R} − ${A}`, grams: (i.creditedG - i.exactG).toFixed(7), rs: inr(i.honestRs + i.roundingRs, 2), strong: true },
  ];
  return (
    <Panel title={`Worked example: your latest payment (${fmtDay(t.day)} ${t.when.slice(11)})`}>
      <p className="text-sm text-brand-mute -mt-1 mb-3 tabular-nums">
        {inr(A, A % 1 ? 2 : 0)} at {rate(t.ratePaise)}/g, credited {W.toFixed(3)} g + {B.toFixed(3)} g benefit.
      </p>
      <div className="overflow-x-auto -mx-1">
        <table className="min-w-full text-[13px] tabular-nums">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
              <th className="px-2 py-2 text-left">Step</th>
              <th className="px-2 py-2 text-left">Formula</th>
              <th className="px-2 py-2 text-right">Grams</th>
              <th className="px-2 py-2 text-right">₹ at {rate(t.ratePaise)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.step} className={`border-t border-brand-border ${r.strong ? "font-semibold" : ""}`}>
                <td className="px-2 py-1.5 whitespace-nowrap">{r.step}</td>
                <td className="px-2 py-1.5 whitespace-nowrap font-mono text-[12px] text-brand-mute">{r.formula}</td>
                <td className="px-2 py-1.5 text-right">{r.grams}</td>
                <td className="px-2 py-1.5 text-right">{r.rs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm tabular-nums">
        {inr(i.weightRoundRs, 2)} weight rounded up + {inr(i.honestRs, 2)} {bpPct}% benefit + {inr(i.benefitRoundRs, 2)} benefit
        rounded up = <span className="font-semibold">{inr(i.honestRs + i.roundingRs, 2)}</span> gain
        ({pct((i.honestRs + i.roundingRs) / A, 2)} of {inr(A, A % 1 ? 2 : 0)}). The {B.toFixed(3)} g benefit you got is
        worth {inr(B * R, 2)}: the {inr(i.honestRs, 2)} promised plus {inr(i.benefitRoundRs, 2)} from rounding.
      </p>
    </Panel>
  );
}

function ValuePanel({ ins, total, ratePaise, making, setMaking, gst, setGst }: {
  ins: TxnInsight[]; total: GroupStats; ratePaise: number;
  making: string; setMaking: (v: string) => void; gst: string; setGst: (v: string) => void;
}) {
  const v = valueToday(ins, ratePaise);
  const r = redemption(v, total.paidRs, Number(making) || 0, Number(gst) || 0);
  const rows: [string, number][] = [
    ["Gold price movement", v.priceRs],
    ["Weight rounded up", v.weightRoundRs],
    ["7% benefit", v.honestRs],
    ["Benefit rounded up", v.benefitRoundRs],
  ];
  const T = ratePaise / 100;
  return (
    <Panel title={`Worth today at ${rate(ratePaise)}/g`}>
      <div className="grid sm:grid-cols-2 gap-5">
        <div>
          <div className="text-3xl font-display font-bold tabular-nums">{inr(v.valueRs)}</div>
          <div className="text-sm text-brand-mute tabular-nums">
            for {inr(total.paidRs)} paid · gain{" "}
            <span className={v.gainRs >= 0 ? "text-emerald-700 font-semibold" : "text-brand-danger font-semibold"}>
              {inr(v.gainRs, 2)} ({pct(v.gainRs / total.paidRs)})
            </span>
          </div>
          <table className="mt-3 w-full text-sm tabular-nums">
            <tbody>
              {rows.map(([label, rs]) => (
                <tr key={label} className="border-t border-brand-border">
                  <td className="py-1.5">{label}</td>
                  <td className={`py-1.5 text-right ${rs < 0 ? "text-brand-danger" : ""}`}>{inr(rs, 2)}</td>
                  <td className="py-1.5 text-right text-brand-mute w-16">{pct(rs / total.paidRs)}</td>
                </tr>
              ))}
              <tr className="border-t border-brand-border font-semibold">
                <td className="py-1.5">Total gain</td>
                <td className="py-1.5 text-right">{inr(v.gainRs, 2)}</td>
                <td className="py-1.5 text-right w-16">{pct(v.gainRs / total.paidRs)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-brand-mute">Uses the gold rate typed in the calculator.</p>
        </div>
        <div>
          <div className="text-sm font-semibold">If you take it as coins</div>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Field label="Making charge">
              <NumInput suffix="%" inputMode="decimal" value={making} onChange={(e) => setMaking(e.target.value)} />
            </Field>
            <Field label="GST">
              <NumInput suffix="%" inputMode="decimal" value={gst} onChange={(e) => setGst(e.target.value)} />
            </Field>
          </div>
          <div className="mt-3 text-sm tabular-nums space-y-1">
            <div>You pay about <span className="font-semibold">{inr(r.costRs, 2)}</span> more at redemption.</div>
            <div>
              Net gain{" "}
              <span className={r.netGainRs >= 0 ? "text-emerald-700 font-semibold" : "text-brand-danger font-semibold"}>
                {inr(r.netGainRs, 2)} ({pct(r.netGainRs / total.paidRs)} of what you paid)
              </span>
            </div>
          </div>
        </div>
      </div>
      <Formula lines={[
        ["Worth today", `gold credited × today's rate = ${g3(total.creditedG)} × ${inr(T)}`],
        ["Gold price movement", "Σ credited grams × (today's rate − that day's rate R)"],
        ["Rounding and benefit rows", "valued at each payment's own rate R, as in the tables"],
        ["Total gain", "worth today − paid = sum of the four rows above"],
        ["Making charge", `making % × worth today`],
        ["GST", "GST % × (worth today + making charge)"],
        ["Net gain", "total gain − making charge − GST"],
      ]} />
    </Panel>
  );
}

function WindowPanel({ ins, start, firstDay, onStart }: {
  ins: TxnInsight[]; start: string; firstDay: string; onStart: (d: string) => void;
}) {
  const w = windowProgress(ins, start, localToday());
  return (
    <Panel title={`${WINDOW_DAYS}-day benefit window`}>
      <div className="grid sm:grid-cols-[minmax(0,14rem)_1fr] gap-4 items-start">
        <Field label="Window started on">
          <input type="date" value={start} onChange={(e) => onStart(e.target.value || firstDay)}
                 className="w-full rounded-lg ring-1 ring-brand-border bg-white px-2.5 py-1.5 text-sm
                            focus:outline-none focus:ring-2 focus:ring-teal-600/50" />
        </Field>
        <div className="min-w-0">
          <div className="flex justify-between text-sm tabular-nums">
            <span>Day {w.elapsed} of {WINDOW_DAYS}</span>
            <span className="text-brand-mute">{w.left} days left · ends {fmtFull(w.end)}</span>
          </div>
          <div className="mt-1.5 h-2.5 rounded-full bg-brand-soft ring-1 ring-brand-border overflow-hidden">
            <div className="h-full bg-teal-600 rounded-full" style={{ width: `${(w.elapsed / WINDOW_DAYS) * 100}%` }} />
          </div>
          <p className="mt-3 text-sm">
            So far you put in <span className="font-semibold tabular-nums">{inr(w.paidPerDay)}</span> a day on average.
            {w.left > 0 && (
              <> Keeping that pace for the remaining {w.left} days adds about{" "}
                <span className="font-semibold tabular-nums">{inr(w.projectedPaidRs)}</span>, earning about{" "}
                <span className="font-semibold tabular-nums text-emerald-700">{inr(w.projectedHonestRs)}</span> from the 7% benefit and{" "}
                <span className="font-semibold tabular-nums text-emerald-700">{inr(w.projectedRoundingRs)}</span> from rounding.</>
            )}
          </p>
          {w.outside > 0 && (
            <p className="mt-1 text-xs text-amber-800">
              {w.outside} payments fall outside this window, so no benefit is counted for them.
            </p>
          )}
        </div>
      </div>
      <Formula lines={[
        ["Day n", "days from the start date to today, counting both"],
        ["Average a day", "paid inside the window ÷ days so far (days with no payment count too)"],
        ["Adds about", "average a day × days left"],
        ["Earning about", "adds about × your 7% share so far, and × your rounding % so far"],
      ]} />
    </Panel>
  );
}

const thCls = "px-2 py-1.5 whitespace-nowrap";

function PeriodTable({ groups, total }: { groups: GroupStats[]; total: GroupStats }) {
  const row = (g: GroupStats, isTotal = false) => {
    const gain = gainOf(g);
    return (
      <tr key={g.key} className={`border-t border-brand-border ${isTotal ? "font-semibold bg-brand-soft" : ""}`}>
        <td className="px-2 py-1.5 whitespace-nowrap">{isTotal ? "Total" : g.label}</td>
        <td className="px-2 py-1.5 text-right">{g.payments}</td>
        <td className="px-2 py-1.5 text-right">{inr(g.paidRs)}</td>
        <td className="px-2 py-1.5 text-right">{g3(g.creditedG)}</td>
        {partsOf(g).map((p) => (
          <FragmentCells key={p.key} rs={p.rs} share={pctOfPaid(p.rs, g)} />
        ))}
        <FragmentCells rs={gain} share={pctOfPaid(gain, g)} strong />
        <td className="px-2 py-1.5 text-right">{inr(gain / g.payments, 2)}</td>
      </tr>
    );
  };
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="min-w-full text-[13px] tabular-nums">
        <thead className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
          <tr>
            <th rowSpan={2} className={`${thCls} text-left align-bottom`}>Period</th>
            <th rowSpan={2} className={`${thCls} text-right align-bottom`}>Payments</th>
            <th rowSpan={2} className={`${thCls} text-right align-bottom`}>Paid</th>
            <th rowSpan={2} className={`${thCls} text-right align-bottom`}>Credited</th>
            {PARTS.map((p) => (
              <th key={p.key} colSpan={2} className={`${thCls} text-center border-l border-brand-border`}>
                <span className={`inline-block w-2 h-2 rounded-sm mr-1 ${p.dot}`} aria-hidden />{p.label}
              </th>
            ))}
            <th colSpan={2} className={`${thCls} text-center border-l border-brand-border text-brand-text`}>Total gain</th>
            <th rowSpan={2} className={`${thCls} text-right align-bottom border-l border-brand-border`}>Gain / payment</th>
          </tr>
          <tr>
            {[...PARTS, { key: "total" }].map((p) => (
              <SubHeads key={p.key} />
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => row(g))}
          {groups.length > 1 && row(total, true)}
        </tbody>
      </table>
    </div>
  );
}

function SubHeads() {
  return (
    <>
      <th className={`${thCls} text-right border-l border-brand-border`}>₹</th>
      <th className={`${thCls} text-right`}>%</th>
    </>
  );
}

function FragmentCells({ rs, share, strong = false }: { rs: number; share: number; strong?: boolean }) {
  return (
    <>
      <td className={`px-2 py-1.5 text-right border-l border-brand-border ${strong ? "font-semibold" : ""} ${rs < -0.004 ? "text-brand-danger" : ""}`}>
        {inr(rs, 2)}
      </td>
      <td className={`px-2 py-1.5 text-right ${strong ? "font-semibold" : "text-brand-mute"}`}>{pct(share, 2)}</td>
    </>
  );
}

function TxnTable({ ins }: { ins: TxnInsight[] }) {
  const flagged = ins.filter((i) => !i.ruleMatch || i.missedRs > 0 || i.roundingG < 0).length;
  return (
    <details className="group rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card">
      <summary className="cursor-pointer list-none p-4 sm:p-5 flex items-center justify-between gap-2">
        <span className="font-display font-semibold text-lg">Every payment</span>
        <span className="text-xs text-brand-mute">
          {ins.length} payments{flagged ? ` · ${flagged} flagged` : ""} · <span className="group-open:hidden">show</span>
          <span className="hidden group-open:inline">hide</span>
        </span>
      </summary>
      <div className="px-3 pb-4">
        <div className="overflow-x-auto">
          <table className="min-w-full text-[13px] tabular-nums">
            <thead className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
              <tr>
                {["When", "Paid A", "Rate R", "Exact E", "Weight", "Benefit"].map((h, idx) => (
                  <th key={h} rowSpan={2} className={`${thCls} align-bottom ${idx ? "text-right" : "text-left"}`}>{h}</th>
                ))}
                {PARTS.map((p) => (
                  <th key={p.key} colSpan={2} className={`${thCls} text-center border-l border-brand-border`}>
                    <span className={`inline-block w-2 h-2 rounded-sm mr-1 ${p.dot}`} aria-hidden />{p.label}
                  </th>
                ))}
                <th colSpan={2} className={`${thCls} text-center border-l border-brand-border text-brand-text`}>Total gain</th>
                <th rowSpan={2} className={`${thCls} text-left align-bottom border-l border-brand-border`}>Note</th>
              </tr>
              <tr>
                {[...PARTS, { key: "total" }].map((p) => <SubHeads key={p.key} />)}
              </tr>
            </thead>
            <tbody>
              {[...ins].reverse().map((i) => {
                const t = i.txn;
                const A = t.amountPaise / 100;
                const note = !i.ruleMatch ? "Doesn't match the rounding rule"
                  : i.roundingG < 0 ? "Rounded down"
                  : i.missedRs > 0 ? `Best was ₹${i.bestAmountPaise / 100} (missed ${inr(i.missedRs, 2)})`
                  : "";
                const gain = i.honestRs + i.roundingRs;
                return (
                  <tr key={t.tranNo || `${t.when}-${t.sno}`} className="border-t border-brand-border">
                    <td className="px-2 py-1.5 whitespace-nowrap">{fmtDay(t.day)} {t.when.slice(11)}</td>
                    <td className="px-2 py-1.5 text-right">{inr(A, A % 1 ? 2 : 0)}</td>
                    <td className="px-2 py-1.5 text-right">{rate(t.ratePaise)}</td>
                    <td className="px-2 py-1.5 text-right">{i.exactG.toFixed(5)}</td>
                    <td className="px-2 py-1.5 text-right">{(t.weightMg / 1000).toFixed(3)}</td>
                    <td className="px-2 py-1.5 text-right">{(t.benefitMg / 1000).toFixed(3)}</td>
                    <FragmentCells rs={i.weightRoundRs} share={i.weightRoundRs / A} />
                    <FragmentCells rs={i.honestRs} share={i.honestRs / A} />
                    <FragmentCells rs={i.benefitRoundRs} share={i.benefitRoundRs / A} />
                    <FragmentCells rs={gain} share={gain / A} strong />
                    <td className={`px-2 py-1.5 whitespace-nowrap border-l border-brand-border ${note ? "text-amber-800 font-medium" : ""}`}>{note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Formula lines={[...PER_PAYMENT_FORMULAS, ["Weight, Benefit", "grams credited, read straight from the passbook"]]} />
      </div>
    </details>
  );
}
