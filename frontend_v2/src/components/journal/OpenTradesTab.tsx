// -----------------------------------------------------------------------------
// Open trades tab — live positions with capital-based allocation markers.
// Every column header sorts.
// -----------------------------------------------------------------------------
import { useMemo } from "react";
import type { Trade } from "../../lib/journalApi";
import type { JournalCtx, OpenDerived } from "../../lib/journal";
import { deriveOpenTrade, num } from "../../lib/journal";
import { fmtDate, fmtMoney, fmtPct } from "../../lib/money";
import {
  AllocMarker, CapChip, EmptyState, Pnl, RowBtn, TableShell, Td, Th, useSort,
} from "./ui";

type Item = { t: Trade; d: OpenDerived };

const ACCESSORS: Record<string, (x: Item) => unknown> = {
  type: (x) => x.t.order_type,
  cap: (x) => x.d.cap,
  date: (x) => x.t.buy_date,
  symbol: (x) => x.t.symbol,
  buy: (x) => num(x.t.buy_price),
  qty: (x) => x.t.qty,
  strategy: (x) => x.t.strategy,
  target: (x) => num(x.t.target_price),
  buyValue: (x) => x.d.buyValue,
  alloc: (x) => x.d.allocPct,
  stockAlloc: (x) => x.d.symbolAllocPct,
  cmp: (x) => x.d.cmp,
  curValue: (x) => x.d.currentValue,
  gainAmt: (x) => x.d.gainAmt,
  gainPct: (x) => x.d.gainPct,
  day: (x) => x.d.dayPct,
  toTarget: (x) => x.d.remainingPct,
  ath: (x) => x.d.athFallPct,
  days: (x) => x.d.days,
  annual: (x) => x.d.annualPct,
};

export default function OpenTradesTab({ rows, ctx, onEdit, onBook, onDelete }: {
  rows: Trade[];
  ctx: JournalCtx;
  onEdit: (t: Trade) => void;
  onBook: (t: Trade) => void;
  onDelete: (t: Trade) => void;
}) {
  const { sort, toggle, apply } = useSort<Item>(ACCESSORS);
  const items = useMemo(
    () => rows.map((t) => ({ t, d: deriveOpenTrade(t, ctx) })),
    [rows, ctx]);

  if (!rows.length) {
    return <EmptyState text="No open trades — convert an opportunity or import your sheet." />;
  }
  const s = { sort, onSort: toggle };
  return (
    <TableShell>
      <thead>
        <tr className="bg-brand-soft">
          <Th sortKey="type" {...s}>Type</Th>
          <Th sortKey="cap" {...s}>Cap</Th>
          <Th sortKey="date" {...s}>Buy date</Th>
          <Th sortKey="symbol" {...s}>Stock</Th>
          <Th right sortKey="buy" {...s}>Buy ₹</Th>
          <Th right sortKey="qty" {...s}>Qty</Th>
          <Th sortKey="strategy" {...s}>Strategy</Th>
          <Th right sortKey="target" {...s}>Target ₹</Th>
          <Th right sortKey="buyValue" {...s}>Buy value</Th>
          <Th right sortKey="alloc" {...s}>Alloc %</Th>
          <Th right sortKey="stockAlloc" {...s}>Stock %</Th>
          <Th right sortKey="cmp" {...s}>CMP</Th>
          <Th right sortKey="curValue" {...s}>Cur. value</Th>
          <Th right sortKey="gainAmt" {...s}>Gain ₹</Th>
          <Th right sortKey="gainPct" {...s}>Gain %</Th>
          <Th right sortKey="day" {...s}>Day %</Th>
          <Th right sortKey="toTarget" {...s}>To target</Th>
          <Th right sortKey="ath" {...s}>ATH ↓</Th>
          <Th right sortKey="days" {...s}>Days</Th>
          <Th right sortKey="annual" {...s}>Annual %</Th>
          <Th>Notes</Th><Th />
        </tr>
      </thead>
      <tbody>
        {apply(items).map(({ t, d }) => {
          const note = [t.comments, t.risk_notes].filter(Boolean).join(" · ");
          return (
            <tr key={t.id} className="border-t border-brand-border/60 hover:bg-brand-soft/60">
              <Td className="text-brand-mute">{t.order_type ?? "—"}</Td>
              <Td><CapChip cap={d.cap} /></Td>
              <Td>{fmtDate(t.buy_date)}</Td>
              <Td className="font-semibold">{t.symbol}</Td>
              <Td right>{fmtMoney(t.buy_price)}</Td>
              <Td right>{t.qty}</Td>
              <Td>{t.strategy ?? "—"}</Td>
              <Td right>{fmtMoney(t.target_price)}</Td>
              <Td right>{fmtMoney(d.buyValue, 0)}</Td>
              <Td right className="text-brand-mute">{fmtPct(d.allocPct)}</Td>
              <Td right>
                <span className="inline-flex items-center gap-1.5">
                  {fmtPct(d.symbolAllocPct)}
                  <AllocMarker state={d.marker} cap={d.cap} totalPct={d.symbolAllocPct} />
                </span>
              </Td>
              <Td right>{fmtMoney(d.cmp)}</Td>
              <Td right>{fmtMoney(d.currentValue, 0)}</Td>
              <Td right><Pnl value={d.gainAmt} digits={0} /></Td>
              <Td right><Pnl value={d.gainPct} suffix="%" /></Td>
              <Td right><Pnl value={d.dayPct} suffix="%" /></Td>
              <Td right className="text-teal-800">{fmtPct(d.remainingPct)}</Td>
              <Td right className="text-brand-mute">{fmtPct(d.athFallPct)}</Td>
              <Td right>{d.days ?? "—"}</Td>
              <Td right><Pnl value={d.annualPct} suffix="%" digits={1} /></Td>
              <Td className="max-w-[160px] truncate text-brand-mute">
                <span title={note}>{note}</span>
              </Td>
              <Td>
                <span className="inline-flex gap-0.5">
                  <RowBtn title="Book (sell fully or partially)" onClick={() => onBook(t)}>💰</RowBtn>
                  <RowBtn title="Edit" onClick={() => onEdit(t)}>✎</RowBtn>
                  <RowBtn title="Delete" danger onClick={() => onDelete(t)}>🗑</RowBtn>
                </span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </TableShell>
  );
}
