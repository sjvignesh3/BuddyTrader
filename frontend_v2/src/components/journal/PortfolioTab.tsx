// -----------------------------------------------------------------------------
// Portfolio tab — capital, deployment, cap-bucket mix vs limits, holdings.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import type { Trade } from "../../lib/journalApi";
import type { HoldingRow, JournalCtx } from "../../lib/journal";
import { buildPortfolio, deriveClosedTrade, CAP_LIMITS } from "../../lib/journal";
import { fmtMoney, fmtPct } from "../../lib/money";
import FilterBar, { CapFilter } from "./FilterBar";
import {
  AllocMarker, CapChip, EmptyState, GhostBtn, Pnl, TableShell, Td, Th, useSort,
} from "./ui";

const ACCESSORS: Record<string, (h: HoldingRow) => unknown> = {
  symbol: (h) => h.symbol,
  cap: (h) => h.cap,
  qty: (h) => h.qty,
  lots: (h) => h.lots,
  invested: (h) => h.invested,
  alloc: (h) => h.allocPct,
  curValue: (h) => h.currentValue,
  pnl: (h) => h.pnl,
  pnlPct: (h) => h.pnlPct,
};

export default function PortfolioTab({ openTrades, closedTrades, ctx }: {
  openTrades: Trade[];
  closedTrades: Trade[];
  ctx: JournalCtx;
}) {
  const { holdings, capSummary, totals } = buildPortfolio(openTrades, ctx);
  const { sort, toggle, apply } = useSort<HoldingRow>(ACCESSORS);
  const [search, setSearch] = useState("");
  const [cap, setCap] = useState<CapFilter>("All");
  const realized = closedTrades.reduce(
    (s, t) => s + (deriveClosedTrade(t).gain ?? 0), 0);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return holdings.filter((h) => {
      if (cap !== "All" && h.cap !== cap) return false;
      if (q && !h.symbol.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [holdings, search, cap]);

  if (!holdings.length) {
    return <EmptyState text="No open positions — the portfolio builds itself from open trades." />;
  }
  const clearFilters = () => { setSearch(""); setCap("All"); };

  return (
    <div className="space-y-4">
      {/* Headline stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Big label="Capital" value={`₹${fmtMoney(ctx.capital, 0)}`} />
        <Big label="Invested" value={`₹${fmtMoney(totals.invested, 0)}`}
             sub={`${fmtPct(totals.deployedPct)} deployed`} />
        <Big label="Current value" value={`₹${fmtMoney(totals.currentValue, 0)}`} />
        <Big label="Unrealized P&L" value={<Pnl value={totals.pnl} digits={0} />}
             sub={<Pnl value={totals.invested ? (totals.pnl / totals.invested) * 100 : null}
                       suffix="%" />} />
        <Big label="Realized profit" value={<Pnl value={realized} digits={0} />} />
        <Big label="Holdings" value={String(holdings.length)}
             sub={`${openTrades.length} open lots`} />
      </div>

      {/* Cap-bucket mix vs per-stock limits */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {capSummary.map((c) => (
          <div key={c.cap}
               className="p-3.5 rounded-xl bg-brand-panel ring-1 ring-brand-border shadow-card">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold">{c.cap} cap</span>
              {c.limitPct !== null && (
                <span className="text-[10px] text-brand-mute">
                  per-stock limit {c.limitPct}%
                </span>
              )}
            </div>
            <div className="mt-1.5 text-lg font-display font-semibold tabular-nums">
              ₹{fmtMoney(c.invested, 0)}
            </div>
            <div className="text-[11px] text-brand-mute">
              {c.stocks} stock{c.stocks === 1 ? "" : "s"} · {fmtPct(c.pctOfCapital)} of capital
            </div>
          </div>
        ))}
      </div>

      {/* Holdings */}
      <FilterBar search={search} onSearch={setSearch} cap={cap} onCap={setCap}
                 shown={filtered.length} total={holdings.length}
                 placeholder="Search holdings…" />
      {!filtered.length ? (
        <EmptyState text="No holdings match the filters."
                    action={<GhostBtn onClick={clearFilters}>Clear filters</GhostBtn>} />
      ) : (
      <TableShell>
        <thead>
          <tr className="bg-brand-soft">
            <Th sortKey="symbol" sort={sort} onSort={toggle}>Stock</Th>
            <Th sortKey="cap" sort={sort} onSort={toggle}>Cap</Th>
            <Th right sortKey="qty" sort={sort} onSort={toggle}>Qty</Th>
            <Th right sortKey="lots" sort={sort} onSort={toggle}>Lots</Th>
            <Th right sortKey="invested" sort={sort} onSort={toggle}>Invested</Th>
            <Th right sortKey="alloc" sort={sort} onSort={toggle}>Alloc %</Th>
            <Th right>Limit</Th>
            <Th right sortKey="curValue" sort={sort} onSort={toggle}>Cur. value</Th>
            <Th right sortKey="pnl" sort={sort} onSort={toggle}>P&L ₹</Th>
            <Th right sortKey="pnlPct" sort={sort} onSort={toggle}>P&L %</Th>
          </tr>
        </thead>
        <tbody>
          {apply(filtered).map((h) => (
            <tr key={h.symbol} className="border-t border-brand-border/60 hover:bg-brand-soft/60">
              <Td className="font-semibold">{h.symbol}</Td>
              <Td><CapChip cap={h.cap} /></Td>
              <Td right>{h.qty}</Td>
              <Td right className="text-brand-mute">{h.lots}</Td>
              <Td right>{fmtMoney(h.invested, 0)}</Td>
              <Td right>
                <span className="inline-flex items-center gap-1.5">
                  {fmtPct(h.allocPct)}
                  <AllocMarker state={h.marker} cap={h.cap} totalPct={h.allocPct} />
                </span>
              </Td>
              <Td right className="text-brand-mute">
                {h.cap ? `${CAP_LIMITS[h.cap]}%` : "—"}
              </Td>
              <Td right>{fmtMoney(h.currentValue, 0)}</Td>
              <Td right><Pnl value={h.pnl} digits={0} /></Td>
              <Td right><Pnl value={h.pnlPct} suffix="%" /></Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
      )}
    </div>
  );
}

function Big({ label, value, sub }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
}) {
  return (
    <div className="p-3.5 rounded-xl bg-brand-panel ring-1 ring-brand-border shadow-card">
      <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">{label}</div>
      <div className="mt-1 text-lg font-display font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-brand-mute mt-0.5">{sub}</div>}
    </div>
  );
}
