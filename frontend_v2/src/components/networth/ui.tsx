// -----------------------------------------------------------------------------
// Net Worth UI primitives — the trend area chart and small tone helpers. The
// stat cards, section cards, donut and bar rows are reused from the expense
// tracker's ui.tsx so the two dashboards share one visual language.
// -----------------------------------------------------------------------------
import type { ReactNode } from "react";
import type { AssetClass } from "../../lib/networthApi";
import { fmtMoney } from "../../lib/money";
import type { RunwayState } from "../../lib/networth";

// ---- Colours ---------------------------------------------------------------------

/** Stable colour per allocation key (Equity + asset classes). */
export const ALLOC_COLORS: Record<string, string> = {
  Equity: "#0f766e",
  // Deliberately adjacent to Equity's teal — direct stocks are the same kind
  // of exposure, just held outside the journal.
  "Direct Stocks": "#047857",
  "Mutual Fund": "#0369a1",
  Cash: "#4d7c0f",
  FD: "#0e7490",
  Gold: "#b45309",
  "EPF/PPF": "#6d28d9",
  "Real Estate": "#a21caf",
  Crypto: "#c2410c",
  Bonds: "#4338ca",
  Other: "#57534e",
};
export const colorFor = (key: string): string => ALLOC_COLORS[key] ?? "#a8a29e";

export const CLASS_ICON: Record<AssetClass, string> = {
  Cash: "💵", FD: "🏦", "Mutual Fund": "📊", "Direct Stocks": "📈",
  Gold: "🪙", "EPF/PPF": "🛡️", "Real Estate": "🏠", Crypto: "🪐",
  Bonds: "📜", Other: "📦",
};

export const RUNWAY_CLS: Record<RunwayState, string> = {
  danger: "text-rose-700",
  caution: "text-amber-700",
  healthy: "text-teal-700",
};

export const TONE_CLS = {
  warn: "bg-rose-50 ring-rose-200 text-rose-900",
  info: "bg-sky-50 ring-sky-200 text-sky-900",
  good: "bg-teal-50 ring-teal-200 text-teal-900",
} as const;

export function ClassChip({ cls }: { cls: AssetClass }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium
                     ring-1 ring-brand-border bg-brand-soft whitespace-nowrap">
      <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorFor(cls) }} />
      <span aria-hidden>{CLASS_ICON[cls]}</span>{cls}
    </span>
  );
}

// ---- Area / line chart -----------------------------------------------------------------

export interface TrendPoint {
  key: string;      // "YYYY-MM"
  label: string;    // "Sep"
  value: number;
  live?: boolean;   // the current (unsnapshotted) value — drawn hollow
}

/** Hand-rolled SVG area chart (repo precedent: no chart library). Scales to
 * its container; y-axis is padded so a flat series still reads as a line. */
export function AreaChart({ points, height = 140, compact = false }: {
  points: TrendPoint[]; height?: number; compact?: boolean;
}) {
  if (points.length === 0) return null;
  const W = 600; const H = height;
  const padX = compact ? 6 : 28; const padY = compact ? 8 : 18;
  const vals = points.map((p) => p.value);
  let min = Math.min(...vals); let max = Math.max(...vals);
  if (max === min) { max += Math.abs(max) * 0.05 || 1; min -= Math.abs(min) * 0.05 || 1; }
  const span = max - min;
  min -= span * 0.1; max += span * 0.1;
  const x = (i: number) => points.length === 1 ? W / 2 : padX + (i / (points.length - 1)) * (W - 2 * padX);
  const y = (v: number) => padY + (1 - (v - min) / (max - min)) * (H - 2 * padY);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(H - padY).toFixed(1)} L${x(0).toFixed(1)},${(H - padY).toFixed(1)} Z`;
  const zeroY = min < 0 && max > 0 ? y(0) : null;
  const step = Math.max(1, Math.ceil(points.length / (compact ? 4 : 8)));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} role="img"
         aria-label={`Net worth trend, ${points.length} points`}>
      <defs>
        <linearGradient id="nwArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0f766e" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#0f766e" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {!compact && [0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={padX} x2={W - padX} y1={padY + f * (H - 2 * padY)} y2={padY + f * (H - 2 * padY)}
              stroke="#e5e0d4" strokeDasharray="3 4" />
      ))}
      {zeroY !== null && <line x1={padX} x2={W - padX} y1={zeroY} y2={zeroY} stroke="#be123c" strokeOpacity="0.5" />}
      {points.length > 1 && <path d={area} fill="url(#nwArea)" />}
      <path d={line} fill="none" stroke="#0f766e" strokeWidth={compact ? 2 : 2.5}
            strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <g key={p.key}>
          <circle cx={x(i)} cy={y(p.value)} r={compact ? 3 : 4}
                  fill={p.live ? "#ffffff" : "#0f766e"} stroke="#0f766e" strokeWidth="2">
            <title>{`${p.label}: ₹${fmtMoney(p.value, 0)}${p.live ? " (live, not yet snapshotted)" : ""}`}</title>
          </circle>
          {!compact && i % step === 0 && (
            <text x={x(i)} y={H - 3} textAnchor="middle" fontSize="10" fill="#8b8574">{p.label}</text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ---- Progress bar -----------------------------------------------------------------------

export function ProgressBar({ pct, tone = "bg-teal-600", height = "h-2" }: {
  pct: number; tone?: string; height?: string;
}) {
  return (
    <div className={`${height} rounded-full bg-brand-soft ring-1 ring-brand-border/50 overflow-hidden`}>
      <div className={`h-full rounded-full transition-[width] duration-500 ${tone}`}
           style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

/** Small "not enough data" placeholder used wherever a metric can't be honest yet. */
export function NoData({ children }: { children: ReactNode }) {
  return (
    <p className="text-[12px] text-brand-mute bg-brand-soft ring-1 ring-brand-border/60 rounded-lg px-3 py-2">
      {children}
    </p>
  );
}
