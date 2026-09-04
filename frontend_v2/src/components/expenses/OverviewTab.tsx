// -----------------------------------------------------------------------------
// Overview — the monthly dashboard. Answers, top to bottom: how much did I
// spend, is that normal for me, where did it go, what changed, and what
// should I pay attention to. All numbers derive from lib/expenses.ts.
// -----------------------------------------------------------------------------
import { useMemo } from "react";
import type { CategoryMaps, MonthStats } from "../../lib/expenses";
import {
  addMonths, buildInsights, elapsedDays, monthLabel, num, statsFor,
  thisMonthKey, todayIso, trailingAverage,
} from "../../lib/expenses";
import { fmtMoney } from "../../lib/money";
import type { Budget, Recurring } from "../../lib/expensesApi";
import {
  BarRow, BudgetBar, CalendarHeatmap, DailyBars, DeltaNote, Donut,
  MonthlyTrend, SectionCard, StatCard, colorForRoot,
} from "./ui";

interface Props {
  monthly: Map<string, MonthStats>;
  maps: CategoryMaps;
  monthSel: string;
  onSelectMonth: (key: string) => void;
  budgets: Budget[];
  recurring: Recurring[];
  onDrillCategory: (rootId: number) => void;
}

const TONE_CLS = {
  warn: "bg-rose-50 ring-rose-200 text-rose-900",
  info: "bg-sky-50 ring-sky-200 text-sky-900",
  good: "bg-teal-50 ring-teal-200 text-teal-900",
} as const;

export default function OverviewTab({
  monthly, maps, monthSel, onSelectMonth, budgets, recurring, onDrillCategory,
}: Props) {
  const cur = statsFor(monthly, monthSel);
  const prev = statsFor(monthly, addMonths(monthSel, -1));
  const t3 = trailingAverage(monthly, monthSel, 3);
  const t6 = trailingAverage(monthly, monthSel, 6);
  const days = elapsedDays(monthSel);
  const dailyAvg = days > 0 ? cur.total / days : 0;

  const insights = useMemo(
    () => buildInsights({ monthKeySel: monthSel, monthly, maps, budgets, recurring }),
    [monthSel, monthly, maps, budgets, recurring]);

  // Category breakdown rows (roots, desc), with MoM delta per root.
  const rootRows = useMemo(() => {
    const rows = [...cur.byRoot.entries()]
      .map(([id, total]) => {
        const root = id === 0 ? null : maps.byId.get(id) ?? null;
        const prevV = prev.byRoot.get(id) ?? 0;
        return {
          id,
          name: root?.name ?? "Uncategorised",
          icon: root?.icon ?? null,
          total,
          delta: prevV > 0 ? ((total - prevV) / prevV) * 100 : null,
          color: colorForRoot(id, maps),
        };
      })
      .sort((a, b) => b.total - a.total);
    return rows;
  }, [cur, prev, maps]);

  const maxRoot = rootRows[0]?.total ?? 0;

  // Highest-spend day of the selected month.
  const highestDay = useMemo(() => {
    let best: { iso: string; total: number } | null = null;
    cur.byDay.forEach((total, iso) => {
      if (!best || total > best.total) best = { iso, total };
    });
    return best as { iso: string; total: number } | null;
  }, [cur]);

  // 12-month trend feeding the clickable month bar.
  const trend = useMemo(() => {
    const anchor = thisMonthKey() > monthSel ? thisMonthKey() : monthSel;
    return Array.from({ length: 12 }, (_, i) => {
      const key = addMonths(anchor, i - 11);
      return { key, label: monthLabel(key, true), total: statsFor(monthly, key).total };
    });
  }, [monthly, monthSel]);

  // Category trends: top roots over the last 4 months.
  const catTrend = useMemo(() => {
    const months = Array.from({ length: 4 }, (_, i) => addMonths(monthSel, i - 3));
    const tops = rootRows.slice(0, 5);
    return { months, rows: tops.map((r) => ({
      ...r,
      values: months.map((mk) => statsFor(monthly, mk).byRoot.get(r.id) ?? 0),
    })) };
  }, [monthly, monthSel, rootRows]);

  const budgetRows = useMemo(() => budgets
    .map((b) => {
      const limit = num(b.monthly_amount);
      const spent = b.category_id === null
        ? cur.total
        : cur.byRoot.get(b.category_id) ?? cur.bySub.get(b.category_id)?.total ?? 0;
      const name = b.category_id === null
        ? "Overall" : maps.byId.get(b.category_id)?.name ?? "Category";
      return { id: b.id, name, spent, limit };
    })
    .sort((a, b) => b.spent / b.limit - a.spent / a.limit), [budgets, cur, maps]);

  const nwTotal = cur.needs + cur.wants + cur.unclassified;

  if (cur.txCount === 0 && cur.excludedTotal === 0) {
    return (
      <div>
        <MonthTrendCard trend={trend} monthSel={monthSel} onSelectMonth={onSelectMonth} />
        <div className="mt-4 rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card
                        p-10 text-center">
          <div className="text-3xl mb-2">🪙</div>
          <p className="text-sm text-brand-mute">
            Nothing logged for {monthLabel(monthSel)} yet — add your first expense above,
            or import your Google Sheet from the Transactions tab.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ---- Top: how much, and is that normal ---- */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <StatCard big label={`${monthLabel(monthSel)} spending`}
                  value={`₹${fmtMoney(cur.total, 0)}`}>
          <div className="flex flex-col gap-0.5">
            <DeltaNote current={cur.total} baseline={prev.total > 0 ? prev.total : null}
                       label={monthLabel(prev.key, true)} />
            {t3.months >= 2 && (
              <DeltaNote current={cur.total} baseline={t3.avg}
                         label={`${t3.months}-mo avg`} />
            )}
          </div>
        </StatCard>
        <StatCard label="Daily average" value={`₹${fmtMoney(dailyAvg, 0)}`}>
          <span className="text-[11px] text-brand-mute">
            across {days} day{days === 1 ? "" : "s"}
            {t6.months >= 3 && ` · 6-mo ₹${fmtMoney(t6.avg, 0)}/mo`}
          </span>
        </StatCard>
        <StatCard label="Transactions" value={cur.txCount}>
          <span className="text-[11px] text-brand-mute">
            avg ₹{fmtMoney(cur.txCount ? cur.total / cur.txCount : 0, 0)} each
          </span>
        </StatCard>
        <StatCard label="Highest day"
                  value={highestDay ? `₹${fmtMoney(highestDay.total, 0)}` : "—"}>
          {highestDay && (
            <span className="text-[11px] text-brand-mute">
              on {monthLabel(monthSel, true)} {Number(highestDay.iso.slice(8, 10))}
            </span>
          )}
        </StatCard>
      </div>

      {/* ---- Insights: what changed, what to watch ---- */}
      {insights.length > 0 && (
        <SectionCard title="Insights">
          <ul className="grid gap-2 sm:grid-cols-2">
            {insights.map((ins, i) => (
              <li key={i}
                  className={`flex items-start gap-2 px-3 py-2 rounded-xl ring-1 text-[13px]
                              leading-snug ${TONE_CLS[ins.tone]}`}>
                <span aria-hidden className="text-base leading-none mt-0.5">{ins.icon}</span>
                <span>{ins.text}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* ---- Middle: where it went ---- */}
      <div className="grid gap-4 lg:grid-cols-5">
        <SectionCard title="Where the money went" className="lg:col-span-3">
          <div className="flex flex-col sm:flex-row items-center gap-5">
            <Donut
              slices={rootRows.map((r) => ({ label: r.name, value: r.total, color: r.color }))}
              centerTop={`₹${fmtMoney(cur.total, 0)}`}
              centerBottom={monthLabel(monthSel, true)}
            />
            <div className="flex-1 w-full space-y-2.5 min-w-0">
              {rootRows.map((r) => (
                <BarRow key={r.id} icon={r.icon} label={r.name} value={r.total}
                        max={maxRoot} share={cur.total > 0 ? r.total / cur.total : 0}
                        delta={r.delta} color={r.color}
                        onClick={() => onDrillCategory(r.id)} />
              ))}
            </div>
          </div>
          {cur.excludedTotal > 0 && (
            <p className="mt-3 text-[11px] text-brand-mute">
              + ₹{fmtMoney(cur.excludedTotal, 0)} in investments & transfers —
              kept out of spending totals.
            </p>
          )}
        </SectionCard>

        <div className="lg:col-span-2 space-y-4">
          <SectionCard title="Needs vs wants">
            {nwTotal > 0 ? (
              <>
                <div className="flex h-3.5 rounded-full overflow-hidden ring-1 ring-brand-border/50">
                  <div className="bg-sky-600" title={`Needs ₹${fmtMoney(cur.needs, 0)}`}
                       style={{ width: `${(cur.needs / nwTotal) * 100}%` }} />
                  <div className="bg-amber-500" title={`Wants ₹${fmtMoney(cur.wants, 0)}`}
                       style={{ width: `${(cur.wants / nwTotal) * 100}%` }} />
                  <div className="bg-stone-300 flex-1"
                       title={`Unclassified ₹${fmtMoney(cur.unclassified, 0)}`} />
                </div>
                <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: "Needs", v: cur.needs, cls: "text-sky-700" },
                    { label: "Wants", v: cur.wants, cls: "text-amber-600" },
                    { label: "Unset", v: cur.unclassified, cls: "text-brand-mute" },
                  ].map((x) => (
                    <div key={x.label}>
                      <div className={`text-sm font-semibold tabular-nums ${x.cls}`}>
                        {((x.v / nwTotal) * 100).toFixed(0)}%
                      </div>
                      <div className="text-[10px] text-brand-mute">
                        {x.label} · ₹{fmtMoney(x.v, 0)}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : <p className="text-sm text-brand-mute">No spending yet.</p>}
          </SectionCard>

          <SectionCard title="Spending calendar">
            <CalendarHeatmap monthKey={monthSel} byDay={cur.byDay} />
          </SectionCard>
        </div>
      </div>

      {/* ---- Bottom: trends & commitments ---- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Daily rhythm"
                     right={<span className="text-[10px] text-brand-mute">
                       <span className="inline-block w-2 h-2 rounded-sm bg-amber-500/80 mr-1" />weekend
                     </span>}>
          <DailyBars monthKey={monthSel} byDay={cur.byDay} highlightToday={todayIso()} />
        </SectionCard>

        <MonthTrendCard trend={trend} monthSel={monthSel} onSelectMonth={onSelectMonth} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {catTrend.rows.length > 0 && (
          <SectionCard title="Category trends (4 months)">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
                  <th className="text-left py-1">Category</th>
                  {catTrend.months.map((mk) => (
                    <th key={mk} className={`text-right py-1 ${
                      mk === monthSel ? "text-brand-text" : ""}`}>
                      {monthLabel(mk, true)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {catTrend.rows.map((r) => (
                  <tr key={r.id} className="border-t border-brand-border/50">
                    <td className="py-1.5 font-medium">
                      <span aria-hidden className="inline-block w-2 h-2 rounded-full mr-1.5"
                            style={{ backgroundColor: r.color }} />
                      {r.name}
                    </td>
                    {r.values.map((v, i) => (
                      <td key={i} className={`py-1.5 text-right tabular-nums ${
                        i === r.values.length - 1 ? "font-semibold" : "text-brand-mute"}`}>
                        {v > 0 ? `₹${fmtMoney(v, 0)}` : "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </SectionCard>
        )}

        {budgetRows.length > 0 && (
          <SectionCard title={`Budgets — ${monthLabel(monthSel, true)}`}>
            <div className="space-y-3">
              {budgetRows.map((b) => (
                <div key={b.id}>
                  <div className="text-[12px] font-medium mb-1">{b.name}</div>
                  <BudgetBar spent={b.spent} limit={b.limit} />
                </div>
              ))}
            </div>
          </SectionCard>
        )}
      </div>
    </div>
  );
}

function MonthTrendCard({ trend, monthSel, onSelectMonth }: {
  trend: { key: string; label: string; total: number }[];
  monthSel: string;
  onSelectMonth: (key: string) => void;
}) {
  return (
    <SectionCard title="Monthly trend (12 months)"
                 right={<span className="text-[10px] text-brand-mute">click a bar to jump</span>}>
      <MonthlyTrend points={trend} selected={monthSel} onPick={onSelectMonth} />
    </SectionCard>
  );
}
