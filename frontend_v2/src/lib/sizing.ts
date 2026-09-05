// -----------------------------------------------------------------------------
// Position Sizer domain math — pure functions, no I/O, no UI.
//
// Answers "given my capital, risk tolerance, entry, stop and the Plutus cap
// allocation rules, how much should I buy?" The allocation rule itself is
// NOT re-implemented here: every limit check goes through lib/journal.ts
// (CAP_LIMITS / planAllocation / allocState) so the sizer and the journal
// can never disagree about what "over the limit" means.
//
// Money contract: inputs are Numbers parsed from the API's strings for
// display math only — nothing here is written back as a monetary fact.
// Invalid inputs return an explicit `problem` instead of misleading zeros.
// -----------------------------------------------------------------------------
import type { Snapshot } from "./api";
import type { CapBucket, Trade } from "./journalApi";
import {
  CAP_LIMITS, allocState, num, planAllocation,
  type AllocState, type JournalCtx, type PlanAllocation,
} from "./journal";

// ---- Core risk-based sizing -----------------------------------------------------

export interface SizingInput {
  capital: number | null;
  riskPct: number | null;   // % of capital risked on this one trade
  entry: number | null;
  stop: number | null;
}

export type SizingProblem =
  | "capital" | "risk" | "entry" | "stop" | "stop_not_below_entry" | "zero_qty";

export interface Sizing {
  problem: SizingProblem | null;
  /** Human explanation of the problem — null when the sizing is valid. */
  message: string | null;
  riskPerShare: number | null;      // entry − stop
  stopDistancePct: number | null;   // (entry − stop) / entry × 100
  riskBudget: number | null;        // capital × risk%
  qty: number;                      // floor(riskBudget ÷ riskPerShare); 0 when invalid
  deployed: number;                 // qty × entry
  deployedPct: number | null;       // deployed / capital × 100
  riskAmount: number;               // qty × riskPerShare (≤ riskBudget)
  riskPctOfCapital: number | null;
  remainingCapital: number | null;  // capital − deployed
  exceedsCapital: boolean;          // deployed > capital — flagged, never hidden
  maxAffordableQty: number | null;  // floor(capital ÷ entry)
}

const EMPTY: Sizing = {
  problem: null, message: null, riskPerShare: null, stopDistancePct: null,
  riskBudget: null, qty: 0, deployed: 0, deployedPct: null, riskAmount: 0,
  riskPctOfCapital: null, remainingCapital: null, exceedsCapital: false,
  maxAffordableQty: null,
};

const rupees = (n: number): string => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** qty = floor((capital × risk%) ÷ (entry − stop)). Every invalid scenario
 * is named explicitly — the UI never has to guess why qty is 0. */
export function sizeByRisk(i: SizingInput): Sizing {
  const { capital, riskPct, entry, stop } = i;
  if (capital === null || !(capital > 0)) {
    return { ...EMPTY, problem: "capital", message: "Capital must be greater than zero." };
  }
  if (riskPct === null || !(riskPct > 0)) {
    return { ...EMPTY, problem: "risk", message: "Risk per trade must be greater than 0%." };
  }
  const riskBudget = (capital * riskPct) / 100;
  if (entry === null || !(entry > 0)) {
    return { ...EMPTY, riskBudget, problem: "entry", message: "Entry price must be greater than zero." };
  }
  if (stop === null || !(stop > 0)) {
    return { ...EMPTY, riskBudget, problem: "stop", message: "Stop price must be greater than zero." };
  }
  if (stop >= entry) {
    return {
      ...EMPTY, riskBudget, problem: "stop_not_below_entry",
      message: `Stop (₹${stop}) must be below entry (₹${entry}) — a long trade has no risk to size otherwise.`,
    };
  }
  const riskPerShare = entry - stop;
  const stopDistancePct = (riskPerShare / entry) * 100;
  const qty = Math.floor(riskBudget / riskPerShare);
  const maxAffordableQty = Math.floor(capital / entry);
  if (qty <= 0) {
    return {
      ...EMPTY, riskBudget, riskPerShare, stopDistancePct, maxAffordableQty,
      problem: "zero_qty",
      message: `Risk budget ${rupees(riskBudget)} is smaller than the ${rupees(riskPerShare)} risked per share — widen the risk %, tighten the stop, or skip the trade.`,
    };
  }
  const deployed = qty * entry;
  const riskAmount = qty * riskPerShare;
  return {
    problem: null, message: null,
    riskPerShare, stopDistancePct, riskBudget, qty, deployed,
    deployedPct: (deployed / capital) * 100,
    riskAmount,
    riskPctOfCapital: (riskAmount / capital) * 100,
    remainingCapital: capital - deployed,
    exceedsCapital: deployed > capital,
    maxAffordableQty,
  };
}

/** Risk on an arbitrary qty at this entry/stop (for a hand-edited qty). */
export function riskFor(qty: number | null, entry: number | null, stop: number | null): number | null {
  if (qty === null || entry === null || stop === null || !(qty > 0) || stop >= entry) return null;
  return (entry - stop) * qty;
}

// ---- Allocation guard (the journal rule, explained in ₹) ----------------------------

export interface AllocationGuard extends PlanAllocation {
  cap: CapBucket | null;
  totalValue: number | null;   // held + this plan
  excessValue: number | null;  // ₹ over the limit (0 when within)
}

/** Existing allocation + proposed position vs the cap-bucket limit. Wraps the
 * journal's planAllocation so the verdict is identical to the journal forms'. */
export function allocationGuard(p: {
  symbol: string; cap: CapBucket | null; entry: number | null; qty: number | null;
  ctx: JournalCtx;
}): AllocationGuard {
  const a = planAllocation({
    symbol: p.symbol, cap: p.cap, buyPrice: p.entry, qty: p.qty, ctx: p.ctx,
  });
  const totalValue = a.addValue === null ? (a.heldValue || null) : a.heldValue + a.addValue;
  const excessValue = a.limitValue !== null && totalValue !== null
    ? Math.max(0, totalValue - a.limitValue) : null;
  return { ...a, cap: p.cap, totalValue, excessValue };
}

// ---- Reward / R-multiple planner ------------------------------------------------------

export interface TargetRow {
  label: string;           // T1, T2, …
  price: number;
  gainPerShare: number;    // price − entry
  totalGain: number;       // gainPerShare × qty
  gainPct: number;         // gainPerShare / entry × 100
  rMultiple: number | null; // gainPerShare ÷ (entry − stop)
  valid: boolean;          // price above entry
}

export function planTargets(
  entry: number | null, stop: number | null, qty: number, targets: (number | null)[],
): TargetRow[] {
  if (entry === null || !(entry > 0)) return [];
  const riskPerShare = stop !== null && stop < entry ? entry - stop : null;
  return targets
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => t !== null && t > 0)
    .map(({ t, idx }) => {
      const price = t as number;
      const gainPerShare = price - entry;
      return {
        label: `T${idx + 1}`,
        price,
        gainPerShare,
        totalGain: gainPerShare * Math.max(0, qty),
        gainPct: (gainPerShare / entry) * 100,
        rMultiple: riskPerShare ? gainPerShare / riskPerShare : null,
        valid: price > entry,
      };
    });
}

// ---- GTT / entry ladder ---------------------------------------------------------------

export interface LadderTranche { trigger: number | null; qty: number | null }

export interface LadderRow {
  index: number;            // 1-based tranche number
  trigger: number;
  qty: number;
  capital: number;          // trigger × qty
  cumQty: number;
  cumCapital: number;
  cumAvg: number;           // blended average after this tranche
  cumPct: number | null;    // cumCapital / capital × 100 (this ladder alone)
  totalPct: number | null;  // (held + cumCapital) / capital × 100
  state: AllocState | null; // vs the cap limit, including what is already held
  riskAtStop: number | null; // (cumAvg − stop) × cumQty when stop is below avg
}

export interface LadderPlan {
  rows: LadderRow[];
  totalQty: number;
  totalCapital: number;
  avgPrice: number | null;
  totalPct: number | null;  // held + whole ladder
  state: AllocState | null;
  roomValue: number | null; // ₹ left under the limit after the whole ladder
}

export function buildLadder(p: {
  tranches: LadderTranche[]; capital: number | null; heldValue: number;
  cap: CapBucket | null; stop: number | null;
}): LadderPlan {
  const capital = p.capital && p.capital > 0 ? p.capital : null;
  const limitPct = p.cap ? capLimitPct(p.cap) : null;
  const limitValue = limitPct !== null && capital ? (capital * limitPct) / 100 : null;
  const pct = (v: number) => (capital ? (v / capital) * 100 : null);

  const rows: LadderRow[] = [];
  let cumQty = 0; let cumCapital = 0; let index = 0;
  for (const t of p.tranches) {
    if (t.trigger === null || t.qty === null || !(t.trigger > 0) || !(t.qty > 0)) continue;
    index += 1;
    const cap = t.trigger * t.qty;
    cumQty += t.qty; cumCapital += cap;
    const cumAvg = cumCapital / cumQty;
    const totalPct = pct(p.heldValue + cumCapital);
    rows.push({
      index, trigger: t.trigger, qty: t.qty, capital: cap, cumQty, cumCapital, cumAvg,
      cumPct: pct(cumCapital), totalPct,
      state: allocState(totalPct, p.cap),
      riskAtStop: p.stop !== null && p.stop < cumAvg ? (cumAvg - p.stop) * cumQty : null,
    });
  }
  const totalPct = rows.length ? pct(p.heldValue + cumCapital) : null;
  return {
    rows, totalQty: cumQty, totalCapital: cumCapital,
    avgPrice: cumQty ? cumCapital / cumQty : null,
    totalPct, state: allocState(totalPct, p.cap),
    roomValue: limitValue === null ? null : limitValue - p.heldValue - cumCapital,
  };
}

/** Split a sized qty evenly across n tranches (remainder to the first). */
export function splitQty(qty: number, n: number): number[] {
  if (!(qty > 0) || !(n > 0)) return [];
  const base = Math.floor(qty / n);
  const rem = qty - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

// ---- Suggested entry levels (only from data that exists) ------------------------------

export interface SuggestedLevel {
  key: string;
  label: string;
  price: number | null;   // null = the underlying data is unavailable
  hint: string;
}

/** Levels the Market Analysis tool already reasons about, as ₹ prices. A
 * level is emitted with price=null when its source field is missing, so the
 * UI can say "unavailable" instead of inventing one. */
export function suggestLevels(snap: Snapshot | undefined): SuggestedLevel[] {
  const close = num(snap?.close);
  const dma = num(snap?.dma_200);
  const low52 = num(snap?.low_52w as string | null | undefined);
  const rallyLow = snap?.has_valid_20pct_rally ? num(snap?.last_rally_low as string) : null;
  return [
    { key: "cmp", label: "CMP", price: close, hint: "latest close" },
    { key: "dma", label: "200 DMA", price: dma, hint: dma === null ? "needs more price history" : "the envelope's centre line" },
    { key: "opp", label: "Opportunity band", price: dma === null ? null : dma * 0.91,
      hint: dma === null ? "needs the 200 DMA" : "9% below the 200 DMA" },
    { key: "buy", label: "Buy zone", price: dma === null ? null : dma * 0.86,
      hint: dma === null ? "needs the 200 DMA" : "14% below the 200 DMA" },
    { key: "rally", label: "Rally re-entry low", price: rallyLow,
      hint: rallyLow === null ? "no valid 20% rally on record" : "low of the last 20% rally" },
    { key: "low52", label: "52-week low", price: low52, hint: low52 === null ? "unavailable" : "deepest point of the year" },
  ];
}

// ---- Averaging-down simulator -----------------------------------------------------------

export interface ExistingPosition {
  qty: number;
  avg: number;        // blended buy price across open lots
  invested: number;   // qty × avg
  lots: number;
  stop: number | null; // the tightest stop among lots that have one
}

export function existingPosition(openTrades: Trade[], symbol: string): ExistingPosition | null {
  const lots = openTrades.filter((t) => t.symbol === symbol && t.status === "OPEN");
  if (!lots.length) return null;
  const qty = lots.reduce((s, t) => s + t.qty, 0);
  const invested = lots.reduce((s, t) => s + (num(t.buy_price) ?? 0) * t.qty, 0);
  const stops = lots.map((t) => num(t.stop_price)).filter((s): s is number => s !== null);
  return {
    qty, invested, avg: qty ? invested / qty : 0, lots: lots.length,
    stop: stops.length ? Math.max(...stops) : null,
  };
}

export interface Averaging {
  existingQty: number; existingAvg: number; existingValue: number;
  addQty: number; addPrice: number; addValue: number;
  newQty: number; newAvg: number; totalValue: number;
  avgChangePct: number;          // (newAvg − existingAvg) / existingAvg × 100
  newAllocPct: number | null;    // totalValue / capital
  state: AllocState | null;
  riskAtStop: number | null;     // (newAvg − stop) × newQty; 0 when stop ≥ newAvg
  riskPctOfCapital: number | null;
}

export function averageDown(p: {
  existing: ExistingPosition | null; addQty: number | null; addPrice: number | null;
  stop: number | null; capital: number | null; cap: CapBucket | null;
}): Averaging | null {
  const { existing } = p;
  if (!existing || p.addQty === null || p.addPrice === null || !(p.addQty > 0) || !(p.addPrice > 0)) {
    return null;
  }
  const addValue = p.addQty * p.addPrice;
  const newQty = existing.qty + p.addQty;
  const totalValue = existing.invested + addValue;
  const newAvg = totalValue / newQty;
  const capital = p.capital && p.capital > 0 ? p.capital : null;
  const newAllocPct = capital ? (totalValue / capital) * 100 : null;
  const riskAtStop = p.stop === null ? null : Math.max(0, newAvg - p.stop) * newQty;
  return {
    existingQty: existing.qty, existingAvg: existing.avg, existingValue: existing.invested,
    addQty: p.addQty, addPrice: p.addPrice, addValue,
    newQty, newAvg, totalValue,
    avgChangePct: existing.avg ? ((newAvg - existing.avg) / existing.avg) * 100 : 0,
    newAllocPct, state: allocState(newAllocPct, p.cap),
    riskAtStop,
    riskPctOfCapital: riskAtStop !== null && capital ? (riskAtStop / capital) * 100 : null,
  };
}

// ---- Position heat ------------------------------------------------------------------------

export interface LotRisk {
  symbol: string;
  qty: number;
  stop: number;
  basis: number;             // price the risk is measured from
  basisSource: "cmp" | "buy";
  risk: number;              // max(0, basis − stop) × qty
}

export interface PortfolioHeat {
  lots: LotRisk[];
  openRisk: number;              // Σ risk of open lots that carry a stop
  openRiskPct: number | null;    // of capital
  lotsWithStop: number;
  lotsWithoutStop: number;
  symbolsWithoutStop: string[];  // exposure whose risk is unknown
  newRisk: number;               // the proposed trade's ₹ risk
  combinedRisk: number;          // openRisk + newRisk
  combinedPct: number | null;    // of capital
  newShare: number | null;       // newRisk / combinedRisk × 100
}

/** Aggregate open risk from open lots that have a stop. Risk is measured
 * from the CMP when a snapshot exists (what you'd lose from here), else
 * from the buy price. Lots without a stop are counted, not guessed. */
export function portfolioHeat(p: {
  openTrades: Trade[]; snaps: Map<string, Snapshot>; capital: number | null; newRisk: number;
}): PortfolioHeat {
  const lots: LotRisk[] = [];
  const noStop = new Set<string>();
  let lotsWithoutStop = 0;
  for (const t of p.openTrades) {
    const stop = num(t.stop_price);
    if (stop === null) { lotsWithoutStop += 1; noStop.add(t.symbol); continue; }
    const cmp = num(p.snaps.get(t.symbol)?.close);
    const buy = num(t.buy_price) ?? 0;
    const basis = cmp ?? buy;
    lots.push({
      symbol: t.symbol, qty: t.qty, stop, basis,
      basisSource: cmp !== null ? "cmp" : "buy",
      risk: Math.max(0, basis - stop) * t.qty,
    });
  }
  const openRisk = lots.reduce((s, l) => s + l.risk, 0);
  const capital = p.capital && p.capital > 0 ? p.capital : null;
  const newRisk = Math.max(0, p.newRisk);
  const combinedRisk = openRisk + newRisk;
  return {
    lots, openRisk,
    openRiskPct: capital ? (openRisk / capital) * 100 : null,
    lotsWithStop: lots.length, lotsWithoutStop,
    symbolsWithoutStop: [...noStop].sort(),
    newRisk, combinedRisk,
    combinedPct: capital ? (combinedRisk / capital) * 100 : null,
    newShare: combinedRisk > 0 ? (newRisk / combinedRisk) * 100 : null,
  };
}

// ---- helpers -------------------------------------------------------------------------------

export function capLimitPct(cap: CapBucket): number {
  return CAP_LIMITS[cap];
}

/** One-line plan description for notes / opportunity conversion. */
export function planSummary(p: {
  entry: number; stop: number; qty: number; riskPct: number; riskAmount: number;
  targets: TargetRow[];
}): string {
  const t = p.targets.filter((x) => x.valid)
    .map((x) => `${x.label} ₹${x.price}${x.rMultiple !== null ? ` (${x.rMultiple.toFixed(1)}R)` : ""}`)
    .join(", ");
  return `Sized at ${p.riskPct}% risk: ${p.qty} × ₹${p.entry}, stop ₹${p.stop} `
    + `(${rupees(p.riskAmount)} at risk)${t ? `. Targets: ${t}` : ""}.`;
}
