// -----------------------------------------------------------------------------
// Goals — net-worth milestones with trend-based ETAs, the monthly income
// ledger that powers the savings rate, and the financial-freedom projection
// (kept here, away from the core dashboard, on purpose).
// -----------------------------------------------------------------------------
import { monthLabel } from "../../lib/expenses";
import { fmtMoney } from "../../lib/money";
import {
  coastCorpus, fmtIndian, freedomProjection, milestoneEta, milestoneProgress, num,
  type SavingsPoint,
} from "../../lib/networth";
import type { IncomeRow, Milestone, NetWorthSettings, NetWorthSnapshot } from "../../lib/networthApi";
import { SectionCard } from "../expenses/ui";
import { GhostBtn, PrimaryBtn, RowBtn } from "../journal/ui";
import { NoData, ProgressBar } from "./ui";

export default function GoalsTab({
  milestones, netWorth, snapshots, currentMonth, income, savings, settings, derivedSavings,
  onAddMilestone, onEditMilestone, onDeleteMilestone, onSetIncome, onDeleteIncome, onEditFreedom,
}: {
  milestones: Milestone[];
  netWorth: number;
  snapshots: NetWorthSnapshot[];
  currentMonth: string;
  income: IncomeRow[];
  savings: SavingsPoint[];
  settings: NetWorthSettings | null;
  /** 3-month average of (income − expenses), when both exist. */
  derivedSavings: number | null;
  onAddMilestone: () => void;
  onEditMilestone: (m: Milestone) => void;
  onDeleteMilestone: (m: Milestone) => void;
  onSetIncome: (monthKey: string) => void;
  onDeleteIncome: (r: IncomeRow) => void;
  onEditFreedom: () => void;
}) {
  const target = settings?.ff_target_corpus ? num(settings.ff_target_corpus) : null;
  const realReturn = settings ? num(settings.ff_real_return_pct) : 6;
  const monthlySavings = settings?.ff_monthly_savings ? num(settings.ff_monthly_savings) : derivedSavings;
  const freedom = target && monthlySavings !== null
    ? freedomProjection({ current: netWorth, monthlySavings, realReturnPct: realReturn, target, currentMonth })
    : null;
  const incomeByKey = new Map(income.map((r) => [r.month.slice(0, 7), r]));

  return (
    <div className="space-y-4">
      {/* ---- Milestones ---- */}
      <SectionCard title="Net-worth milestones" right={<PrimaryBtn onClick={onAddMilestone}>+ Milestone</PrimaryBtn>}>
        {!milestones.length ? (
          <NoData>Add a goal — ₹10L, ₹25L, ₹1Cr — and Plutus tracks progress and, once it has three snapshots, a pace-based ETA.</NoData>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {milestones.map((m) => {
              const p = milestoneProgress(m, netWorth);
              const eta = milestoneEta(p.target, netWorth, snapshots, currentMonth);
              return (
                <li key={m.id} className={`rounded-xl ring-1 px-4 py-3 ${p.achieved ? "bg-teal-50 ring-teal-200" : "bg-brand-soft ring-brand-border/60"}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="font-semibold">{m.label} <span className="text-brand-mute font-normal text-[12px]">· {fmtIndian(p.target, 1)} goal</span></div>
                    <span className="inline-flex gap-0.5">
                      <RowBtn title="Edit" onClick={() => onEditMilestone(m)}>✎</RowBtn>
                      <RowBtn title="Remove" danger onClick={() => onDeleteMilestone(m)}>🗑</RowBtn>
                    </span>
                  </div>
                  <div className="mt-1 text-sm tabular-nums">
                    {fmtIndian(netWorth, 1)} / {fmtIndian(p.target, 1)}
                    <b className={`ml-2 ${p.achieved ? "text-teal-700" : ""}`}>{p.pct.toFixed(1)}%</b>
                  </div>
                  <div className="mt-1.5"><ProgressBar pct={p.pct} tone={p.achieved ? "bg-teal-600" : "bg-teal-600/80"} /></div>
                  <div className="mt-1.5 text-[11px] text-brand-mute">
                    {p.achieved
                      ? <>🎉 Reached{m.achieved_on ? ` in ${monthLabel(m.achieved_on.slice(0, 7))}` : ""}.</>
                      : eta.months !== null && eta.monthKey
                        ? <>₹{fmtMoney(p.remaining, 0)} to go · ETA {eta.rough ? "~" : ""}{monthLabel(eta.monthKey)} ({eta.months} month{eta.months === 1 ? "" : "s"}). <span title={eta.basis}>ⓘ</span></>
                        : <>₹{fmtMoney(p.remaining, 0)} to go · {eta.basis}</>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- Income ledger ---- */}
        <SectionCard title="Monthly income" right={<GhostBtn onClick={() => onSetIncome(currentMonth)}>+ This month</GhostBtn>}>
          <p className="text-[11px] text-brand-mute mb-2">
            Take-home per month, entered by hand — Plutus has no income feed. Expenses come from the tracker.
          </p>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
                <th className="text-left py-1">Month</th>
                <th className="text-right py-1">Income</th>
                <th className="text-right py-1">Expenses</th>
                <th className="text-right py-1">Saved</th>
                <th className="text-right py-1">Rate</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {savings.slice(-6).reverse().map((p) => {
                const row = incomeByKey.get(p.key) ?? null;
                return (
                  <tr key={p.key} className="border-t border-brand-border/50 tabular-nums">
                    <td className="py-1.5 font-medium">{monthLabel(p.key)}</td>
                    <td className="py-1.5 text-right">
                      {p.income === null
                        ? <button type="button" onClick={() => onSetIncome(p.key)}
                                  className="text-[11px] font-semibold text-brand-accent hover:underline">enter</button>
                        : `₹${fmtMoney(p.income, 0)}`}
                    </td>
                    <td className="py-1.5 text-right text-brand-mute">{p.expenses ? `₹${fmtMoney(p.expenses, 0)}` : "—"}</td>
                    <td className="py-1.5 text-right">{p.income === null ? "—" : `₹${fmtMoney(p.income - p.expenses, 0)}`}</td>
                    <td className={`py-1.5 text-right font-semibold ${p.rate === null ? "text-brand-mute" : p.rate < 0 ? "text-rose-700" : p.rate >= 30 ? "text-teal-700" : ""}`}>
                      {p.rate === null ? "—" : `${p.rate.toFixed(0)}%`}
                    </td>
                    <td className="py-1.5 text-right">
                      {row && (
                        <span className="inline-flex gap-0.5">
                          <RowBtn title="Edit" onClick={() => onSetIncome(p.key)}>✎</RowBtn>
                          <RowBtn title="Remove" danger onClick={() => onDeleteIncome(row)}>🗑</RowBtn>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </SectionCard>

        {/* ---- Financial freedom ---- */}
        <SectionCard title="Financial freedom" right={<GhostBtn onClick={onEditFreedom}>⚙ Inputs</GhostBtn>}>
          {!target ? (
            <NoData>Set a target corpus to project when your net worth, compounding at a real return plus your monthly savings, reaches it.</NoData>
          ) : monthlySavings === null ? (
            <NoData>Needs monthly savings — enter income for a few months, or set it directly in the inputs.</NoData>
          ) : freedom ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-display font-semibold tabular-nums">{freedom.progressPct.toFixed(1)}%</span>
                <span className="text-sm text-brand-mute">of {fmtIndian(target, 2)}</span>
              </div>
              <div className="mt-2"><ProgressBar pct={freedom.progressPct} tone="bg-violet-600" /></div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-[12px]">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">Projected freedom</div>
                  <div className="mt-0.5 font-display font-semibold text-base">
                    {freedom.monthKey ? monthLabel(freedom.monthKey) : "—"}
                  </div>
                  <div className="text-brand-mute">
                    {freedom.monthsToTarget === null ? "not reachable at these inputs"
                      : freedom.monthsToTarget === 0 ? "already there"
                      : `${Math.floor(freedom.monthsToTarget / 12)}y ${freedom.monthsToTarget % 12}m at ₹${fmtMoney(monthlySavings, 0)}/mo, ${realReturn}% real`}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">In 5 / 10 years</div>
                  <div className="mt-0.5 font-display font-semibold text-base tabular-nums">
                    {fmtIndian(freedom.projectedAt(60), 1)} · {fmtIndian(freedom.projectedAt(120), 1)}
                  </div>
                  <div className="text-brand-mute">
                    coast number for 10y: {fmtIndian(coastCorpus(target, realReturn, 10) ?? 0, 1)}
                  </div>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-brand-mute">
                Current corpus = net worth. Projection assumes a constant real return and constant
                savings — a planning aid, not a forecast.
              </p>
            </>
          ) : null}
        </SectionCard>
      </div>
    </div>
  );
}
