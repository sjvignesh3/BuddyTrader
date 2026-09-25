// -----------------------------------------------------------------------------
// Comparison tray — pick up to 4 stocks anywhere (radar cards or table
// checkboxes) and read them side-by-side. The best value in each metric row
// is marked, so "which is the better opportunity" answers itself.
// -----------------------------------------------------------------------------
import type { StockRow } from "../lib/rows";
import ScoreRing from "./ScoreRing";
import SignalBadge from "./SignalBadge";

type Better = "high" | "low" | null;

interface MetricRow {
  label: string;
  better: Better;
  value: (r: StockRow) => number | null;
  fmt: (v: number | null) => string;
}

const n2 = (v: number | null) =>
  v === null ? "—" : v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const p1 = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
const r2 = (v: number | null) => (v === null ? "—" : v.toFixed(2));

const METRICS: MetricRow[] = [
  { label: "Close ₹", better: null, value: (r) => r.close, fmt: n2 },
  { label: "% below 200 DMA", better: "high", value: (r) => r.belowDmaPct, fmt: p1 },
  { label: "% from 52w low", better: "low", value: (r) => r.fromLowPct, fmt: p1 },
  { label: "% down from ATH", better: "high", value: (r) => r.downFromAthPct, fmt: p1 },
  { label: "Week trend", better: null, value: (r) => r.trendPct, fmt: p1 },
  { label: "PE", better: "low", value: (r) => r.pe, fmt: r2 },
  { label: "PE vs 5yr avg", better: "low",
    value: (r) => {
      const avg = r.funda?.data?.pe_5yr_avg ? Number(r.funda.data.pe_5yr_avg) : null;
      return r.pe !== null && avg ? (r.pe / avg) * 100 : null;
    },
    fmt: (v) => (v === null ? "—" : `${v.toFixed(0)}%`) },
  { label: "PB", better: "low", value: (r) => r.pb, fmt: r2 },
  { label: "ROCE %", better: "high",
    value: (r) => (r.funda?.data?.roce ? Number(r.funda.data.roce) : null), fmt: p1 },
  { label: "ROE %", better: "high",
    value: (r) => (r.funda?.data?.roe ? Number(r.funda.data.roe) : null), fmt: p1 },
  { label: "Net D/E", better: "low",
    value: (r) => (r.funda?.data?.net_debt_to_equity !== null &&
                   r.funda?.data?.net_debt_to_equity !== undefined
      ? Number(r.funda.data.net_debt_to_equity) : null), fmt: r2 },
  // Lenders (Banks / NBFC list) — blank for everyone else.
  { label: "ROA %", better: "high",
    value: (r) => (r.funda?.data?.roa ? Number(r.funda.data.roa) : null), fmt: r2 },
  { label: "Gross NPA %", better: "low",
    value: (r) => (r.funda?.data?.gross_npa ? Number(r.funda.data.gross_npa) : null), fmt: r2 },
  { label: "Net NPA %", better: "low",
    value: (r) => (r.funda?.data?.net_npa ? Number(r.funda.data.net_npa) : null), fmt: r2 },
  { label: "Pledging %", better: "low",
    value: (r) => (r.funda?.data?.pledging ? Number(r.funda.data.pledging) : (r.funda ? 0 : null)), fmt: p1 },
  { label: "MCap ₹Cr", better: null, value: (r) => r.marketCapCr,
    fmt: (v) => (v === null ? "—" : Math.round(v).toLocaleString("en-IN")) },
];

export default function CompareDrawer({
  rows,
  onRemove,
  onClose,
}: {
  rows: StockRow[];
  onRemove: (symbol: string) => void;
  onClose: () => void;
}) {
  if (rows.length === 0) return null;

  const bestIdx = (m: MetricRow): number => {
    if (!m.better) return -1;
    let best = -1;
    let bestVal: number | null = null;
    rows.forEach((r, i) => {
      const v = m.value(r);
      if (v === null) return;
      if (bestVal === null ||
          (m.better === "high" ? v > bestVal : v < bestVal)) {
        bestVal = v;
        best = i;
      }
    });
    return rows.length > 1 ? best : -1;
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 px-4 pb-4">
      <div className="max-w-7xl mx-auto rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-pop overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-brand-border bg-brand-soft">
          <span className="font-display font-semibold text-sm">
            Compare · {rows.length} stock{rows.length > 1 ? "s" : ""}
            <span className="text-brand-mute font-sans font-normal text-[11px] ml-2">
              ● marks the better value per row
            </span>
          </span>
          <button onClick={onClose}
                  className="text-[11px] font-semibold text-brand-mute hover:text-brand-text px-2 py-1">
            Close ✕
          </button>
        </div>
        <div className="overflow-x-auto max-h-[46vh] overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="sticky top-0 bg-brand-panel z-10">
                <th className="text-left px-4 py-2 text-[10px] uppercase tracking-wider text-brand-mute w-40">
                  Metric
                </th>
                {rows.map((r) => (
                  <th key={r.symbol} className="px-3 py-2 min-w-[130px]">
                    <div className="flex flex-col items-center gap-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-display font-semibold text-sm">
                          {r.symbol.replace(/\.(NS|BO)$/, "")}
                        </span>
                        <button onClick={() => onRemove(r.symbol)}
                                className="text-brand-mute hover:text-rose-600 text-[11px]">✕</button>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <ScoreRing points={r.score} size={30} />
                        <SignalBadge status={r.bestStatus} />
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {METRICS.map((m) => {
                const best = bestIdx(m);
                return (
                  <tr key={m.label} className="border-t border-brand-border/60">
                    <td className="px-4 py-1.5 text-brand-mute">{m.label}</td>
                    {rows.map((r, i) => (
                      <td key={r.symbol}
                          className={`px-3 py-1.5 text-center font-mono ${
                            i === best ? "font-bold text-teal-800" : ""}`}>
                        {i === best && <span className="text-teal-600 mr-1">●</span>}
                        {m.fmt(m.value(r))}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
