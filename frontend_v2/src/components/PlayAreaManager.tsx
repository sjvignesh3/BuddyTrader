// -----------------------------------------------------------------------------
// PlayArea watchlist manager — search the synced universe, add/remove
// symbols, and FETCH data on demand for symbols the DB hasn't seen yet.
// The fetch runs on the local FastAPI (/api/admin/sync: yfinance prices +
// Screener fundamentals/ratios + a re-scan); on the read-only prod API the
// button degrades to "fills on the next daily sync".
// -----------------------------------------------------------------------------
import { useMemo, useRef, useState } from "react";
import type { Stock } from "../lib/api";
import { api } from "../lib/api";

export default function PlayAreaManager({
  universe,
  watchlist,
  pendingSymbols,
  fetchingSymbols,
  onChange,
  onFetchStarted,
}: {
  universe: Stock[];
  watchlist: string[];
  /** symbols with no snapshot in the DB yet */
  pendingSymbols: string[];
  /** symbols currently being fetched on demand */
  fetchingSymbols: string[];
  onChange: (symbols: string[]) => void;
  onFetchStarted: (symbols: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inList = useMemo(() => new Set(watchlist), [watchlist]);
  const pending = useMemo(() => new Set(pendingSymbols), [pendingSymbols]);
  const fetching = useMemo(() => new Set(fetchingSymbols), [fetchingSymbols]);

  const suggestions = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return universe
      .filter((s) => !inList.has(s.symbol) &&
        (s.symbol.toUpperCase().includes(q) ||
         (s.name ?? "").toUpperCase().includes(q)))
      .slice(0, 8);
  }, [query, universe, inList]);

  const startFetch = async (symbols: string[]) => {
    try {
      const res = await api.adminSync(symbols);
      onFetchStarted(res.started);
      setFetchNote(
        res.started.length
          ? `Fetching ${res.started.map((s) => s.replace(/\.(NS|BO)$/, "")).join(", ")} — prices (yfinance) + fundamentals (screener.in). Rows appear automatically.`
          : "Already fetching…");
    } catch {
      setFetchNote(
        "On-demand fetch is only available on the local API — this symbol fills on the next daily sync.");
    }
  };

  const add = (symbol: string) => {
    onChange([...watchlist, symbol]);
    setQuery("");
    inputRef.current?.focus();
  };
  const remove = (symbol: string) =>
    onChange(watchlist.filter((s) => s !== symbol));

  /** "tcs" → the universe's "TCS.NS" when known, else "TCS.NS" by convention;
   * a full "TCS.NS"/"XYZ.BO" passes through; garbage → null. */
  const normalizeToken = (raw: string): string | null => {
    const t = raw.trim().toUpperCase().replace(/\s+/g, "");
    if (!t) return null;
    if (/^[A-Z0-9&\-]{1,20}\.(NS|BO)$/.test(t)) return t;
    if (!/^[A-Z0-9&\-]{1,20}$/.test(t)) return null;
    const hit = universe.find((s) => s.symbol.replace(/\.(NS|BO)$/, "") === t);
    return hit ? hit.symbol : `${t}.NS`;
  };

  /** Bulk add — accepts comma / semicolon / newline separated symbols. */
  const addMany = (raw: string) => {
    const resolved: string[] = [];
    const invalid: string[] = [];
    let dupes = 0;
    for (const tok of raw.split(/[,;\n]+/)) {
      if (!tok.trim()) continue;
      const sym = normalizeToken(tok);
      if (!sym) { invalid.push(tok.trim()); continue; }
      if (inList.has(sym) || resolved.includes(sym)) { dupes++; continue; }
      resolved.push(sym);
    }
    if (resolved.length) onChange([...watchlist, ...resolved]);
    setQuery("");
    inputRef.current?.focus();
    const parts: string[] = [];
    if (resolved.length) {
      parts.push(`Added ${resolved.map((s) => s.replace(/\.(NS|BO)$/, "")).join(", ")}.`);
    }
    if (dupes) parts.push(`${dupes} already in the list.`);
    if (invalid.length) parts.push(`Skipped (not a symbol): ${invalid.join(", ")}.`);
    setFetchNote(parts.length ? parts.join(" ") : null);
  };

  const isMulti = query.includes(",") || query.includes(";");
  const multiPreview = useMemo(() => {
    if (!isMulti) return [];
    return [...new Set(query.split(/[,;]+/)
      .map((t) => normalizeToken(t))
      .filter((s): s is string => Boolean(s))
      .map((s) => s.replace(/\.(NS|BO)$/, "")))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, universe]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (isMulti) addMany(query);
    else if (suggestions.length > 0) add(suggestions[0]!.symbol);
    else if (normalizeToken(query)) addMany(query); // unknown single symbol
  };

  return (
    <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3.5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display font-semibold text-sm">⚡ Play Area watchlist</span>
        <span className="text-[11px] text-brand-mute">
          {watchlist.length} symbol{watchlist.length === 1 ? "" : "s"} · saved in this browser
        </span>
        {pendingSymbols.length > 0 && (
          <button
            onClick={() => startFetch(pendingSymbols)}
            className="ml-auto text-[11px] font-bold px-3 py-1.5 rounded-lg bg-brand-accent text-white hover:opacity-90 transition-opacity"
          >
            ⤓ Fetch data for {pendingSymbols.length} new symbol{pendingSymbols.length > 1 ? "s" : ""}
          </button>
        )}
      </div>

      <div className="relative max-w-md">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKeyDown}
          placeholder="Add stocks — symbol, company name, or a comma-separated list…"
          className="w-full bg-brand-soft ring-1 ring-brand-border rounded-xl px-3.5 py-2 text-sm focus:ring-2 focus:ring-brand-accent/40 outline-none placeholder:text-brand-mute"
        />
        {open && isMulti && (
          <div className="absolute z-30 mt-1.5 w-full rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-pop overflow-hidden">
            <button
              onMouseDown={(e) => { e.preventDefault(); addMany(query); }}
              disabled={multiPreview.length === 0}
              className="w-full px-3.5 py-2.5 text-sm text-left hover:bg-teal-50 disabled:opacity-60"
            >
              {multiPreview.length > 0 ? (
                <>
                  <span className="font-semibold text-brand-accent">
                    ⏎ Add {multiPreview.length} symbol{multiPreview.length > 1 ? "s" : ""}
                  </span>
                  <span className="block text-[11px] text-brand-mute truncate mt-0.5">
                    {multiPreview.join(", ")}
                  </span>
                </>
              ) : (
                <span className="text-brand-mute text-xs">
                  Type symbols separated by commas, e.g. TCS, INFY, WIPRO
                </span>
              )}
            </button>
          </div>
        )}
        {open && !isMulti && suggestions.length > 0 && (
          <div className="absolute z-30 mt-1.5 w-full rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-pop overflow-hidden">
            {suggestions.map((s) => (
              <button
                key={s.symbol}
                onMouseDown={(e) => { e.preventDefault(); add(s.symbol); }}
                className="w-full flex items-center justify-between px-3.5 py-2 text-sm hover:bg-teal-50 text-left"
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
          {watchlist.map((sym) => {
            const isPending = pending.has(sym);
            const isFetching = fetching.has(sym);
            return (
              <span key={sym}
                    className={`inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-lg text-xs font-mono ring-1 ${
                      isFetching ? "bg-sky-50 ring-sky-200 text-sky-800"
                        : isPending ? "bg-amber-50 ring-amber-200 text-amber-800"
                          : "bg-brand-soft ring-brand-border"}`}>
                {sym.replace(/\.(NS|BO)$/, "")}
                {isFetching && <span className="text-[9px] animate-pulse">fetching…</span>}
                {isPending && !isFetching && <span className="text-[9px]">no data</span>}
                <button
                  onClick={() => remove(sym)}
                  title={`Remove ${sym}`}
                  className="w-4 h-4 grid place-items-center rounded hover:bg-rose-100 hover:text-rose-600 text-brand-mute"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <div className="text-xs text-brand-mute">
          Your tactical bucket is empty — add any stock from the universe to
          track it with the full rally view and fundamental score.
        </div>
      )}

      {fetchNote && (
        <div className="text-[11px] text-brand-mute bg-brand-soft ring-1 ring-brand-border rounded-lg px-3 py-1.5">
          {fetchNote}
        </div>
      )}
    </div>
  );
}
