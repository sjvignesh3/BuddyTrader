// -----------------------------------------------------------------------------
// Conviction ranking — a transparent, explainable ordering of opportunities:
// technical signal strength first, fundamental score second. Display-only
// (never persisted, never fed back into any computation).
// -----------------------------------------------------------------------------
import type { StockRow } from "./rows";

export type Conviction = "PRIME" | "STRONG" | "WATCH" | null;

const SIGNAL_WEIGHT: Record<string, number> = {
  BUY_ZONE: 3, OPPORTUNITY: 2, VALID: 1.5,
};

export function convictionOf(r: StockRow): Conviction {
  const sig = r.bestStatus ? SIGNAL_WEIGHT[r.bestStatus] ?? 0 : 0;
  const score = r.score ?? -1;
  if (sig >= 3 && score >= 8) return "PRIME";
  if (sig >= 3 || (sig >= 2 && score >= 8)) return "STRONG";
  if (sig >= 1.5 || score >= 8) return "WATCH";
  return null;
}

/** Sort key: signal weight desc, then funda score desc, then deeper value. */
export function rankValue(r: StockRow): number {
  const sig = r.bestStatus ? SIGNAL_WEIGHT[r.bestStatus] ?? 0 : 0;
  const score = (r.score ?? 0) / 11;
  const depth = Math.min(Math.max(r.belowDmaPct ?? 0, 0), 30) / 100;
  return sig * 10 + score * 5 + depth;
}

export function topOpportunities(rows: StockRow[], n = 4): StockRow[] {
  return rows
    .filter((r) => convictionOf(r) !== null)
    .sort((a, b) => rankValue(b) - rankValue(a))
    .slice(0, n);
}

/** One human line explaining WHY this row ranks — pulled from its data. */
export function whyLine(r: StockRow): string {
  const bits: string[] = [];
  if (r.bestStatus === "BUY_ZONE" && r.belowDmaPct !== null && r.belowDmaPct >= 14) {
    bits.push(`${r.belowDmaPct.toFixed(1)}% below 200 DMA`);
  } else if (r.bestStatus === "BUY_ZONE" && r.fromLowPct !== null && r.fromLowPct <= 0.5) {
    bits.push("at its 52-week low");
  } else if (r.bestStatus === "OPPORTUNITY" && r.belowDmaPct !== null && r.belowDmaPct >= 9) {
    bits.push(`${r.belowDmaPct.toFixed(1)}% under DMA`);
  } else if (r.bestStatus === "OPPORTUNITY" && r.fromLowPct !== null && r.fromLowPct <= 5) {
    bits.push(`${r.fromLowPct.toFixed(1)}% off the 52w low`);
  } else if (r.bestStatus === "VALID") {
    bits.push(`fresh 20% streak${r.daysSinceRally !== null ? ` ${r.daysSinceRally}d ago` : ""}`);
  }
  if ((r.score ?? 0) >= 8) bits.push(`fundamentals ${r.score}/11`);
  if (r.downFromAthPct !== null && r.downFromAthPct >= 30) {
    bits.push(`${r.downFromAthPct.toFixed(0)}% off ATH`);
  }
  return bits.slice(0, 2).join(" · ") || "on the radar";
}
