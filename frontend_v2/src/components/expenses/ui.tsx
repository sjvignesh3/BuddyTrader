// -----------------------------------------------------------------------------
// Expense UI primitives — chips, stat cards, and hand-rolled SVG charts
// (donut, bar rows, daily trend, calendar heatmap). No chart library:
// the repo renders charts natively (journal precedent), and these four
// shapes are all the dashboard needs.
// -----------------------------------------------------------------------------
import { ReactNode } from "react";
import type { CategoryMaps } from "../../lib/expenses";
import { daysInMonth, num } from "../../lib/expenses";
import { fmtMoney } from "../../lib/money";
import type { Category, Intent } from "../../lib/expensesApi";

// ---- Category colours ----------------------------------------------------------

const PALETTE = [
  "#0f766e", "#b45309", "#0369a1", "#6d28d9", "#be123c", "#4d7c0f",
  "#0e7490", "#a21caf", "#c2410c", "#4338ca", "#047857", "#57534e",
];
const UNCAT_COLOR = "#a8a29e";

/** Stable colour per root category (0 / unknown = uncategorised gray). */
export function colorForRoot(rootId: number, maps: CategoryMaps): string {
  if (rootId === 0) return UNCAT_COLOR;
  const idx = maps.roots.findIndex((r) => r.id === rootId);
  return idx >= 0 ? PALETTE[idx % PALETTE.length]! : UNCAT_COLOR;
}

// ---- Chips -----------------------------------------------------------------------

export function CategoryChip({ categoryId, maps, showRoot = false }: {
  categoryId: number | null; maps: CategoryMaps; showRoot?: boolean;
}) {
  const cat = categoryId === null ? null : maps.byId.get(categoryId) ?? null;
  const root = maps.rootOf(categoryId);
  const color = colorForRoot(root?.id ?? 0, maps);
  const label = cat
    ? (showRoot && root && root.id !== cat.id ? `${root.name} › ${cat.name}` : cat.name)
    : "Uncategorised";
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full
                     text-[11px] font-medium ring-1 ring-brand-border bg-brand-soft
                     text-brand-text whitespace-nowrap max-w-full">
      <span aria-hidden className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: color }} />
      {root?.icon && <span aria-hidden className="text-[11px]">{root.icon}</span>}
      <span className="truncate">{label}</span>
    </span>
  );
}

export function IntentDot({ intent }: { intent: Intent | null }) {
  if (!intent) return null;
  const need = intent === "need";
  return (
    <span title={need ? "Need" : "Want"}
          className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold uppercase
                      tracking-wide ring-1 ${need
                        ? "bg-sky-50 text-sky-800 ring-sky-200"
                        : "bg-amber-50 text-amber-800 ring-amber-200"}`}>
      {need ? "Need" : "Want"}
    </span>
  );
}

// ---- Stat cards ------------------------------------------------------------------

/** Delta caption under a stat — "↑ 12% vs last month" coloured by direction
 * (spending up = rose, down = teal). */
export function DeltaNote({ current, baseline, label }: {
  current: number; baseline: number | null; label: string;
}) {
  if (baseline === null || baseline <= 0) {
    return <span className="text-[11px] text-brand-mute">no {label} data</span>;
  }
  const pct = ((current - baseline) / baseline) * 100;
  if (!Number.isFinite(pct)) return null;
  const up = pct > 0;
  const flat = Math.abs(pct) < 1;
  return (
    <span className={`text-[11px] font-medium tabular-nums ${
      flat ? "text-brand-mute" : up ? "text-rose-700" : "text-teal-700"}`}>
      {flat ? "≈ same as" : `${up ? "↑" : "↓"} ${Math.abs(pct).toFixed(0)}% vs`} {label}
    </span>
  );
}

export function StatCard({ label, value, children, big = false }: {
  label: string; value: ReactNode; children?: ReactNode; big?: boolean;
}) {
  return (
    <div className="p-3.5 rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card
                    flex flex-col gap-1 min-w-0">
      <span className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
        {label}
      </span>
      <span className={`font-display font-semibold tabular-nums truncate ${
        big ? "text-2xl" : "text-lg"}`}>{value}</span>
      {children}
    </div>
  );
}

export function SectionCard({ title, right, children, className = "" }: {
  title: string; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`p-4 rounded-2xl bg-brand-panel ring-1 ring-brand-border
                         shadow-card min-w-0 ${className}`}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-brand-mute">
          {title}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

// ---- Donut -----------------------------------------------------------------------

export interface Slice { label: string; value: number; color: string }

export function Donut({ slices, centerTop, centerBottom, size = 168 }: {
  slices: Slice[]; centerTop: string; centerBottom?: string; size?: number;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const R = 42; const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img"
         aria-label={`Breakdown donut: ${slices.map((s) => s.label).join(", ")}`}>
      <circle cx="50" cy="50" r={R} fill="none" stroke="#f0ede4" strokeWidth="13" />
      {total > 0 && slices.map((s, i) => {
        const frac = s.value / total;
        const el = (
          <circle key={i} cx="50" cy="50" r={R} fill="none"
                  stroke={s.color} strokeWidth="13"
                  strokeDasharray={`${frac * C} ${C}`}
                  strokeDashoffset={-offset * C}
                  transform="rotate(-90 50 50)">
            <title>{`${s.label}: ₹${fmtMoney(s.value, 0)} (${(frac * 100).toFixed(0)}%)`}</title>
          </circle>
        );
        offset += frac;
        return el;
      })}
      <text x="50" y="47" textAnchor="middle"
            className="font-display" fontSize="11" fontWeight="700" fill="#181c26">
        {centerTop}
      </text>
      {centerBottom && (
        <text x="50" y="59" textAnchor="middle" fontSize="6.5" fill="#8b8574">
          {centerBottom}
        </text>
      )}
    </svg>
  );
}

// ---- Horizontal bar row -------------------------------------------------------------

export function BarRow({ icon, label, value, max, share, delta, color, onClick }: {
  icon?: string | null; label: string; value: number; max: number;
  /** 0..1 share of the total, shown as a % chip. */
  share: number;
  /** Signed % change vs baseline (null hides the chip). */
  delta: number | null;
  color: string;
  onClick?: () => void;
}) {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick}
         className={`w-full text-left group ${onClick ? "cursor-pointer" : ""}`}>
      <div className="flex items-baseline justify-between gap-2 text-[12px] mb-0.5">
        <span className="font-medium truncate">
          {icon && <span aria-hidden className="mr-1">{icon}</span>}{label}
          <span className="ml-1.5 text-[10px] text-brand-mute tabular-nums">
            {(share * 100).toFixed(0)}%
          </span>
        </span>
        <span className="tabular-nums font-semibold whitespace-nowrap">
          ₹{fmtMoney(value, 0)}
          {delta !== null && Math.abs(delta) >= 1 && (
            <span className={`ml-1.5 text-[10px] font-medium ${
              delta > 0 ? "text-rose-600" : "text-teal-700"}`}>
              {delta > 0 ? "↑" : "↓"}{Math.abs(delta).toFixed(0)}%
            </span>
          )}
        </span>
      </div>
      <div className="h-2 rounded-full bg-brand-soft ring-1 ring-brand-border/50 overflow-hidden">
        <div className="h-full rounded-full transition-all group-hover:opacity-80"
             style={{ width: `${w}%`, backgroundColor: color }} />
      </div>
    </Tag>
  );
}

// ---- Daily trend (one month) ---------------------------------------------------------

export function DailyBars({ monthKey: key, byDay, highlightToday }: {
  monthKey: string; byDay: Map<string, number>; highlightToday?: string;
}) {
  const days = daysInMonth(key);
  const values = Array.from({ length: days }, (_, i) => {
    const iso = `${key}-${String(i + 1).padStart(2, "0")}`;
    return { iso, day: i + 1, total: byDay.get(iso) ?? 0 };
  });
  const max = Math.max(1, ...values.map((v) => v.total));
  return (
    <div className="flex items-end gap-[2px] h-24 w-full" role="img"
         aria-label="Daily spending bars">
      {values.map((v) => {
        const isWeekend = [0, 6].includes(new Date(`${v.iso}T00:00:00`).getDay());
        const isToday = v.iso === highlightToday;
        return (
          <div key={v.iso} className="flex-1 flex flex-col justify-end h-full group relative">
            <div title={`${v.day} — ₹${fmtMoney(v.total, 0)}`}
                 className={`w-full rounded-t transition-colors ${
                   v.total === 0 ? "bg-brand-soft"
                     : isToday ? "bg-teal-700"
                     : isWeekend ? "bg-amber-500/80 group-hover:bg-amber-600"
                     : "bg-teal-600/70 group-hover:bg-teal-700"}`}
                 style={{ height: v.total === 0 ? "3px" : `${Math.max(6, (v.total / max) * 100)}%` }} />
          </div>
        );
      })}
    </div>
  );
}

// ---- Monthly trend (n months) ---------------------------------------------------------

export function MonthlyTrend({ points, selected, onPick }: {
  points: { key: string; label: string; total: number }[];
  selected: string;
  onPick?: (key: string) => void;
}) {
  const max = Math.max(1, ...points.map((p) => p.total));
  return (
    <div className="flex items-end gap-1.5 h-28 w-full">
      {points.map((p) => {
        const active = p.key === selected;
        return (
          <button key={p.key} onClick={onPick ? () => onPick(p.key) : undefined}
                  title={`${p.label} — ₹${fmtMoney(p.total, 0)}`}
                  className="flex-1 h-full flex flex-col justify-end items-center gap-1 group">
            <span className={`text-[9px] tabular-nums font-semibold transition-opacity ${
              active ? "text-brand-text" : "text-brand-mute opacity-0 group-hover:opacity-100"}`}>
              ₹{fmtMoney(p.total, 0)}
            </span>
            <div className={`w-full rounded-t transition-colors ${
              active ? "bg-teal-700" : p.total === 0 ? "bg-brand-soft"
                : "bg-teal-600/40 group-hover:bg-teal-600/70"}`}
                 style={{ height: p.total === 0 ? "3px" : `${Math.max(5, (p.total / max) * 78)}%` }} />
            <span className={`text-[9px] ${active ? "font-bold text-brand-text" : "text-brand-mute"}`}>
              {p.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---- Calendar heatmap ------------------------------------------------------------------

export function CalendarHeatmap({ monthKey: key, byDay }: {
  monthKey: string; byDay: Map<string, number>;
}) {
  const days = daysInMonth(key);
  const firstDow = new Date(`${key}-01T00:00:00`).getDay(); // 0 = Sun
  const totals = Array.from({ length: days }, (_, i) =>
    byDay.get(`${key}-${String(i + 1).padStart(2, "0")}`) ?? 0);
  const nonZero = totals.filter((t) => t > 0).sort((a, b) => a - b);
  const q = (f: number): number =>
    nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.floor(f * nonZero.length))]! : 0;
  const t1 = q(0.5); const t2 = q(0.8);
  const shade = (t: number): string => {
    if (t === 0) return "bg-brand-soft text-brand-mute/60";
    if (t <= t1) return "bg-teal-100 text-teal-900";
    if (t <= t2) return "bg-teal-400/70 text-teal-950";
    return "bg-teal-700 text-white";
  };
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  return (
    <div>
      <div className="grid grid-cols-7 gap-1 text-center text-[9px] font-bold
                      uppercase text-brand-mute mb-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, i) => day === null
          ? <span key={`pad-${i}`} />
          : (
            <div key={day}
                 title={`${day} — ₹${fmtMoney(totals[day - 1] ?? 0, 0)}`}
                 className={`aspect-square rounded-md grid place-items-center
                             text-[10px] font-semibold tabular-nums ${shade(totals[day - 1] ?? 0)}`}>
              {day}
            </div>
          ))}
      </div>
    </div>
  );
}

// ---- Budget progress ---------------------------------------------------------------------

export function BudgetBar({ spent, limit }: { spent: number; limit: number }) {
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  const over = pct > 100;
  const color = over ? "bg-rose-600" : pct >= 85 ? "bg-amber-500" : "bg-teal-600";
  return (
    <div>
      <div className="flex justify-between text-[11px] tabular-nums mb-1">
        <span className={over ? "text-rose-700 font-semibold" : "text-brand-text"}>
          ₹{fmtMoney(spent, 0)} <span className="text-brand-mute">/ ₹{fmtMoney(limit, 0)}</span>
        </span>
        <span className={over ? "text-rose-700 font-bold" : "text-brand-mute"}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-2 rounded-full bg-brand-soft ring-1 ring-brand-border/50 overflow-hidden">
        <div className={`h-full rounded-full ${color}`}
             style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

// ---- Category select (grouped by root) ------------------------------------------------------

export function CategorySelect({ value, onChange, maps, allowNone = true, className = "" }: {
  value: number | null;
  onChange: (id: number | null) => void;
  maps: CategoryMaps;
  allowNone?: boolean;
  className?: string;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      className={`w-full rounded-lg ring-1 ring-brand-border bg-white px-2 py-1.5 text-sm
                  focus:outline-none focus:ring-2 focus:ring-teal-600/50 ${className}`}>
      {allowNone && <option value="">Uncategorised</option>}
      {maps.roots.map((root) => {
        const kids = maps.childrenOf.get(root.id) ?? [];
        return (
          <optgroup key={root.id} label={`${root.icon ?? ""} ${root.name}`.trim()}>
            <option value={root.id}>{root.name} (general)</option>
            {kids.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </optgroup>
        );
      })}
    </select>
  );
}

// ---- Misc ------------------------------------------------------------------------------------

export const catAmount = (v: string | number | null | undefined): string =>
  `₹${fmtMoney(num(v), 0)}`;

export function rootIcon(cat: Category | null): string {
  return cat?.icon ?? "📦";
}
