// -----------------------------------------------------------------------------
// Shared journal UI primitives — modal, form fields, chips, markers.
// -----------------------------------------------------------------------------
import { ReactNode, useEffect, useState } from "react";
import type { AllocState } from "../../lib/journal";
import { CAP_LIMITS } from "../../lib/journal";
import type { CapBucket } from "../../lib/journalApi";

// ---- Modal ---------------------------------------------------------------------

export function Modal({ title, onClose, children, wide = false }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4"
         role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-brand-text/30 backdrop-blur-[2px]"
           onClick={onClose} />
      <div className={`relative w-full ${wide ? "max-w-2xl" : "max-w-lg"} rounded-2xl
                       bg-brand-panel ring-1 ring-brand-border shadow-pop p-5
                       max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display font-semibold text-lg">{title}</h2>
          <button onClick={onClose} aria-label="Close"
                  className="w-7 h-7 grid place-items-center rounded-lg text-brand-mute
                             hover:text-brand-text hover:bg-brand-soft">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** In-app confirmation — replaces window.confirm, which some embedded
 * browsers suppress (silently returning false, so nothing happens). */
export function ConfirmDialog({ title, message, confirmLabel = "Confirm",
                                danger = false, busy = false, onConfirm, onCancel }: {
  title: string; message: ReactNode; confirmLabel?: string;
  danger?: boolean; busy?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="text-sm text-brand-text/90 whitespace-pre-line">{message}</div>
      <div className="mt-5 flex justify-end gap-2">
        <GhostBtn onClick={onCancel}>Cancel</GhostBtn>
        <button onClick={onConfirm} disabled={busy}
          className={`px-4 py-1.5 rounded-lg text-white text-sm font-semibold shadow-card
                      disabled:opacity-50 ${danger
                        ? "bg-rose-600 hover:bg-rose-700"
                        : "bg-teal-700 hover:bg-teal-800"}`}>
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---- Sorting ----------------------------------------------------------------------

export interface SortState { key: string; dir: 1 | -1 }

/** Column sorting for the journal tables. `accessors` maps a column key to
 * the sortable value of an item; strings compare locale-wise, numbers
 * numerically, nulls always sink to the bottom. */
export function useSort<T>(accessors: Record<string, (x: T) => unknown>) {
  const [sort, setSort] = useState<SortState | null>(null);
  const toggle = (key: string) =>
    setSort((prev) => prev?.key === key
      ? (prev.dir === 1 ? { key, dir: -1 } : null)  // asc → desc → off
      : { key, dir: 1 });
  const apply = (items: T[]): T[] => {
    if (!sort) return items;
    const acc = accessors[sort.key];
    if (!acc) return items;
    return [...items].sort((a, b) => {
      const va = acc(a); const vb = acc(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * sort.dir;
      return String(va).localeCompare(String(vb)) * sort.dir;
    });
  };
  return { sort, toggle, apply };
}

// ---- Form fields ------------------------------------------------------------------

const inputCls =
  "w-full rounded-lg ring-1 ring-brand-border bg-white px-2.5 py-1.5 text-sm " +
  "focus:outline-none focus:ring-2 focus:ring-teal-600/50 placeholder:text-brand-mute/60";

export function Field({ label, children, span2 = false }: {
  label: string; children: ReactNode; span2?: boolean;
}) {
  return (
    <label className={`block ${span2 ? "sm:col-span-2" : ""}`}>
      <span className="block text-[11px] font-semibold uppercase tracking-wide
                       text-brand-mute mb-1">{label}</span>
      {children}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={inputCls} />;
}

/** Numeric input with an optional unit prefix (₹) and an invalid state —
 * red ring + tint while the typed value can't be parsed as a number. */
export function NumInput({ prefix, invalid = false, ...props }: {
  prefix?: string; invalid?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const ring = invalid
    ? "ring-rose-400 bg-rose-50/60 focus:ring-rose-500/60"
    : "ring-brand-border bg-white focus:ring-teal-600/50";
  return (
    <span className="relative block">
      {prefix && (
        <span aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2
                         text-brand-mute text-sm">{prefix}</span>
      )}
      <input {...props}
             aria-invalid={invalid || undefined}
             className={`w-full rounded-lg ring-1 px-2.5 py-1.5 text-sm tabular-nums
                         focus:outline-none focus:ring-2
                         placeholder:text-brand-mute/60 ${ring}
                         ${prefix ? "pl-7" : ""}`} />
    </span>
  );
}

/** Segmented pill picker — replaces native selects for short option lists.
 * `activeCls` lets an option carry its own selected colour (cap buckets,
 * action filters); unselected pills stay neutral. */
export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: {
  options: { value: T; label: ReactNode; activeCls?: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel}
         className="flex flex-wrap gap-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={active}
                  title={o.title} onClick={() => onChange(o.value)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ring-1
                              transition-colors select-none
                              focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/50
                              ${active
                                ? o.activeCls ?? "bg-teal-700 text-white ring-teal-700"
                                : "bg-white text-brand-mute ring-brand-border hover:text-brand-text hover:bg-brand-soft"}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Clickable suggestion chips under a free-text input. */
export function SuggestionChips({ options, current, onPick }: {
  options: string[]; current: string; onPick: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {options.map((s) => {
        const active = current.trim().toLowerCase() === s.toLowerCase();
        return (
          <button key={s} type="button" onClick={() => onPick(active ? "" : s)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium ring-1
                              transition-colors
                              ${active
                                ? "bg-teal-700 text-white ring-teal-700"
                                : "bg-brand-soft text-brand-mute ring-brand-border hover:text-brand-text"}`}>
            {s}
          </button>
        );
      })}
    </div>
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={2} {...props} className={inputCls} />;
}

export function PrimaryBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props}
      className={`px-4 py-1.5 rounded-lg bg-teal-700 text-white text-sm font-semibold
                  hover:bg-teal-800 disabled:opacity-50 shadow-card ${props.className ?? ""}`} />
  );
}

export function GhostBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium text-brand-mute
                  hover:text-brand-text hover:bg-brand-soft ring-1 ring-brand-border
                  bg-brand-panel ${props.className ?? ""}`} />
  );
}

// ---- Display chips ------------------------------------------------------------------

export const CAP_STYLES: Record<CapBucket, string> = {
  Large: "bg-sky-50 text-sky-800 ring-sky-200",
  Mid: "bg-violet-50 text-violet-800 ring-violet-200",
  Small: "bg-amber-50 text-amber-800 ring-amber-200",
  Micro: "bg-rose-50 text-rose-800 ring-rose-200",
};

export function CapChip({ cap }: { cap: CapBucket | null }) {
  if (!cap) return <span className="text-brand-mute">—</span>;
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold
                      ring-1 ${CAP_STYLES[cap]}`}>{cap}</span>
  );
}

/** Allocation-limit marker: green under 80% of the cap limit, amber close, red over. */
export function AllocMarker({ state, cap, totalPct }: {
  state: AllocState | null; cap: CapBucket | null; totalPct: number | null;
}) {
  if (!state || !cap || totalPct === null) return null;
  const limit = CAP_LIMITS[cap];
  const style = state === "over"
    ? "bg-rose-500"
    : state === "warn" ? "bg-amber-500" : "bg-teal-500";
  const title = state === "over"
    ? `OVER LIMIT — ${totalPct.toFixed(2)}% vs ${cap} cap limit ${limit}%`
    : state === "warn"
      ? `Near limit — ${totalPct.toFixed(2)}% of ${limit}% (${cap} cap)`
      : `Within limit — ${totalPct.toFixed(2)}% of ${limit}% (${cap} cap)`;
  return (
    <span title={title}
          className={`inline-block w-2 h-2 rounded-full align-middle ${style}`} />
  );
}

export function Pnl({ value, suffix = "", digits = 2 }: {
  value: number | null; suffix?: string; digits?: number;
}) {
  if (value === null) return <span className="text-brand-mute">—</span>;
  const cls = value > 0 ? "text-teal-700" : value < 0 ? "text-rose-700" : "text-brand-mute";
  const s = value.toLocaleString("en-IN", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  return <span className={`${cls} tabular-nums`}>{value > 0 ? "+" : ""}{s}{suffix}</span>;
}

// ---- Table shell -------------------------------------------------------------------

export function Th({ children, right = false, sortKey, sort, onSort }: {
  children?: ReactNode; right?: boolean;
  /** When set, the header is clickable and sorts by this key. */
  sortKey?: string; sort?: SortState | null; onSort?: (key: string) => void;
}) {
  const active = sortKey !== undefined && sort?.key === sortKey;
  const arrow = active ? (sort!.dir === 1 ? " ▲" : " ▼") : "";
  return (
    <th className={`px-2.5 py-2 text-[10px] font-bold uppercase tracking-wider
                    whitespace-nowrap sticky top-0 z-10 bg-brand-soft select-none
                    shadow-[0_1px_0_0_#e5e0d4]
                    ${active ? "text-brand-text" : "text-brand-mute"}
                    ${right ? "text-right" : "text-left"}
                    ${sortKey ? "cursor-pointer hover:text-brand-text" : ""}`}
        onClick={sortKey && onSort ? () => onSort(sortKey) : undefined}
        title={sortKey ? "Click to sort" : undefined}>
      {children}{arrow}
    </th>
  );
}

export function Td({ children, right = false, className = "" }: {
  children?: ReactNode; right?: boolean; className?: string;
}) {
  return (
    <td className={`px-2.5 py-1.5 whitespace-nowrap text-[13px] tabular-nums
                    ${right ? "text-right" : "text-left"} ${className}`}>
      {children}
    </td>
  );
}

export function TableShell({ children }: { children: ReactNode }) {
  // overflow-auto (both axes) + max-h make the sticky column headers float
  // while you scroll long tables — the header row never leaves the screen.
  return (
    <div className="rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card
                    overflow-auto max-h-[calc(100vh-220px)] min-h-[120px]">
      <table className="min-w-full border-separate border-spacing-0">{children}</table>
    </div>
  );
}

export function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card
                    p-10 text-center">
      <div className="text-3xl mb-2">📓</div>
      <p className="text-sm text-brand-mute mb-4">{text}</p>
      {action}
    </div>
  );
}

export function RowBtn({ onClick, title, children, danger = false }: {
  onClick: () => void; title: string; children: ReactNode; danger?: boolean;
}) {
  return (
    <button onClick={onClick} title={title}
      className={`w-6 h-6 grid place-items-center rounded text-xs
                  ${danger ? "text-rose-600 hover:bg-rose-50"
                           : "text-brand-mute hover:text-brand-text hover:bg-brand-soft"}`}>
      {children}
    </button>
  );
}
