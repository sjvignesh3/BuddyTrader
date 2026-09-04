// -----------------------------------------------------------------------------
// Opportunities tab — plan list. Manual columns + live fetched columns and
// the capital-allocation marker. Every column header sorts.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import type { Opportunity } from "../../lib/journalApi";
import type { JournalCtx, OppDerived } from "../../lib/journal";
import { deriveOpportunity, num } from "../../lib/journal";
import { fmtDate, fmtMoney, fmtPct } from "../../lib/money";
import FilterBar, { CapFilter, FilterChip } from "./FilterBar";
import {
  AllocMarker, CapChip, EmptyState, GhostBtn, Pnl, RowBtn, TableShell, Td, Th, useSort,
} from "./ui";

const ACTION_STYLES: Record<string, string> = {
  "Buy Now": "bg-teal-700 text-white ring-teal-700",
  GTT: "bg-teal-50 text-teal-800 ring-teal-300",
  "Analyse Now": "bg-amber-50 text-amber-800 ring-amber-300",
  Later: "bg-stone-100 text-stone-500 ring-stone-200",
};

const ACTIONS = ["Buy Now", "GTT", "Analyse Now", "Later"] as const;

const ACTION_ACTIVE: Record<string, string> = {
  "Buy Now": "bg-teal-700 text-white ring-teal-700",
  GTT: "bg-teal-600 text-white ring-teal-600",
  "Analyse Now": "bg-amber-500 text-white ring-amber-500",
  Later: "bg-stone-500 text-white ring-stone-500",
};

type Item = { o: Opportunity; d: OppDerived };

const ACCESSORS: Record<string, (x: Item) => unknown> = {
  date: (x) => x.o.opp_date,
  symbol: (x) => x.o.symbol,
  cap: (x) => x.d.cap,
  buy: (x) => num(x.o.buy_price),
  limit: (x) => num(x.o.limit_price),
  qty: (x) => x.o.qty,
  strategy: (x) => x.o.strategy,
  target: (x) => num(x.o.target_price),
  action: (x) => x.o.action_filter,
  ltp: (x) => x.d.ltp,
  day: (x) => x.d.dayPct,
  ath: (x) => x.d.athFallPct,
  potential: (x) => x.d.potentialPct,
  gain: (x) => x.d.potentialGain,
  trig: (x) => x.d.toTrigPct,
  curr: (x) => x.d.currentPct,
  add: (x) => x.d.additionPct,
  total: (x) => x.d.totalPct,
};

export default function OpportunitiesTab({ rows, ctx, onEdit, onConvert, onDelete }: {
  rows: Opportunity[];
  ctx: JournalCtx;
  onEdit: (o: Opportunity) => void;
  onConvert: (o: Opportunity) => void;
  onDelete: (o: Opportunity) => void;
}) {
  const { sort, toggle, apply } = useSort<Item>(ACCESSORS);
  const [search, setSearch] = useState("");
  const [cap, setCap] = useState<CapFilter>("All");
  const [action, setAction] = useState<string>("All");

  const items = useMemo(
    () => rows.map((o) => ({ o, d: deriveOpportunity(o, ctx) })),
    [rows, ctx]);

  const actionCounts = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach(({ o }) => {
      if (o.action_filter) m.set(o.action_filter, (m.get(o.action_filter) ?? 0) + 1);
    });
    return m;
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(({ o, d }) => {
      if (cap !== "All" && d.cap !== cap) return false;
      if (action !== "All" && o.action_filter !== action) return false;
      if (q && ![o.symbol, o.strategy, o.notes, o.action_filter]
        .some((f) => f && f.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, search, cap, action]);

  if (!rows.length) {
    return <EmptyState text="No opportunities yet — add one or import your sheet." />;
  }
  const clearFilters = () => { setSearch(""); setCap("All"); setAction("All"); };
  const s = { sort, onSort: toggle };
  return (
    <div>
      <FilterBar search={search} onSearch={setSearch} cap={cap} onCap={setCap}
                 shown={filtered.length} total={items.length}>
        <div className="flex items-center gap-1">
          {ACTIONS.map((a) => (
            <FilterChip key={a} active={action === a}
                        onClick={() => setAction((prev) => (prev === a ? "All" : a))}
                        activeCls={ACTION_ACTIVE[a]} count={actionCounts.get(a) ?? 0}>
              {a}
            </FilterChip>
          ))}
        </div>
      </FilterBar>
      {!filtered.length ? (
        <EmptyState text="No opportunities match the filters."
                    action={<GhostBtn onClick={clearFilters}>Clear filters</GhostBtn>} />
      ) : (
    <TableShell>
      <thead>
        <tr className="bg-brand-soft">
          <Th sortKey="date" {...s}>Date</Th>
          <Th sortKey="symbol" {...s}>Script</Th>
          <Th sortKey="cap" {...s}>Cap</Th>
          <Th right sortKey="buy" {...s}>Buy ₹</Th>
          <Th right sortKey="limit" {...s}>Limit ₹</Th>
          <Th right sortKey="qty" {...s}>Qty</Th>
          <Th sortKey="strategy" {...s}>Strategy</Th>
          <Th right sortKey="target" {...s}>Target ₹</Th>
          <Th sortKey="action" {...s}>Action</Th>
          <Th right sortKey="ltp" {...s}>LTP</Th>
          <Th right sortKey="day" {...s}>Day %</Th>
          <Th right sortKey="ath" {...s}>ATH ↓</Th>
          <Th right sortKey="potential" {...s}>Potential</Th>
          <Th right sortKey="gain" {...s}>Gain ₹</Th>
          <Th right sortKey="trig" {...s}>To Trig</Th>
          <Th right sortKey="curr" {...s}>Curr %</Th>
          <Th right sortKey="add" {...s}>Add %</Th>
          <Th right sortKey="total" {...s}>Total %</Th>
          <Th>Notes</Th><Th />
        </tr>
      </thead>
      <tbody>
        {apply(filtered).map(({ o, d }) => (
          <tr key={o.id} className="border-t border-brand-border/60 hover:bg-brand-soft/60">
            <Td>{fmtDate(o.opp_date)}</Td>
            <Td className="font-semibold">{o.symbol}</Td>
            <Td><CapChip cap={d.cap} /></Td>
            <Td right>{fmtMoney(o.buy_price)}</Td>
            <Td right>{fmtMoney(o.limit_price)}</Td>
            <Td right>{o.qty ?? "—"}</Td>
            <Td>{o.strategy ?? "—"}</Td>
            <Td right>{fmtMoney(o.target_price)}</Td>
            <Td>
              {o.action_filter ? (
                <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px]
                                  font-semibold ring-1 ${ACTION_STYLES[o.action_filter]}`}>
                  {o.action_filter}
                </span>
              ) : "—"}
            </Td>
            <Td right>{fmtMoney(d.ltp)}</Td>
            <Td right><Pnl value={d.dayPct} suffix="%" /></Td>
            <Td right className="text-brand-mute">{fmtPct(d.athFallPct)}</Td>
            <Td right><Pnl value={d.potentialPct} suffix="%" /></Td>
            <Td right>{fmtMoney(d.potentialGain, 0)}</Td>
            <Td right>{fmtPct(d.toTrigPct)}</Td>
            <Td right className="text-brand-mute">{fmtPct(d.currentPct)}</Td>
            <Td right>{fmtPct(d.additionPct)}</Td>
            <Td right>
              <span className="inline-flex items-center gap-1.5">
                {fmtPct(d.totalPct)}
                <AllocMarker state={d.marker} cap={d.cap} totalPct={d.totalPct} />
              </span>
            </Td>
            <Td className="max-w-[180px] truncate text-brand-mute">
              <span title={o.notes ?? ""}>{o.notes ?? ""}</span>
            </Td>
            <Td>
              <span className="inline-flex gap-0.5">
                <RowBtn title="Take position (convert to open trade)"
                        onClick={() => onConvert(o)}>🛒</RowBtn>
                <RowBtn title="Edit" onClick={() => onEdit(o)}>✎</RowBtn>
                <RowBtn title="Delete" danger onClick={() => onDelete(o)}>🗑</RowBtn>
              </span>
            </Td>
          </tr>
        ))}
      </tbody>
    </TableShell>
      )}
    </div>
  );
}
