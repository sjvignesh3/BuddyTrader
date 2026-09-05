// -----------------------------------------------------------------------------
// History — the monthly snapshot record: trend chart, savings-rate bars plotted
// alongside, and the snapshot table with month-over-month change.
// -----------------------------------------------------------------------------
import { monthLabel } from "../../lib/expenses";
import { fmtDate, fmtMoney } from "../../lib/money";
import { num, sortSnapshots, type SavingsPoint } from "../../lib/networth";
import type { NetWorthSnapshot } from "../../lib/networthApi";
import { SectionCard } from "../expenses/ui";
import { EmptyState, Pnl, PrimaryBtn, RowBtn, TableShell, Td, Th } from "../journal/ui";
import { AreaChart, NoData, type TrendPoint } from "./ui";

export default function HistoryTab({ snapshots, trend, savings, onTakeSnapshot, snapshotBusy, onDelete }: {
  snapshots: NetWorthSnapshot[];
  trend: TrendPoint[];
  savings: SavingsPoint[];
  onTakeSnapshot: () => void;
  snapshotBusy: boolean;
  onDelete: (s: NetWorthSnapshot) => void;
}) {
  const sorted = sortSnapshots(snapshots);
  const newestFirst = [...sorted].reverse();
  const rated = savings.filter((p) => p.rate !== null);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Net worth over time" className="lg:col-span-2"
                     right={<span className="text-[10px] text-brand-mute">hollow point = live, not yet snapshotted</span>}>
          {trend.length >= 2 ? <AreaChart points={trend} height={200} />
            : <NoData>The chart needs at least one past snapshot. Take one now and the line starts next month.</NoData>}
        </SectionCard>
        <SectionCard title="Savings rate by month">
          {rated.length ? (
            <div className="flex items-end gap-1.5 h-40 w-full">
              {savings.slice(-12).map((p) => (
                <div key={p.key} title={p.rate === null ? `${monthLabel(p.key)}: no income entered`
                                          : `${monthLabel(p.key)}: ${p.rate.toFixed(0)}% saved`}
                     className="flex-1 h-full flex flex-col justify-end items-center gap-1">
                  {p.rate !== null && (
                    <span className="text-[9px] tabular-nums font-semibold text-brand-mute">{p.rate.toFixed(0)}%</span>
                  )}
                  <div className={`w-full rounded-t ${p.rate === null ? "bg-brand-soft" : p.rate < 0 ? "bg-rose-400" : "bg-teal-600/70"}`}
                       style={{ height: p.rate === null ? "3px" : `${Math.max(4, Math.min(100, Math.abs(p.rate)))}%` }} />
                  <span className="text-[9px] text-brand-mute">{monthLabel(p.key, true)}</span>
                </div>
              ))}
            </div>
          ) : <NoData>Enter monthly income in the Goals tab to plot your savings rate against the trend.</NoData>}
        </SectionCard>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-brand-mute">
          {snapshots.length} monthly snapshot{snapshots.length === 1 ? "" : "s"} — each is the position as it stood;
          re-taking one in the same month replaces it.
        </div>
        <PrimaryBtn onClick={onTakeSnapshot} disabled={snapshotBusy}>
          {snapshotBusy ? "Saving…" : "📸 Take snapshot"}
        </PrimaryBtn>
      </div>

      {!snapshots.length ? (
        <EmptyState text="No snapshots yet. Take one at each month-end to build the history behind trends, ETAs and insights." />
      ) : (
        <TableShell>
          <thead>
            <tr className="bg-brand-soft">
              <Th>Month</Th><Th right>Equity</Th><Th right>Other assets</Th>
              <Th right>Liabilities</Th><Th right>Net worth</Th><Th right>Change</Th>
              <Th>Taken</Th><Th />
            </tr>
          </thead>
          <tbody>
            {newestFirst.map((s, i) => {
              const prev = newestFirst[i + 1];
              const d = prev ? num(s.net_worth) - num(prev.net_worth) : null;
              const pct = prev && num(prev.net_worth) !== 0 ? (d! / Math.abs(num(prev.net_worth))) * 100 : null;
              return (
                <tr key={s.id} className="border-t border-brand-border/60 hover:bg-brand-soft/60">
                  <Td className="font-semibold">{monthLabel(s.snapshot_date.slice(0, 7))}</Td>
                  <Td right>{fmtMoney(s.equity_value, 0)}</Td>
                  <Td right>{fmtMoney(s.assets_value, 0)}</Td>
                  <Td right className="text-rose-700">{num(s.liabilities_value) ? `−${fmtMoney(s.liabilities_value, 0)}` : "—"}</Td>
                  <Td right className="font-semibold">{fmtMoney(s.net_worth, 0)}</Td>
                  <Td right>
                    {d === null ? <span className="text-brand-mute">—</span> : (
                      <span className="inline-flex flex-col items-end leading-tight">
                        <Pnl value={d} digits={0} />
                        {pct !== null && <span className="text-[10px]"><Pnl value={pct} suffix="%" digits={1} /></span>}
                      </span>
                    )}
                  </Td>
                  <Td className="text-brand-mute">{fmtDate(s.created_at)}</Td>
                  <Td><RowBtn title="Delete snapshot" danger onClick={() => onDelete(s)}>🗑</RowBtn></Td>
                </tr>
              );
            })}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}
