// -----------------------------------------------------------------------------
// Net Worth overview — answers, top to bottom: what am I worth, which way is
// it moving, where is the money, what should I notice, and the four health
// gauges (runway · savings rate · XIRR · concentration). Everything derives
// in lib/networth.ts from the raw rows; nothing is computed here.
// -----------------------------------------------------------------------------
import { Link } from "react-router-dom";
import { OwnerOnly } from "../AuthGate";
import type { Insight } from "../../lib/expenses";
import { monthLabel } from "../../lib/expenses";
import { fmtMoney, fmtPct } from "../../lib/money";
import {
  fmtIndian, type AllocationSlice, type Delta, type HealthCheck, type NetWorthTotals,
  type Runway, type SavingsPoint, type XirrResult,
} from "../../lib/networth";
import { BarRow, Donut, SectionCard } from "../expenses/ui";
import { AreaChart, NoData, RUNWAY_CLS, TONE_CLS, colorFor, type TrendPoint } from "./ui";

export default function OverviewTab({
  totals, delta, baselineLabel, trend, alloc, insights, health, runway, burn, liquid,
  savings, avgRate3, xirr, snapshotCount, hasExpenses, onTakeSnapshot, snapshotBusy,
}: {
  totals: NetWorthTotals;
  delta: Delta | null;
  baselineLabel: string | null;
  trend: TrendPoint[];
  alloc: AllocationSlice[];
  insights: Insight[];
  health: HealthCheck[];
  runway: Runway;
  burn: { avg: number; months: number };
  liquid: number;
  savings: SavingsPoint[];
  avgRate3: { avg: number | null; months: number };
  xirr: XirrResult;
  snapshotCount: number;
  hasExpenses: boolean;
  onTakeSnapshot: () => void;
  snapshotBusy: boolean;
}) {
  const empty = totals.totalAssets === 0 && totals.liabilities === 0;
  const current = savings[savings.length - 1] ?? null;
  const up = (delta?.abs ?? 0) >= 0;

  return (
    <div className="space-y-4">
      {/* ---- Hero ---- */}
      <section className={`rounded-2xl ring-1 ring-brand-border shadow-card p-5 sm:p-6 ${
        empty ? "bg-brand-panel" : up
          ? "bg-gradient-to-br from-teal-50 via-brand-panel to-brand-panel"
          : "bg-gradient-to-br from-rose-50 via-brand-panel to-brand-panel"}`}>
        <div className="flex flex-col lg:flex-row lg:items-end gap-5">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold uppercase tracking-wider text-brand-mute">Net worth</div>
            <div className="mt-1 font-display font-bold tabular-nums leading-none text-4xl sm:text-5xl">
              {fmtIndian(totals.netWorth, 2)}
            </div>
            <div className="mt-1.5 text-sm text-brand-mute tabular-nums">₹{fmtMoney(totals.netWorth, 0)}</div>
            <div className="mt-3 text-sm">
              {delta ? (
                <span className={`font-semibold ${up ? "text-teal-700" : "text-rose-700"}`}>
                  {up ? "↑" : "↓"} ₹{fmtMoney(Math.abs(delta.abs), 0)} this month
                  {delta.pct !== null && <> · {delta.pct >= 0 ? "+" : ""}{delta.pct.toFixed(1)}%</>}
                  {baselineLabel && <span className="text-brand-mute font-normal"> since the {baselineLabel} snapshot</span>}
                </span>
              ) : snapshotCount === 0 ? (
                <span className="text-brand-mute">
                  Take your first snapshot to start tracking direction and rate of change.
                </span>
              ) : (
                <span className="text-brand-mute">Snapshotted this month — the change shows once last month exists.</span>
              )}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 max-w-md">
              <Mini label="Equity" value={totals.equity} to="/journal#portfolio" />
              <Mini label="Other assets" value={totals.assets} />
              <Mini label="Liabilities" value={-totals.liabilities} negative />
            </div>
          </div>
          <div className="lg:w-[40%] w-full">
            {trend.length >= 2 ? (
              <>
                <AreaChart points={trend} height={120} compact />
                <div className="flex justify-between text-[10px] text-brand-mute mt-1">
                  <span>{trend[0]?.label}</span><span>{trend[trend.length - 1]?.label} (live)</span>
                </div>
              </>
            ) : (
              <div className="h-[120px] grid place-items-center rounded-xl bg-brand-soft/60 ring-1 ring-brand-border/60 text-[12px] text-brand-mute text-center px-4">
                {snapshotCount === 0
                  ? "The trend draws itself from monthly snapshots."
                  : "One snapshot so far — the line appears next month."}
              </div>
            )}
            <OwnerOnly>
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={onTakeSnapshot} disabled={snapshotBusy || empty}
                        className="px-3.5 py-1.5 rounded-lg bg-teal-700 text-white text-xs font-semibold
                                   hover:bg-teal-800 disabled:opacity-50 shadow-card">
                  {snapshotBusy ? "Saving…" : "📸 Take snapshot"}
                </button>
              </div>
            </OwnerOnly>
          </div>
        </div>
      </section>

      {empty && (
        <SectionCard title="Getting started">
          <p className="text-sm text-brand-mute">
            Your equity comes from open trades in the <Link to="/journal" className="text-brand-accent font-semibold hover:underline">Trading Journal</Link>.
            Add cash, FDs, mutual funds and loans in the Assets and Liabilities tabs, and the dashboard fills in.
          </p>
        </SectionCard>
      )}

      {/* ---- Insights ---- */}
      {insights.length > 0 && (
        <SectionCard title="Insights">
          <ul className="grid gap-2 sm:grid-cols-2">
            {insights.map((ins, i) => (
              <li key={i} className={`flex items-start gap-2 px-3 py-2 rounded-xl ring-1 text-[13px] leading-snug ${TONE_CLS[ins.tone]}`}>
                <span aria-hidden className="text-base leading-none mt-0.5">{ins.icon}</span>
                <span>{ins.text}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* ---- Allocation + gauges ---- */}
      <div className="grid gap-4 lg:grid-cols-5">
        <SectionCard title="Where the wealth sits" className="lg:col-span-3">
          {alloc.length ? (
            <div className="flex flex-col sm:flex-row items-center gap-5">
              <Donut slices={alloc.map((a) => ({ label: a.label, value: a.value, color: colorFor(a.key) }))}
                     centerTop={fmtIndian(totals.totalAssets, 1)} centerBottom="total assets" />
              <div className="flex-1 w-full space-y-2.5 min-w-0">
                {alloc.map((a) => (
                  <BarRow key={a.key} label={a.label} value={a.value} max={alloc[0]?.value ?? 1}
                          share={a.pct / 100} delta={null} color={colorFor(a.key)} />
                ))}
              </div>
            </div>
          ) : <NoData>No assets yet.</NoData>}
        </SectionCard>

        <div className="lg:col-span-2 space-y-4">
          <SectionCard title="Emergency runway">
            {runway.months !== null && runway.state ? (
              <>
                <div className={`text-3xl font-display font-semibold tabular-nums ${RUNWAY_CLS[runway.state]}`}>
                  {runway.months.toFixed(1)} <span className="text-base font-sans font-medium">months</span>
                </div>
                <div className="mt-1.5 h-2 rounded-full bg-brand-soft ring-1 ring-brand-border/50 overflow-hidden flex">
                  <div className="bg-rose-400 h-full" style={{ width: "25%" }} />
                  <div className="bg-amber-400 h-full" style={{ width: "25%" }} />
                  <div className="bg-teal-500 h-full flex-1" />
                </div>
                <div className="relative h-3">
                  <span className="absolute -top-[9px] w-3 h-3 rounded-full bg-white ring-2 ring-brand-text"
                        style={{ left: `calc(${Math.min(100, (runway.months / 12) * 100)}% - 6px)` }} />
                </div>
                <p className="text-[11px] text-brand-mute">
                  ₹{fmtMoney(liquid, 0)} in Cash + FD ÷ ₹{fmtMoney(burn.avg, 0)}/month
                  ({burn.months}-month average burn). Under 3 = danger · 3–6 = caution · 6+ = healthy.
                </p>
              </>
            ) : (
              <NoData>
                {!hasExpenses
                  ? <>Needs a completed month in the <Link to="/expenses" className="font-semibold text-brand-accent">Expense Tracker</Link> for the burn rate.</>
                  : liquid === 0 ? "Add a Cash or FD asset — those count as liquid." : "Not enough data yet."}
              </NoData>
            )}
          </SectionCard>

          <SectionCard title="Savings rate">
            {current?.rate !== null && current ? (
              <>
                <div className={`text-3xl font-display font-semibold tabular-nums ${
                  current.rate >= 30 ? "text-teal-700" : current.rate >= 0 ? "text-brand-text" : "text-rose-700"}`}>
                  {current.rate.toFixed(0)}%
                </div>
                <p className="text-[11px] text-brand-mute mt-1">
                  {monthLabel(current.key, true)}: ₹{fmtMoney(current.income ?? 0, 0)} in, ₹{fmtMoney(current.expenses, 0)} out
                  {avgRate3.avg !== null && avgRate3.months >= 2 && <> · {avgRate3.months}-month average {avgRate3.avg.toFixed(0)}%</>}
                </p>
              </>
            ) : (
              <NoData>Enter this month&apos;s income in the Goals tab to see your savings rate.</NoData>
            )}
          </SectionCard>

          <SectionCard title="Portfolio XIRR">
            {xirr.rate !== null ? (
              <>
                <div className={`text-3xl font-display font-semibold tabular-nums ${xirr.rate >= 0 ? "text-teal-700" : "text-rose-700"}`}>
                  {xirr.rate >= 0 ? "+" : ""}{fmtPct(xirr.rate, 1)}
                </div>
                <p className="text-[11px] text-brand-mute mt-1">
                  Money-weighted annual return of your journal — every buy and sell dated, open lots at today&apos;s
                  value, over {xirr.spanDays} days.
                </p>
              </>
            ) : <NoData>{xirr.reason}</NoData>}
          </SectionCard>
        </div>
      </div>

      {/* ---- Health ---- */}
      {health.length > 0 && (
        <SectionCard title="Concentration & diversification"
                     right={<span className="text-[10px] text-brand-mute">observations, not rules</span>}>
          <ul className="grid gap-2 sm:grid-cols-2">
            {health.map((h, i) => (
              <li key={i} className={`px-3 py-2 rounded-xl ring-1 text-[13px] ${TONE_CLS[h.tone]}`}>
                {h.tone === "warn" ? "⚠ " : h.tone === "good" ? "✓ " : "◦ "}{h.text}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}

function Mini({ label, value, to, negative = false }: {
  label: string; value: number; to?: string; negative?: boolean;
}) {
  const body = (
    <>
      <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">{label}</div>
      <div className={`text-sm font-display font-semibold tabular-nums ${negative && value !== 0 ? "text-rose-700" : ""}`}>
        {negative && value !== 0 ? "−" : ""}{fmtIndian(Math.abs(value), 1)}
      </div>
    </>
  );
  const cls = "rounded-xl bg-brand-panel/70 ring-1 ring-brand-border/60 px-3 py-2 text-left min-w-0";
  return to ? <Link to={to} className={`${cls} hover:ring-teal-300 block`}>{body}</Link> : <div className={cls}>{body}</div>;
}
