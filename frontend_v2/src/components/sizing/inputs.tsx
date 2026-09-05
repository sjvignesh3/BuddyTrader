// -----------------------------------------------------------------------------
// Position Sizer inputs — stock autocomplete over the Plutus universe and the
// trade-input card (capital · risk % · entry · stop · qty override). Values
// stay strings while typing (journal form convention); the page parses them.
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from "react";
import type { Stock } from "../../lib/api";
import type { CapBucket } from "../../lib/journalApi";
import { CAP_LIMITS } from "../../lib/journal";
import { fmtMoney } from "../../lib/money";
import { CAP_STYLES, Field, NumInput, Segmented } from "../journal/ui";

export const plain = (s: string): string => s.replace(/\.(NS|BO)$/i, "");

// ---- Stock autocomplete ----------------------------------------------------------

export function StockPicker({ value, stocks, onPick }: {
  value: string;
  stocks: Stock[];
  onPick: (symbol: string) => void;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setText(value); }, [value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const starts: Stock[] = []; const contains: Stock[] = [];
    for (const s of stocks) {
      const sym = plain(s.symbol).toLowerCase();
      if (sym.startsWith(q)) starts.push(s);
      else if (sym.includes(q) || (s.name ?? "").toLowerCase().includes(q)) contains.push(s);
      if (starts.length >= 8) break;
    }
    return [...starts, ...contains].slice(0, 8);
  }, [text, stocks]);

  const pick = (sym: string) => {
    const s = plain(sym.trim().toUpperCase());
    if (!s) return;
    setText(s); setOpen(false); onPick(s);
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); pick(matches[hi]?.symbol ?? text); }
          else if (e.key === "Escape") setOpen(false);
        }}
        placeholder="Search symbol or name…"
        autoComplete="off" spellCheck={false}
        style={{ textTransform: "uppercase" }}
        className="w-full rounded-lg ring-1 ring-brand-border bg-white px-2.5 py-2 text-sm font-semibold
                   focus:outline-none focus:ring-2 focus:ring-teal-600/50 placeholder:text-brand-mute/60
                   placeholder:normal-case placeholder:font-normal"
        aria-label="Stock symbol" aria-autocomplete="list" aria-expanded={open}
      />
      {open && matches.length > 0 && (
        <ul role="listbox"
            className="absolute z-20 mt-1 w-full max-h-64 overflow-auto rounded-xl bg-brand-panel
                       ring-1 ring-brand-border shadow-pop py-1">
          {matches.map((s, i) => (
            <li key={s.symbol} role="option" aria-selected={i === hi}
                onMouseDown={(e) => { e.preventDefault(); pick(s.symbol); }}
                onMouseEnter={() => setHi(i)}
                className={`px-3 py-1.5 cursor-pointer flex items-center justify-between gap-2 text-sm ${
                  i === hi ? "bg-teal-50 text-teal-900" : "hover:bg-brand-soft"}`}>
              <span className="font-semibold">{plain(s.symbol)}</span>
              <span className="text-[11px] text-brand-mute truncate max-w-[60%]">{s.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Trade inputs ----------------------------------------------------------------

export interface TradeForm {
  capital: string;
  riskPct: string;
  entry: string;
  stop: string;
  qty: string;        // "" = use the risk-sized qty
  cap: CapBucket | "";
}

const RISK_PRESETS = ["0.5", "1", "1.5", "2"];

export function TradeInputs({ f, set, journalCapital, autoCap, sizedQty, entryFromCmp }: {
  f: TradeForm;
  set: <K extends keyof TradeForm>(k: K, v: TradeForm[K]) => void;
  /** Capital from journal settings — shown so a local override is obvious. */
  journalCapital: number;
  /** Cap bucket the snapshot reports, shown as the "Auto" label. */
  autoCap: CapBucket | null;
  /** Risk-sized quantity — shown as the qty placeholder. */
  sizedQty: number;
  /** True while entry mirrors the CMP (not typed by hand). */
  entryFromCmp: boolean;
}) {
  const bad = (s: string) => s.trim() !== "" && !(Number(s.replace(/,/g, "")) > 0);
  const stopBad = bad(f.stop) || (Number(f.stop) > 0 && Number(f.entry) > 0 && Number(f.stop) >= Number(f.entry));
  const capOverridden = f.capital.trim() !== "" && Number(f.capital) !== journalCapital;

  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Capital" span2>
        <NumInput prefix="₹" inputMode="numeric" value={f.capital} invalid={bad(f.capital)}
                  onChange={(e) => set("capital", e.target.value)} />
        <span className="block mt-1 text-[10px] text-brand-mute">
          {capOverridden
            ? <>Journal capital is ₹{fmtMoney(journalCapital, 0)} — this plan uses your override.</>
            : <>From the journal — edit here to size against a different base.</>}
        </span>
      </Field>
      <Field label="Risk per trade %">
        <NumInput suffix="%" inputMode="decimal" value={f.riskPct} invalid={bad(f.riskPct)}
                  onChange={(e) => set("riskPct", e.target.value)} />
        <div className="flex gap-1 mt-1.5">
          {RISK_PRESETS.map((r) => (
            <button key={r} type="button" onClick={() => set("riskPct", r)}
                    className={`px-2 py-0.5 rounded-full text-[10px] font-medium ring-1 ${
                      f.riskPct === r ? "bg-teal-700 text-white ring-teal-700"
                        : "bg-brand-soft text-brand-mute ring-brand-border hover:text-brand-text"}`}>
              {r}%
            </button>
          ))}
        </div>
      </Field>
      <Field label="Cap bucket">
        <Segmented ariaLabel="Cap bucket"
                   options={[
                     { value: "" as const, label: autoCap ? `Auto · ${autoCap}` : "Auto",
                       title: "Use the bucket from market data" },
                     ...(Object.keys(CAP_LIMITS) as CapBucket[]).map((c) => ({
                       value: c, label: c, activeCls: `${CAP_STYLES[c]} ring-1`,
                       title: `${c} cap — limit ${CAP_LIMITS[c]}% of capital per stock`,
                     })),
                   ]}
                   value={f.cap} onChange={(v) => set("cap", v)} />
      </Field>
      <Field label={entryFromCmp ? "Entry (CMP)" : "Entry"}>
        <NumInput prefix="₹" inputMode="decimal" placeholder="0.00" value={f.entry}
                  invalid={bad(f.entry)} onChange={(e) => set("entry", e.target.value)} />
      </Field>
      <Field label="Stop loss">
        <NumInput prefix="₹" inputMode="decimal" placeholder="0.00" value={f.stop}
                  invalid={stopBad} onChange={(e) => set("stop", e.target.value)} />
      </Field>
      <Field label="Qty override" span2>
        <NumInput inputMode="numeric" value={f.qty}
                  placeholder={sizedQty > 0 ? `${sizedQty} (risk-sized)` : "risk-sized"}
                  invalid={f.qty.trim() !== "" && !(Number.isInteger(Number(f.qty)) && Number(f.qty) > 0)}
                  onChange={(e) => set("qty", e.target.value)} />
        <span className="block mt-1 text-[10px] text-brand-mute">
          Leave blank to use the risk-sized quantity. Type a number to see what a different size does.
        </span>
      </Field>
    </div>
  );
}
