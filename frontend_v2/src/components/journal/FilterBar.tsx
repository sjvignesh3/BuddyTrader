// -----------------------------------------------------------------------------
// Filter bar shared by the journal table tabs — free-text search, cap-bucket
// pills and optional tab-specific chips. Purely client-side filtering.
// -----------------------------------------------------------------------------
import { ReactNode } from "react";
import type { CapBucket } from "../../lib/journalApi";
import { CAP_ORDER } from "../../lib/journal";

export type CapFilter = CapBucket | "All";

const CAP_ACTIVE: Record<CapBucket, string> = {
  Large: "bg-sky-600 text-white ring-sky-600",
  Mid: "bg-violet-600 text-white ring-violet-600",
  Small: "bg-amber-500 text-white ring-amber-500",
  Micro: "bg-rose-500 text-white ring-rose-500",
};

/** Small toggle pill — used for cap buckets and tab-specific quick filters. */
export function FilterChip({ active, onClick, children, activeCls, count, title }: {
  active: boolean; onClick: () => void; children: ReactNode;
  activeCls?: string; count?: number; title?: string;
}) {
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={active}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs
                  font-semibold ring-1 transition-colors select-none
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/50
                  ${active
                    ? activeCls ?? "bg-teal-700 text-white ring-teal-700"
                    : "bg-white text-brand-mute ring-brand-border hover:text-brand-text hover:bg-brand-soft"}`}>
      {children}
      {count !== undefined && (
        <span className={`text-[10px] tabular-nums ${active ? "opacity-80" : "text-brand-mute/70"}`}>
          {count}
        </span>
      )}
    </button>
  );
}

export default function FilterBar({ search, onSearch, cap, onCap, children, shown, total,
                                    placeholder = "Search symbol, strategy, notes…" }: {
  search: string; onSearch: (v: string) => void;
  cap: CapFilter; onCap: (v: CapFilter) => void;
  /** Tab-specific extra chips. */
  children?: ReactNode;
  shown: number; total: number;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-3">
      {/* Search */}
      <div className="relative">
        <span aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2
                         text-brand-mute text-xs">🔍</span>
        <input
          value={search} onChange={(e) => onSearch(e.target.value)}
          placeholder={placeholder}
          className="w-60 max-w-full rounded-lg ring-1 ring-brand-border bg-white pl-8 pr-7
                     py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600/50
                     placeholder:text-brand-mute/60"
        />
        {search && (
          <button onClick={() => onSearch("")} aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 grid
                             place-items-center rounded text-brand-mute hover:text-brand-text
                             text-xs">✕</button>
        )}
      </div>
      {/* Cap buckets */}
      <div className="flex items-center gap-1">
        {(["All", ...CAP_ORDER] as CapFilter[]).map((c) => (
          <FilterChip key={c} active={cap === c}
                      onClick={() => onCap(cap === c ? "All" : c)}
                      activeCls={c === "All" ? undefined : CAP_ACTIVE[c as CapBucket]}>
            {c}
          </FilterChip>
        ))}
      </div>
      {children}
      {shown !== total && (
        <span className="ml-auto text-xs text-brand-mute tabular-nums">
          {shown} of {total}
        </span>
      )}
    </div>
  );
}
