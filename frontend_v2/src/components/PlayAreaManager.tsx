// -----------------------------------------------------------------------------
// PlayArea watchlist manager — search the synced universe, add/remove
// symbols. The list lives in this browser (localStorage); every symbol's
// data still comes from the nightly synced DB, and its signals from the
// latest pool scan that covered it.
// -----------------------------------------------------------------------------
import { useMemo, useRef, useState } from "react";
import type { Stock } from "../lib/api";

export default function PlayAreaManager({
  universe,
  watchlist,
  onChange,
}: {
  universe: Stock[];
  watchlist: string[];
  onChange: (symbols: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inList = useMemo(() => new Set(watchlist), [watchlist]);

  const suggestions = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return universe
      .filter((s) => !inList.has(s.symbol) &&
        (s.symbol.toUpperCase().includes(q) ||
         (s.name ?? "").toUpperCase().includes(q)))
      .slice(0, 8);
  }, [query, universe, inList]);

  const add = (symbol: string) => {
    onChange([...watchlist, symbol]);
    setQuery("");
    inputRef.current?.focus();
  };
  const remove = (symbol: string) =>
    onChange(watchlist.filter((s) => s !== symbol));

  return (
    <div className="rounded-xl ring-1 ring-brand-border bg-brand-panel/40 px-4 py-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
          ⚡ Watchlist · {watchlist.length} symbol{watchlist.length === 1 ? "" : "s"}
        </span>
        <span className="text-[10px] text-brand-mute">
          saved in this browser · data from the synced universe
        </span>
      </div>

      <div className="relative max-w-sm">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Add a stock — type symbol or name…"
          className="w-full bg-brand-bg ring-1 ring-brand-border rounded-md px-3 py-1.5 text-sm focus:ring-brand-accent/50 outline-none"
        />
        {open && suggestions.length > 0 && (
          <div className="absolute z-20 mt-1 w-full rounded-md ring-1 ring-brand-border bg-brand-panel shadow-xl overflow-hidden">
            {suggestions.map((s) => (
              <button
                key={s.symbol}
                onMouseDown={(e) => { e.preventDefault(); add(s.symbol); }}
                className="w-full flex items-center justify-between px-3 py-1.5 text-sm hover:bg-brand-accent/10 text-left"
              >
                <span className="font-semibold">{s.symbol.replace(/\.(NS|BO)$/, "")}</span>
                <span className="text-[10px] text-brand-mute truncate ml-2">
                  {s.sector ?? ""} · {(s.pools ?? []).join(" ")}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {watchlist.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {watchlist.map((sym) => (
            <span key={sym}
                  className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-md bg-brand-bg ring-1 ring-brand-border text-xs font-mono">
              {sym.replace(/\.(NS|BO)$/, "")}
              <button
                onClick={() => remove(sym)}
                title={`Remove ${sym}`}
                className="w-4 h-4 grid place-items-center rounded hover:bg-red-500/20 hover:text-red-400 text-brand-mute"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-xs text-brand-mute">
          Your tactical bucket is empty — add any stock from the universe to
          track it here with the full rally view.
        </div>
      )}
    </div>
  );
}
