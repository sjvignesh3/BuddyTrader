// -----------------------------------------------------------------------------
// Symbol input for the journal forms, backed by the Universe. Suggestions
// come from the active stocks (symbol / name / sector), picking one also
// fills the cap bucket when the universe knows it. A symbol outside the
// universe is flagged so it can be added on the Universe page first — the
// universe is the single source of truth for what the journal tracks.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useStocks } from "../../hooks/usePlutus";
import type { Stock } from "../../lib/api";
import { marketOf } from "../../lib/market";
import { useMoney } from "../../lib/moneyContext";

const plain = (s: string) => s.replace(/\.(NS|BO)$/i, "").toUpperCase();

/** true when `symbol` is an active universe member (either spelling). */
export function useUniverseMembership(symbol: string) {
  const q = useStocks();
  const { market } = useMoney();   // a US journal only knows US tickers, and vice versa
  const key = plain(symbol.trim());
  const stock = useMemo(() =>
    key ? (q.data?.stocks ?? []).find(
      (s) => marketOf(s.symbol) === market && plain(s.symbol) === key) ?? null : null,
    [q.data, key, market]);
  return { stock, loaded: Boolean(q.data), inUniverse: stock !== null };
}

export default function SymbolPicker({ value, onChange, onPick, disabled, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  /** Called with the universe stock when a suggestion is chosen. */
  onPick?: (s: Stock) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const q = useStocks();
  const { market } = useMoney();
  const [open, setOpen] = useState(false);
  const key = plain(value.trim());
  const stocks = useMemo(
    () => (q.data?.stocks ?? []).filter((s) => marketOf(s.symbol) === market),
    [q.data, market]);
  const suggestions = useMemo(() => {
    if (!key) return [];
    return stocks
      .filter((s) => plain(s.symbol).includes(key) || (s.name ?? "").toUpperCase().includes(key)
        || (s.sector ?? "").toUpperCase().includes(key))
      .sort((a, b) => Number(!plain(a.symbol).startsWith(key)) - Number(!plain(b.symbol).startsWith(key)))
      .slice(0, 8);
  }, [stocks, key]);
  const exact = key ? stocks.find((s) => plain(s.symbol) === key) ?? null : null;

  const pick = (s: Stock) => {
    onChange(plain(s.symbol));
    onPick?.(s);
    setOpen(false);
  };

  return (
    <div className="relative">
      <input value={value} disabled={disabled} autoFocus={autoFocus} placeholder={market === "US" ? "NVDA" : "RELIANCE"}
             onChange={(e) => { onChange(e.target.value); setOpen(true); }}
             onFocus={() => setOpen(true)}
             onBlur={() => setTimeout(() => setOpen(false), 150)}
             onKeyDown={(e) => {
               if (e.key === "Enter" && open && suggestions[0] && !exact) { e.preventDefault(); pick(suggestions[0]); }
             }}
             style={{ textTransform: "uppercase" }}
             className={`w-full rounded-lg ring-1 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2
                         placeholder:text-brand-mute/60 disabled:opacity-60
                         ${key && q.data && !exact
                           ? "ring-amber-400 bg-amber-50/50 focus:ring-amber-500/50"
                           : "ring-brand-border bg-white focus:ring-teal-600/50"}`} />
      {open && !disabled && suggestions.length > 0 && !(exact && suggestions.length === 1) && (
        <div className="absolute z-40 mt-1 w-full rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-pop overflow-hidden">
          {suggestions.map((s) => (
            <button key={s.symbol} type="button"
                    onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-sm hover:bg-teal-50 text-left">
              <span className="font-semibold">{plain(s.symbol)}</span>
              <span className="text-[10px] text-brand-mute truncate ml-2">
                {[s.name, s.sector, s.cap_type_manual, (s.pools ?? []).join(" ")].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </div>
      )}
      {key && q.data && !exact && (
        <p className="mt-1 text-[11px] text-amber-700">
          Not in the universe.{" "}
          <Link to="/universe" className="underline" onMouseDown={(e) => e.stopPropagation()}>
            Add it to a pool
          </Link>{" "}
          first — the journal only tracks universe stocks.
        </p>
      )}
    </div>
  );
}
