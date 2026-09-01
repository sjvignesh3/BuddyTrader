// -----------------------------------------------------------------------------
// The pool table — every column of the legacy BuddyTrader view, sortable,
// with the same colour semantics:
//   Symbol · Sector · Cap · Close ₹ · 200 DMA · % Below DMA · 52W Low ·
//   52W High · % From Low · ATH · % ↓ ATH · Last Week Trend ·
//   Score (out of 11) · then [Signal] or the rally tail
//   [Days Since Streak · % to Next Buy · Streak %] for S200 / PlayArea.
// -----------------------------------------------------------------------------
import { Fragment, useMemo, useState } from "react";
import type { StockRow } from "../lib/rows";
import RowDetail from "./RowDetail";
import ScoreBadge from "./ScoreBadge";
import SignalBadge from "./SignalBadge";

export const RALLY_POOLS = new Set(["S200", "PlayArea"]);

type Align = "left" | "right" | "center";
// Literal classes — Tailwind's scanner cannot see interpolated names.
const ALIGN_CLS: Record<Align, string> = {
  left: "text-left", right: "text-right", center: "text-center",
};
interface Col {
  key: string;
  label: string;
  align: Align;
  tip?: string;
  value: (r: StockRow) => number | string | null;
  render: (r: StockRow) => React.ReactNode;
}

function money(v: number | null, nd = 2) {
  return v === null ? "—" : v.toLocaleString("en-IN", {
    minimumFractionDigits: nd, maximumFractionDigits: nd });
}
function pct(v: number | null, nd = 1) {
  return v === null ? "—" : `${v.toFixed(nd)}%`;
}

// Legacy colour helpers -------------------------------------------------------
const trendCls = (v: number | null) =>
  v === null ? "text-brand-mute"
    : v > 3 ? "text-emerald-400 font-bold"
      : v > 0 ? "text-emerald-400/60 font-semibold"
        : v > -3 ? "text-red-400/60 font-semibold"
          : "text-red-400 font-bold";
const daysCls = (v: number | null) =>
  v === null ? "text-brand-mute"
    : v <= 30 ? "text-sky-400 font-semibold"
      : v <= 90 ? "text-sky-300/70 font-semibold" : "text-brand-mute";
const toBuyCls = (v: number | null) =>
  v === null ? "text-brand-mute"
    : v <= 0 ? "text-emerald-400 font-semibold"
      : v <= 10 ? "text-amber-400 font-semibold" : "text-brand-mute";

const CAP_STYLE: Record<string, string> = {
  Large: "bg-sky-500/15 text-sky-400",
  Mid: "bg-violet-500/15 text-violet-400",
  Small: "bg-amber-500/15 text-amber-400",
  Micro: "bg-zinc-500/15 text-zinc-400",
};
const CAP_SHORT: Record<string, string> = {
  Large: "LRG", Mid: "MID", Small: "SML", Micro: "MCR",
};

const BASE_COLS: Col[] = [
  { key: "symbol", label: "Symbol", align: "left",
    value: (r) => r.symbol,
    render: (r) => <span className="font-semibold">{r.symbol.replace(/\.(NS|BO)$/, "")}</span> },
  { key: "sector", label: "Sector", align: "left",
    value: (r) => r.sector,
    render: (r) => (
      <span className="text-brand-mute text-[11px] block max-w-[110px] truncate">
        {r.sector ?? "—"}
      </span>
    ) },
  { key: "cap", label: "Cap", align: "center",
    value: (r) => r.cap,
    render: (r) => r.cap ? (
      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${CAP_STYLE[r.cap] ?? "bg-zinc-500/15 text-zinc-400"}`}>
        {CAP_SHORT[r.cap] ?? r.cap}
      </span>
    ) : <span className="text-brand-mute">—</span> },
  { key: "close", label: "Close ₹", align: "right",
    value: (r) => r.close, render: (r) => money(r.close) },
  { key: "dma200", label: "200 DMA", align: "right",
    value: (r) => r.dma200,
    render: (r) => <span className="text-brand-mute">{money(r.dma200)}</span> },
  { key: "belowDmaPct", label: "% Below DMA", align: "right",
    tip: "Positive = price under the 200 DMA (buy zone)",
    value: (r) => r.belowDmaPct,
    render: (r) => (
      <span className={`font-semibold ${
        r.belowDmaPct === null ? "text-brand-mute"
          : r.belowDmaPct > 0 ? "text-emerald-400" : "text-red-400"}`}>
        {pct(r.belowDmaPct)}
      </span>
    ) },
  { key: "low52w", label: "52W Low", align: "right",
    value: (r) => r.low52w,
    render: (r) => <span className="text-brand-mute">{money(r.low52w)}</span> },
  { key: "high52w", label: "52W High", align: "right",
    value: (r) => r.high52w,
    render: (r) => <span className="text-brand-mute">{money(r.high52w)}</span> },
  { key: "fromLowPct", label: "% From Low", align: "right",
    value: (r) => r.fromLowPct,
    render: (r) => (
      <span className={r.fromLowPct !== null && r.fromLowPct <= 5
        ? "text-emerald-400 font-semibold" : "text-brand-mute"}>
        {pct(r.fromLowPct)}
      </span>
    ) },
  { key: "ath", label: "ATH", align: "right",
    value: (r) => r.ath,
    render: (r) => <span className="text-brand-mute">{money(r.ath)}</span> },
  { key: "downFromAthPct", label: "% ↓ ATH", align: "right",
    tip: "Fall from all-time high (adjusted)",
    value: (r) => r.downFromAthPct,
    render: (r) => (
      <span className={`font-semibold ${
        r.downFromAthPct === null ? "text-brand-mute"
          : r.downFromAthPct >= 30 ? "text-emerald-400"
            : r.downFromAthPct >= 15 ? "text-amber-400" : "text-brand-mute"}`}>
        {pct(r.downFromAthPct)}
      </span>
    ) },
  { key: "trendPct", label: "Last Week Trend", align: "right",
    tip: "Price % change over the trend window (7 trading days). Sort for Top Gainers / Losers.",
    value: (r) => r.trendPct,
    render: (r) => r.trendPct === null
      ? <span className="text-brand-mute">—</span>
      : (
        <span className={trendCls(r.trendPct)}>
          <span className="text-[9px] mr-0.5">{r.trendPct > 0 ? "▲" : r.trendPct < 0 ? "▼" : "▶"}</span>
          {r.trendPct > 0 ? "+" : ""}{r.trendPct.toFixed(2)}%
        </span>
      ) },
  { key: "score", label: "Score /11", align: "center",
    tip: "Fundamental score: how many of the 11 BuddyTrader checks pass. Click to sort.",
    value: (r) => r.score,
    render: (r) => <ScoreBadge points={r.score} /> },
];

const SIGNAL_COL: Col = {
  key: "bestStatus", label: "Signal", align: "center",
  value: (r) => {
    const rank: Record<string, number> = { BUY_ZONE: 3, OPPORTUNITY: 2, VALID: 1 };
    return r.bestStatus ? rank[r.bestStatus] ?? 0 : 0;
  },
  render: (r) => <SignalBadge status={r.bestStatus} />,
};

const RALLY_COLS: Col[] = [
  { key: "daysSinceRally", label: "Days Since Streak", align: "right",
    tip: "Trading days since the last qualifying 20%+ green streak ended",
    value: (r) => r.daysSinceRally,
    render: (r) => r.daysSinceRally === null
      ? <span className="text-brand-mute">—</span>
      : <span className={daysCls(r.daysSinceRally)}>{r.daysSinceRally}d</span> },
  { key: "pctToNextBuy", label: "% To Next Buy", align: "right",
    tip: "Distance above the last streak's re-entry low. ≤0 = at/below buy level",
    value: (r) => r.pctToNextBuy,
    render: (r) => r.pctToNextBuy === null
      ? <span className="text-brand-mute">—</span>
      : (
        <span className={toBuyCls(r.pctToNextBuy)}>
          {r.pctToNextBuy > 0 ? "+" : ""}{r.pctToNextBuy.toFixed(1)}%
        </span>
      ) },
  { key: "rallyPct", label: "Streak %", align: "right",
    tip: "Rally % of the most recent qualifying streak",
    value: (r) => r.rallyPct,
    render: (r) => r.rallyPct === null || r.rallyPct <= 0
      ? <span className="text-brand-mute">—</span>
      : (
        <span className={`font-bold ${
          r.rallyPct >= 30 ? "text-emerald-400"
            : r.rallyPct >= 20 ? "text-sky-400" : "text-brand-mute"}`}>
          {r.rallyPct.toFixed(1)}%
        </span>
      ) },
];

export default function StockTable({
  rows,
  pool,
}: {
  rows: StockRow[];
  pool: string;
}) {
  const isRally = RALLY_POOLS.has(pool);
  const columns = useMemo(
    () => (isRally ? [...BASE_COLS, ...RALLY_COLS] : [...BASE_COLS, SIGNAL_COL]),
    [isRally]);

  const [sortKey, setSortKey] = useState<string>(isRally ? "daysSinceRally" : "score");
  const [sortAsc, setSortAsc] = useState<boolean>(isRally);
  const [expanded, setExpanded] = useState<string | null>(null);

  const handleSort = (key: string) => {
    if (sortKey === key) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      // Legacy defaults: days/% to buy ascending, everything else descending.
      setSortAsc(key === "daysSinceRally" || key === "pctToNextBuy" || key === "symbol" || key === "sector");
    }
  };

  const sorted = useMemo(() => {
    const col: Col = columns.find((c) => c.key === sortKey) ?? BASE_COLS[0]!;
    return [...rows].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      // Nulls always sink to the bottom, whatever the direction.
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      let cmp: number;
      if (typeof va === "string" || typeof vb === "string") {
        cmp = String(va).localeCompare(String(vb));
      } else {
        cmp = va - vb;
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [rows, columns, sortKey, sortAsc]);

  return (
    <div className="rounded-xl ring-1 ring-brand-border overflow-hidden bg-brand-panel/30">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-brand-panel text-brand-mute text-[10px] uppercase tracking-wide select-none sticky top-0 z-10">
              {columns.map((c) => (
                <th key={c.key}
                    title={c.tip}
                    onClick={() => handleSort(c.key)}
                    className={`px-2.5 py-2.5 whitespace-nowrap cursor-pointer transition-colors hover:text-brand-text ${
                      sortKey === c.key ? "text-brand-accent" : ""} ${ALIGN_CLS[c.align]}`}>
                  {c.label}
                  {sortKey === c.key && (
                    <span className="ml-0.5 text-[8px]">{sortAsc ? "▲" : "▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {sorted.map((r, i) => {
              const open = expanded === r.symbol;
              return (
                <Fragment key={r.symbol}>
                  <tr
                    onClick={() => setExpanded(open ? null : r.symbol)}
                    className={`border-t border-brand-border/40 cursor-pointer transition-colors ${
                      open ? "bg-brand-accent/[0.07]"
                        : i % 2 ? "bg-brand-panel/20 hover:bg-brand-panel/60"
                          : "hover:bg-brand-panel/60"}`}
                  >
                    {columns.map((c) => (
                      <td key={c.key}
                          className={`px-2.5 py-2 whitespace-nowrap ${ALIGN_CLS[c.align]}`}>
                        {c.render(r)}
                      </td>
                    ))}
                  </tr>
                  {open && (
                    <tr className="border-t border-brand-accent/20">
                      <td colSpan={columns.length} className="p-0">
                        <RowDetail row={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length === 0 && (
        <div className="py-12 text-center text-sm text-brand-mute">
          No stocks match the current filters.
        </div>
      )}
      {/* Legend — legacy footer */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 border-t border-brand-border/60 text-[10px] text-brand-mute">
        <span className="font-bold text-sky-400">Score:</span>
        <span><b className="text-emerald-400">8–11</b> strong</span>
        <span><b className="text-amber-400">6–7</b> moderate</span>
        <span><b className="text-red-400">0–5</b> weak</span>
        <span>— = not scored yet</span>
        {isRally && (
          <span className="border-l border-brand-border pl-3">
            <b className="text-emerald-400">% To Next Buy ≤ 0</b> = at/below re-entry ·{" "}
            <b className="text-amber-400">≤ +10%</b> = watch zone
          </span>
        )}
        <span className="ml-auto text-sky-400">↕ click a header to sort · click a row for details</span>
      </div>
    </div>
  );
}
