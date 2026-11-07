// -----------------------------------------------------------------------------
// Passbook report — drop in GRT passbook PDFs, see what the scheme and the
// rounding actually earned, per payment / day / week / month.
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
  `${v < 0 ? "−" : ""}₹${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const pct = (f: number, d = 1) => `${(f * 100).toFixed(d)}%`;
const g3 = (g: number) => `${g.toFixed(3)} g`;
const fmtFull = (day: string) => `${fmtDay(day)} ${day.slice(0, 4)}`;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 p-3.5 rounded-xl bg-brand-soft ring-1 ring-brand-border">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-mute">{label}</div>
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

      {ins.length > 0 && (
        <>
          <Checks total={total} ins={ins} duplicates={merged.duplicates} skipped={skipped}
                  members={members.size} first={ins[0]!.txn.day} last={ins[ins.length - 1]!.txn.day} />

          <Panel title="What you've gained">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Stat label="Paid" value={inr(total.paidRs)} sub={`${total.payments} payments · ${total.days} days`} />
              <Stat label="Gold credited" value={g3(total.creditedG)} sub={`money alone buys ${g3(total.exactG)}`} />
              <Stat label="Gained from the scheme" value={inr(total.honestRs + total.roundingRs)}
                    sub={`${pct(pctOfPaid(total.honestRs + total.roundingRs, total))} of what you paid`} />
              <Stat label="Rounding per payment" value={inr(total.roundingRs / total.payments, 2)}
                    sub={`${pct(pctOfPaid(total.roundingRs, total))} of each payment`} />
            </div>
            <Composition total={total} />
          </Panel>

          {ratePaise !== null && <ValuePanel ins={ins} total={total} ratePaise={ratePaise}
                                             making={making} setMaking={setMaking} gst={gst} setGst={setGst} />}

          <WindowPanel ins={ins} start={start} firstDay={firstDay}
                       onStart={(d) => setStartOverride(d === firstDay ? "" : d)} />

          <Panel title="By period" aside={
            <Segmented<Grouping> ariaLabel="Group by" value={grouping} onChange={setGrouping}
              options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
          }>
            <PeriodTable groups={groups} total={total} />
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

function Composition({ total }: { total: GroupStats }) {
  const parts = [
    { label: "Your money buys", g: total.exactG, cls: "bg-brand-mute/40" },
    { label: "Honest benefit", g: total.honestG, cls: "bg-teal-600" },
    { label: "Rounding extra", g: total.creditedG - total.exactG - total.honestG, cls: "bg-brand-gold" },
  ];
  return (
    <div className="mt-4">
      <div className="flex h-3.5 rounded-full overflow-hidden ring-1 ring-brand-border" aria-hidden>
        {parts.map((p) => (
          <div key={p.label} className={p.cls} style={{ width: `${Math.max(0, (p.g / total.creditedG) * 100)}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {parts.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1.5 tabular-nums">
            <span className={`w-2.5 h-2.5 rounded-sm ${p.cls}`} aria-hidden />
            {p.label} <span className="font-semibold">{g3(p.g)}</span>
            <span className="text-brand-mute">({pct(p.g / total.creditedG)} of your gold)</span>
          </span>
        ))}
      </div>
    </div>
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
    ["Honest benefit", v.honestRs],
    ["Rounding extra", v.roundingRs],
  ];
  return (
    <Panel title={`Worth today at ${inr(ratePaise / 100)}/g`}>
      <div className="grid sm:grid-cols-2 gap-5">
        <div>
          <div className="text-3xl font-display font-bold tabular-nums">{inr(v.valueRs)}</div>
          <div className="text-sm text-brand-mute tabular-nums">
            for {inr(total.paidRs)} paid · gain{" "}
            <span className={v.gainRs >= 0 ? "text-emerald-700 font-semibold" : "text-brand-danger font-semibold"}>
              {inr(v.gainRs)} ({pct(v.gainRs / total.paidRs)})
            </span>
          </div>
          <table className="mt-3 w-full text-sm tabular-nums">
            <tbody>
              {rows.map(([label, rs]) => (
                <tr key={label} className="border-t border-brand-border">
                  <td className="py-1.5">{label}</td>
                  <td className={`py-1.5 text-right ${rs < 0 ? "text-brand-danger" : ""}`}>{inr(rs)}</td>
                  <td className="py-1.5 text-right text-brand-mute w-16">{pct(rs / total.paidRs)}</td>
                </tr>
              ))}
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
            <div>You pay about <span className="font-semibold">{inr(r.costRs)}</span> more at redemption.</div>
            <div>
              Net gain{" "}
              <span className={r.netGainRs >= 0 ? "text-emerald-700 font-semibold" : "text-brand-danger font-semibold"}>
                {inr(r.netGainRs)} ({pct(r.netGainRs / total.paidRs)} of what you paid)
              </span>
            </div>
          </div>
        </div>
      </div>
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
                <span className="font-semibold tabular-nums text-emerald-700">{inr(w.projectedHonestRs)}</span> honest benefit and{" "}
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
    </Panel>
  );
}

function PeriodTable({ groups, total }: { groups: GroupStats[]; total: GroupStats }) {
  const maxPct = Math.max(...groups.map((g) => pctOfPaid(g.honestRs + g.roundingRs, g)), 0.0001);
  const row = (g: GroupStats, isTotal = false) => {
    const totalPct = pctOfPaid(g.honestRs + g.roundingRs, g);
    return (
      <tr key={g.key} className={`border-t border-brand-border ${isTotal ? "font-semibold bg-brand-soft" : ""}`}>
        <td className="px-2 py-1.5 whitespace-nowrap">{isTotal ? "Total" : g.label}</td>
        <td className="px-2 py-1.5 text-right">{g.payments}</td>
        <td className="px-2 py-1.5 text-right">{inr(g.paidRs)}</td>
        <td className="px-2 py-1.5 text-right">{g3(g.creditedG)}</td>
        <td className="px-2 py-1.5 text-right">{inr(g.honestRs)}</td>
        <td className="px-2 py-1.5 text-right">{inr(g.roundingRs)}</td>
        <td className="px-2 py-1.5 text-right">{pct(pctOfPaid(g.roundingRs, g))}</td>
        <td className="px-2 py-1.5 text-right">{inr(g.roundingRs / g.payments, 2)}</td>
        <td className="px-2 py-1.5">
          <div className="flex items-center justify-end gap-2">
            {!isTotal && (
              <div className="w-16 h-1.5 rounded-full bg-brand-soft overflow-hidden" aria-hidden>
                <div className="h-full bg-brand-gold" style={{ width: `${(totalPct / maxPct) * 100}%` }} />
              </div>
            )}
            <span>{pct(totalPct)}</span>
          </div>
        </td>
      </tr>
    );
  };
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="min-w-full text-[13px] tabular-nums">
        <thead>
          <tr className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
            {["Period", "Payments", "Paid", "Credited", "Honest ₹", "Rounding ₹", "Rounding %", "Rounding / pay", "Total gain"].map((h, i) => (
              <th key={h} className={`px-2 py-2 whitespace-nowrap ${i ? "text-right" : "text-left"}`}>{h}</th>
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
      <div className="overflow-x-auto px-3 pb-4">
        <table className="min-w-full text-[13px] tabular-nums">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
              {["When", "Paid", "Rate", "Exact", "Credited", "Honest ₹", "Rounding ₹", "Rounding %", "Note"].map((h, i) => (
                <th key={h} className={`px-2 py-2 whitespace-nowrap ${i && i < 8 ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...ins].reverse().map((i) => {
              const t = i.txn;
              const note = !i.ruleMatch ? "Doesn't match the rounding rule"
                : i.roundingG < 0 ? "Rounded down"
                : i.missedRs > 0 ? `Best was ₹${i.bestAmountPaise / 100} (missed ${inr(i.missedRs, 2)})`
                : "";
              return (
                <tr key={t.tranNo || `${t.when}-${t.sno}`} className="border-t border-brand-border">
                  <td className="px-2 py-1.5 whitespace-nowrap">{fmtDay(t.day)} {t.when.slice(11)}</td>
                  <td className="px-2 py-1.5 text-right">{inr(t.amountPaise / 100, t.amountPaise % 100 ? 2 : 0)}</td>
                  <td className="px-2 py-1.5 text-right">{inr(t.ratePaise / 100)}</td>
                  <td className="px-2 py-1.5 text-right">{i.exactG.toFixed(5)}</td>
                  <td className="px-2 py-1.5 text-right">{(t.weightMg / 1000).toFixed(3)} + {(t.benefitMg / 1000).toFixed(3)}</td>
                  <td className="px-2 py-1.5 text-right">{inr(i.honestRs, 2)}</td>
                  <td className={`px-2 py-1.5 text-right ${i.roundingRs < 0 ? "text-brand-danger" : ""}`}>{inr(i.roundingRs, 2)}</td>
                  <td className="px-2 py-1.5 text-right">{pct(i.roundingRs / (t.amountPaise / 100))}</td>
                  <td className={`px-2 py-1.5 whitespace-nowrap ${note ? "text-amber-800 font-medium" : ""}`}>{note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
