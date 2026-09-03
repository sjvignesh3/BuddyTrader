// -----------------------------------------------------------------------------
// Opportunity Radar — the decision layer. Ranks the pool's best current
// setups (signal strength → fundamental quality → depth) into cards you can
// act on or throw into the comparison tray.
// -----------------------------------------------------------------------------
import type { StockRow } from "../lib/rows";
import { convictionOf, topOpportunities, whyLine } from "../lib/conviction";
import ScoreRing from "./ScoreRing";
import SignalBadge from "./SignalBadge";

const CONVICTION_STYLE: Record<string, string> = {
  PRIME: "bg-teal-700 text-white",
  STRONG: "bg-teal-100 text-teal-800",
  WATCH: "bg-amber-100 text-amber-800",
};

export default function OpportunityRadar({
  rows,
  compared,
  onToggleCompare,
  onOpen,
  heldSymbols,
}: {
  rows: StockRow[];
  compared: string[];
  onToggleCompare: (symbol: string) => void;
  onOpen: (symbol: string) => void;
  /** plain symbols with an open Trading Journal position — shows 💼 */
  heldSymbols?: Set<string>;
}) {
  const top = topOpportunities(rows, 4);
  if (top.length === 0) return null;

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="font-display text-lg font-semibold">Opportunity radar</h2>
        <span className="text-[11px] text-brand-mute">
          strongest signal → best fundamentals → deepest value
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {top.map((r, i) => {
          const conv = convictionOf(r)!;
          const inTray = compared.includes(r.symbol);
          return (
            <div key={r.symbol}
                 className="group relative rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card hover:shadow-pop transition-shadow px-4 pt-3.5 pb-3 cursor-pointer"
                 onClick={() => onOpen(r.symbol)}>
              {/* rank ribbon */}
              <span className="absolute -top-2 -left-1.5 font-display text-[26px] font-bold text-brand-border select-none">
                {i + 1}
              </span>
              <div className="flex items-start justify-between gap-2 pl-4">
                <div>
                  <div className="font-display text-base font-semibold leading-tight">
                    {r.symbol.replace(/\.(NS|BO)$/, "")}
                    {heldSymbols?.has(r.symbol.replace(/\.(NS|BO)$/i, "")) && (
                      <span title="Open position in your Trading Journal"
                            className="ml-1 text-[11px] align-middle">💼</span>
                    )}
                  </div>
                  <div className="text-[10px] text-brand-mute truncate max-w-[120px]">
                    {r.sector ?? "—"} · {r.cap ?? "—"}
                  </div>
                </div>
                <ScoreRing points={r.score} size={38} />
              </div>
              <div className="flex items-center gap-1.5 mt-2 pl-4">
                <span className={`px-2 py-0.5 rounded-full text-[9px] font-extrabold tracking-widest ${CONVICTION_STYLE[conv]}`}>
                  {conv}
                </span>
                <SignalBadge status={r.bestStatus} />
              </div>
              <div className="mt-2 pl-4 text-[11px] text-brand-mute leading-snug min-h-[30px]">
                {whyLine(r)}
              </div>
              <div className="flex items-center justify-between mt-1.5 pl-4">
                <span className="font-mono tabular-nums text-sm font-semibold">
                  ₹{r.close?.toLocaleString("en-IN", { minimumFractionDigits: 2 }) ?? "—"}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleCompare(r.symbol); }}
                  className={`text-[10px] font-semibold px-2 py-1 rounded-md transition-colors ${
                    inTray
                      ? "bg-brand-accent text-white"
                      : "bg-brand-soft ring-1 ring-brand-border text-brand-mute hover:text-brand-text"}`}
                >
                  {inTray ? "✓ In tray" : "+ Compare"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
