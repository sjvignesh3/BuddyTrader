// -----------------------------------------------------------------------------
// The pool table — every BuddyTrader column, sortable, restyled for the
// premium light theme with decision cues:
//   · % Below DMA renders as a progress bar toward the 14% buy threshold
//   · Score renders as a radial ring (8+/6–7/<6 bands)
//   · a compare checkbox feeds the side-by-side tray
//   · clicking a row opens the stock's own page (/stocks/:symbol)
// Columns: Symbol · Sector · Cap · Close ₹ · 200 DMA · % Below DMA ·
// 52W Low · 52W High · % From Low · ATH · % ↓ ATH · Last Week Trend ·
// Score /11 · then [Signal] or [Days Since Streak · % To Next Buy · Streak %].
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { athFallThreshold, passesAthRule, type StockRow } from "../lib/rows";
import ScoreRing from "./ScoreRing";
import SignalBadge from "./SignalBadge";

export const RALLY_POOLS = new Set(["S200", "PlayArea"]);

type Align = "left" | "right" | "center";
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

const trendCls = (v: number | null) =>
  v === null ? "text-brand-mute"
    : v > 3 ? "text-teal-700 font-bold"
      : v > 0 ? "text-teal-600/80 font-semibold"
        : v > -3 ? "text-rose-500/80 font-semibold"
          : "text-rose-600 font-bold";
const daysCls = (v: number | null) =>
  v === null ? "text-brand-mute"
    : v <= 30 ? "text-sky-700 font-semibold"
      : v <= 90 ? "text-sky-600/70 font-semibold" : "text-brand-mute";
const toBuyCls = (v: number | null) =>
  v === null ? "text-brand-mute"
    : v <= 0 ? "text-teal-700 font-semibold"
      : v <= 10 ? "text-amber-700 font-semibold" : "text-brand-mute";

const CAP_STYLE: Record<string, string> = {
  Large: "bg-sky-50 text-sky-800 ring-1 ring-sky-200",
  Mid: "bg-violet-50 text-violet-800 ring-1 ring-violet-200",
  Small: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
  Micro: "bg-stone-100 text-stone-600 ring-1 ring-stone-200",
};
const CAP_SHORT: Record<string, string> = {
  Large: "LRG", Mid: "MID", Small: "SML", Micro: "MCR",
};

/** % below DMA as progress toward the 14% BUY_ZONE threshold. */
function DmaBar({ v }: { v: number | null }) {
  if (v === null) return <span className="text-brand-mute">—</span>;
  const frac = Math.max(0, Math.min(1, v / 14));
  const color = v >= 14 ? "bg-teal-600" : v >= 9 ? "bg-amber-500" : v > 0 ? "bg-stone-400" : "bg-rose-300";
  return (
    <span className="inline-flex items-center gap-1.5 justify-end w-full">
      <span className={`font-semibold ${v >= 14 ? "text-teal-700" : v >= 9 ? "text-amber-700" : v > 0 ? "text-brand-text" : "text-rose-600"}`}>
        {pct(v)}
      </span>
      <span className="w-10 h-1.5 rounded-full bg-brand-border overflow-hidden shrink-0">
        <span className={`block h-full rounded-full ${color}`} style={{ width: `${frac * 100}%` }} />
      </span>
    </span>
  );
}

const BASE_COLS: Col[] = [
  { key: "symbol", label: "Symbol", align: "left",
    value: (r) => r.symbol,
    render: (r) => (
      <span className="font-sans font-semibold text-[12px]">
        {r.symbol.replace(/\.(NS|BO)$/, "")}
      </span>
    ) },
  { key: "sector", label: "Sector", align: "left",
    value: (r) => r.sector,
    render: (r) => (
      <span className="text-brand-mute text-[10px] uppercase tracking-wide block max-w-[100px] truncate">
        {r.sector ?? "—"}
      </span>
    ) },
  { key: "cap", label: "Cap", align: "center",
    value: (r) => r.cap,
    render: (r) => r.cap ? (
      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${CAP_STYLE[r.cap] ?? "bg-stone-100 text-stone-600"}`}>
        {CAP_SHORT[r.cap] ?? r.cap}
      </span>
    ) : <span className="text-brand-mute">—</span> },
  { key: "close", label: "Close ₹", align: "right",
    value: (r) => r.close,
    render: (r) => <span className="font-semibold">{money(r.close)}</span> },
  { key: "dma200", label: "200 DMA", align: "right",
    value: (r) => r.dma200,
    render: (r) => <span className="text-brand-mute">{money(r.dma200)}</span> },
  { key: "belowDmaPct", label: "% Below DMA", align: "right",
    tip: "Positive = under the 200 DMA. Bar fills toward the 14% buy-zone threshold.",
    value: (r) => r.belowDmaPct,
    render: (r) => <DmaBar v={r.belowDmaPct} /> },
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
        ? "text-teal-700 font-semibold" : "text-brand-mute"}>
        {pct(r.fromLowPct)}
      </span>
    ) },
  { key: "ath", label: "ATH", align: "right",
    value: (r) => r.ath,
    render: (r) => <span className="text-brand-mute">{money(r.ath)}</span> },
  { key: "downFromAthPct", label: "% ↓ ATH", align: "right",
    tip: "Fall from all-time high (adjusted). Deep-value rule by cap: "
       + "Large >20% · Mid >30% · Small/Micro >40%. ✓ = clears its rule.",
    value: (r) => r.downFromAthPct,
    render: (r) => {
      const t = athFallThreshold(r.cap);
      const v = r.downFromAthPct;
      const pass = passesAthRule(r);
      return (
        <span className={`font-semibold ${
          v === null ? "text-brand-mute"
            : pass ? "text-teal-700"
              : v >= t - 10 ? "text-amber-700" : "text-brand-mute"}`}
              title={`Rule for ${r.cap ?? "unknown"} cap: fall > ${t}%`}>
          {pct(v)}{pass ? " ✓" : ""}
        </span>
      );
    } },
  { key: "trendPct", label: "Week Trend", align: "right",
    tip: "Price % change over 7 trading days. Sort for Top Gainers / Losers.",
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
    tip: "Fundamental score — the 11 BuddyTrader checks. Click to sort.",
    value: (r) => r.score,
    render: (r) => <ScoreRing points={r.score} size={32} /> },
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
          r.rallyPct >= 30 ? "text-teal-700"
            : r.rallyPct >= 20 ? "text-sky-700" : "text-brand-mute"}`}>
          {r.rallyPct.toFixed(1)}%
        </span>
      ) },
];

/** plain NSE symbol (journal convention) from a yfinance one */
const plain = (symbol: string) => symbol.replace(/\.(NS|BO)$/i, "");

export default function StockTable({
  rows,
  pool,
  compared,
  onToggleCompare,
  heldSymbols,
}: {
  rows: StockRow[];
  pool: string;
  compared: string[];
  onToggleCompare: (symbol: string) => void;
  /** plain symbols with an open Trading Journal position — shows 💼 */
  heldSymbols?: Set<string>;
}) {
  const navigate = useNavigate();
  const isRally = RALLY_POOLS.has(pool);
  const columns = useMemo(() => {
    // Decorate the symbol cell with the "held" marker when applicable.
    const base = BASE_COLS.map((c) => c.key !== "symbol" ? c : {
      ...c,
      render: (r: StockRow) => (
        <span className="inline-flex items-center gap-1">
          {c.render(r)}
          {heldSymbols?.has(plain(r.symbol)) && (
            <span title="Open position in your Trading Journal"
                  className="text-[10px] leading-none">💼</span>
          )}
        </span>
      ),
    });
    return isRally ? [...base, ...RALLY_COLS] : [...base, SIGNAL_COL];
  }, [isRally, heldSymbols]);

  const [sortKey, setSortKey] = useState<string>(isRally ? "daysSinceRally" : "score");
  const [sortAsc, setSortAsc] = useState<boolean>(isRally);

  const handleSort = (key: string) => {
    if (sortKey === key) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      setSortAsc(key === "daysSinceRally" || key === "pctToNextBuy" ||
                 key === "symbol" || key === "sector");
    }
  };

  const sorted = useMemo(() => {
    const col: Col = columns.find((c) => c.key === sortKey) ?? BASE_COLS[0]!;
    return [...rows].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const cmp = (typeof va === "string" || typeof vb === "string")
        ? String(va).localeCompare(String(vb))
        : va - vb;
      return sortAsc ? cmp : -cmp;
    });
  }, [rows, columns, sortKey, sortAsc]);

  return (
    <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card overflow-hidden">
      {/* overflow-auto + max-h keeps the header row floating while scrolling.
          position:sticky must live on the th cells — Chrome ignores it on tr. */}
      <div className="overflow-auto max-h-[calc(100vh-200px)]">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-brand-mute text-[9.5px] font-semibold uppercase tracking-wider select-none">
              <th className="w-8 px-2 sticky top-0 z-10 bg-brand-soft shadow-[0_1px_0_0_#e5e0d4]"
                  title="Add to comparison tray" />
              {columns.map((c) => (
                <th key={c.key}
                    title={c.tip}
                    onClick={() => handleSort(c.key)}
                    className={`px-2.5 py-2.5 whitespace-nowrap cursor-pointer transition-colors
                      sticky top-0 z-10 bg-brand-soft shadow-[0_1px_0_0_#e5e0d4]
                      hover:text-brand-text ${
                      sortKey === c.key ? "text-brand-accent" : ""} ${ALIGN_CLS[c.align]}`}>
                  {c.label}
                  {sortKey === c.key && (
                    <span className="ml-0.5 text-[8px]">{sortAsc ? "▲" : "▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums text-[11.5px]">
            {sorted.map((r) => {
              const inTray = compared.includes(r.symbol);
              return (
                <tr
                  key={r.symbol}
                  onClick={() => navigate(`/stocks/${encodeURIComponent(r.symbol)}`)}
                  className="border-t border-brand-border/70 cursor-pointer transition-colors hover:bg-brand-soft"
                >
                  <td className="px-2 text-center" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox"
                           checked={inTray}
                           onChange={() => onToggleCompare(r.symbol)}
                           className="accent-teal-700 cursor-pointer"
                           title="Compare" />
                  </td>
                  {columns.map((c) => (
                    <td key={c.key}
                        className={`px-2.5 py-2 whitespace-nowrap ${ALIGN_CLS[c.align]}`}>
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-t border-brand-border bg-brand-soft text-[10px] text-brand-mute">
        <span className="font-bold text-brand-accent">Score:</span>
        <span><b className="text-teal-700">8–11</b> strong</span>
        <span><b className="text-amber-700">6–7</b> moderate</span>
        <span><b className="text-rose-600">0–5</b> weak</span>
        <span>– = not scored yet</span>
        <span className="border-l border-brand-border pl-3">
          <span className="font-bold text-brand-accent">% ↓ ATH rule:</span>{" "}
          <b>LRG</b> &gt;20 · <b>MID</b> &gt;30 · <b>SML/MCR</b> &gt;40 ·{" "}
          <b className="text-teal-700">✓</b> clears it
        </span>
        {isRally && (
          <span className="border-l border-brand-border pl-3">
            <b className="text-teal-700">% To Next Buy ≤ 0</b> = at/below re-entry ·{" "}
            <b className="text-amber-700">≤ +10%</b> = watch zone
          </span>
        )}
        <span className="ml-auto">↕ sort by any header · click a row to open the stock page · ☑ to compare</span>
      </div>
    </div>
  );
}
