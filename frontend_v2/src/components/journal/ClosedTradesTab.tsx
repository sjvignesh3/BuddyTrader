// -----------------------------------------------------------------------------
// Closed trades tab — booked history with realized P&L and annualized return.
// -----------------------------------------------------------------------------
import { useMemo } from "react";
import type { Trade } from "../../lib/journalApi";
import { deriveClosedTrade, num, type ClosedDerived } from "../../lib/journal";
import { fmtDate, fmtMoney, fmtPct } from "../../lib/money";
import { EmptyState, Pnl, RowBtn, TableShell, Td, Th, useSort } from "./ui";

type Item = { t: Trade; d: ClosedDerived };

const ACCESSORS: Record<string, (x: Item) => unknown> = {
  status: (x) => x.t.close_label,
  type: (x) => x.t.order_type,
  date: (x) => x.t.buy_date,
  symbol: (x) => x.t.symbol,
  buy: (x) => num(x.t.buy_price),
  qty: (x) => x.t.qty,
  strategy: (x) => x.t.strategy,
  target: (x) => num(x.t.target_price),
  sellDate: (x) => x.t.sell_date,
  sell: (x) => num(x.t.sell_price),
  buyValue: (x) => x.d.buyValue,
  sellValue: (x) => x.d.sellValue,
  gain: (x) => x.d.gain,
  days: (x) => x.d.days,
  gainPct: (x) => x.d.gainPct,
  annual: (x) => x.d.annualPct,
};

export default function ClosedTradesTab({ rows, onEdit, onDelete }: {
  rows: Trade[];
  onEdit: (t: Trade) => void;
  onDelete: (t: Trade) => void;
}) {
  const { sort, toggle, apply } = useSort<Item>(ACCESSORS);
  const derived = useMemo(
    () => rows.map((t) => ({ t, d: deriveClosedTrade(t) })), [rows]);
  if (!rows.length) {
    return <EmptyState text="No closed trades yet — book an open trade to see it here." />;
  }
  const totalGain = derived.reduce((s, x) => s + (x.d.gain ?? 0), 0);
  const totalBuy = derived.reduce((s, x) => s + x.d.buyValue, 0);
  const avgRoi = derived.length
    ? derived.reduce((s, x) => s + (x.d.annualPct ?? 0), 0) / derived.length : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Stat label="Realized profit"><Pnl value={totalGain} digits={0} /></Stat>
        <Stat label="On invested">
          <Pnl value={totalBuy ? (totalGain / totalBuy) * 100 : null} suffix="%" />
        </Stat>
        <Stat label="Avg annualized"><Pnl value={avgRoi} suffix="%" digits={1} /></Stat>
        <Stat label="Trades"><span className="tabular-nums">{rows.length}</span></Stat>
      </div>
      <TableShell>
        <thead>
          <tr className="bg-brand-soft">
            <Th sortKey="status" sort={sort} onSort={toggle}>Status</Th>
            <Th sortKey="type" sort={sort} onSort={toggle}>Type</Th>
            <Th sortKey="date" sort={sort} onSort={toggle}>Buy date</Th>
            <Th sortKey="symbol" sort={sort} onSort={toggle}>Stock</Th>
            <Th right sortKey="buy" sort={sort} onSort={toggle}>Buy ₹</Th>
            <Th right sortKey="qty" sort={sort} onSort={toggle}>Qty</Th>
            <Th sortKey="strategy" sort={sort} onSort={toggle}>Strategy</Th>
            <Th right sortKey="target" sort={sort} onSort={toggle}>Target ₹</Th>
            <Th sortKey="sellDate" sort={sort} onSort={toggle}>Sell date</Th>
            <Th right sortKey="sell" sort={sort} onSort={toggle}>Sell ₹</Th>
            <Th right sortKey="buyValue" sort={sort} onSort={toggle}>Buy value</Th>
            <Th right sortKey="sellValue" sort={sort} onSort={toggle}>Sell value</Th>
            <Th right sortKey="gain" sort={sort} onSort={toggle}>Gain ₹</Th>
            <Th right sortKey="days" sort={sort} onSort={toggle}>Days</Th>
            <Th right sortKey="gainPct" sort={sort} onSort={toggle}>Gain %</Th>
            <Th right sortKey="annual" sort={sort} onSort={toggle}>Annual %</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {apply(derived).map(({ t, d }) => (
            <tr key={t.id} className="border-t border-brand-border/60 hover:bg-brand-soft/60">
              <Td>
                <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold
                                 ring-1 bg-teal-50 text-teal-800 ring-teal-300">
                  {t.close_label ?? "Fully Booked"}
                </span>
              </Td>
              <Td className="text-brand-mute">{t.order_type ?? "—"}</Td>
              <Td>{fmtDate(t.buy_date)}</Td>
              <Td className="font-semibold">{t.symbol}</Td>
              <Td right>{fmtMoney(t.buy_price)}</Td>
              <Td right>{t.qty}</Td>
              <Td>{t.strategy ?? "—"}</Td>
              <Td right>{fmtMoney(t.target_price)}</Td>
              <Td>{fmtDate(t.sell_date)}</Td>
              <Td right>{fmtMoney(t.sell_price)}</Td>
              <Td right>{fmtMoney(d.buyValue, 0)}</Td>
              <Td right>{fmtMoney(d.sellValue, 0)}</Td>
              <Td right><Pnl value={d.gain} digits={0} /></Td>
              <Td right>{d.days ?? "—"}</Td>
              <Td right><Pnl value={d.gainPct} suffix="%" /></Td>
              <Td right><Pnl value={d.annualPct} suffix="%" digits={1} /></Td>
              <Td>
                <span className="inline-flex gap-0.5">
                  <RowBtn title="Edit" onClick={() => onEdit(t)}>✎</RowBtn>
                  <RowBtn title="Delete" danger onClick={() => onDelete(t)}>🗑</RowBtn>
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-2.5 rounded-xl bg-brand-panel ring-1 ring-brand-border shadow-card">
      <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">{label}</div>
      <div className="text-sm font-semibold mt-0.5">{children}</div>
    </div>
  );
}
