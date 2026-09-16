// -----------------------------------------------------------------------------
// Journal domain math — capital-based allocation and derived table columns.
//
// Everything here is DISPLAY math: raw strings from the API are converted to
// Number for percentages/aggregates (precision is fine at portfolio scale).
// The cap-allocation rule (Fundamental Pointers doc):
//   Large < 5%, Mid < 3%, Small < 2%, Micro < 1.5% of capital per stock.
// -----------------------------------------------------------------------------

import type { Snapshot } from "./api";
import type { CapBucket, Opportunity, Trade, TradeDraft } from "./journalApi";

export const CAP_LIMITS: Record<CapBucket, number> = {
  Large: 5, Mid: 3, Small: 2, Micro: 1.5,
};

export const CAP_ORDER: CapBucket[] = ["Large", "Mid", "Small", "Micro"];

/** "Large Cap" / "large" / "LARGE CAP" → "Large". Unknown → null. */
export function normalizeCap(raw: string | null | undefined): CapBucket | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase().replace(/\s*cap$/, "");
  if (k === "large") return "Large";
  if (k === "mid" || k === "midcap") return "Mid";
  if (k === "small") return "Small";
  if (k === "micro") return "Micro";
  return null;
}

export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : v;
  return Number.isFinite(n) ? n : null;
}

export type AllocState = "ok" | "warn" | "over";

/** Marker state for a stock's total allocation % vs its cap-bucket limit. */
export function allocState(totalPct: number | null, cap: CapBucket | null): AllocState | null {
  if (totalPct === null || !cap) return null;
  const limit = CAP_LIMITS[cap];
  if (totalPct > limit) return "over";
  if (totalPct >= limit * 0.8) return "warn";
  return "ok";
}

/** How close an open trade is to its target: "hit" at/above target,
 * "near" within 10% below it, null otherwise (or no target/CMP). */
export type TargetZone = "hit" | "near" | null;

export function targetZone(remainingPct: number | null): TargetZone {
  if (remainingPct === null) return null;
  if (remainingPct <= 0) return "hit";
  if (remainingPct < 10) return "near";
  return null;
}

export function daysBetween(fromIso: string | null | undefined, toIso?: string | null): number | null {
  if (!fromIso) return null;
  const a = new Date(fromIso).getTime();
  const b = toIso ? new Date(toIso).getTime() : Date.now();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

// ---- Shared fetched-data context ----------------------------------------------

export interface JournalCtx {
  capital: number;
  /** latest snapshot per symbol */
  snaps: Map<string, Snapshot>;
  /** OPEN invested ₹ per symbol (sum of buy_price*qty) */
  openInvested: Map<string, number>;
}

export function buildOpenInvested(openTrades: Trade[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of openTrades) {
    const inv = (num(t.buy_price) ?? 0) * t.qty;
    m.set(t.symbol, (m.get(t.symbol) ?? 0) + inv);
  }
  return m;
}

/** Effective cap bucket: manual value on the row, else the snapshot's. */
export function effectiveCap(rowCap: CapBucket | null, snap?: Snapshot): CapBucket | null {
  return rowCap ?? normalizeCap((snap?.cap_bucket as string) ?? null);
}

function dayPct(snap?: Snapshot): number | null {
  if (!snap) return null;
  const nd = num(snap.price_change_nd_pct as string);
  if (nd !== null) return nd;
  const o = num(snap.open); const c = num(snap.close);
  return o && c ? ((c - o) / o) * 100 : null;
}

// ---- Live plan allocation (forms) ------------------------------------------------

/** What a planned buy does to a symbol's allocation, against its cap limit.
 * Everything is a share of CAPITAL — the same base the tables use. */
export interface PlanAllocation {
  capital: number;
  limitPct: number | null;   // per-stock cap-bucket limit
  limitValue: number | null; // ₹ that limit allows in one stock
  heldValue: number;         // ₹ already in OPEN lots of this symbol
  heldPct: number | null;
  addValue: number | null;   // ₹ this plan adds
  addPct: number | null;
  totalPct: number | null;
  state: AllocState | null;
  roomValue: number | null;  // ₹ still free under the limit after this plan
  maxQty: number | null;     // largest qty at this price that stays within the limit
  qtyDelta: number | null;   // maxQty − planned qty: + room left, − shares over
}

export function planAllocation({ symbol, cap, buyPrice, qty, ctx, excludeHeld = 0 }: {
  symbol: string;
  cap: CapBucket | null;
  buyPrice: number | null;
  qty: number | null;
  ctx: JournalCtx;
  /** ₹ of this symbol's OPEN value that the form itself owns — subtracted so
   * editing an existing lot doesn't count that lot twice. */
  excludeHeld?: number;
}): PlanAllocation {
  const capital = ctx.capital;
  const heldValue = Math.max(0, (ctx.openInvested.get(symbol) ?? 0) - excludeHeld);
  const addValue = buyPrice !== null && qty !== null ? buyPrice * qty : null;
  const pct = (v: number | null) =>
    v === null || !capital ? null : (v / capital) * 100;
  const heldPct = pct(heldValue);
  const addPct = pct(addValue);
  const totalPct = heldPct === null ? addPct
    : addPct === null ? heldPct : heldPct + addPct;
  const limitPct = cap ? CAP_LIMITS[cap] : null;
  const limitValue = limitPct !== null && capital ? (capital * limitPct) / 100 : null;
  const maxQty = limitValue !== null && buyPrice
    ? Math.max(0, Math.floor((limitValue - heldValue) / buyPrice)) : null;
  return {
    capital, limitPct, limitValue, heldValue, heldPct, addValue, addPct, totalPct,
    state: allocState(totalPct, cap),
    roomValue: limitValue === null ? null : limitValue - heldValue - (addValue ?? 0),
    maxQty,
    qtyDelta: maxQty !== null && qty !== null ? maxQty - qty : null,
  };
}

// ---- Opportunities -------------------------------------------------------------

export interface OppDerived {
  cap: CapBucket | null;
  ltp: number | null;
  dayPct: number | null;
  athFallPct: number | null;
  potentialPct: number | null;   // (target-buy)/buy
  potentialGain: number | null;  // (target-buy)*qty
  toTrigPct: number | null;      // (ltp-buy)/buy — distance above the trigger
  currentPct: number | null;     // existing OPEN allocation for symbol
  additionPct: number | null;    // this plan's buy value / capital
  totalPct: number | null;       // current + addition
  capitalNeeded: number | null;  // buy*qty
  totalExposure: number | null;  // invested + capitalNeeded
  marker: AllocState | null;
}

export function deriveOpportunity(o: Opportunity, ctx: JournalCtx): OppDerived {
  const snap = ctx.snaps.get(o.symbol);
  const cap = effectiveCap(o.cap_bucket, snap);
  const buy = num(o.buy_price);
  const target = num(o.target_price);
  const qty = o.qty ?? null;
  const ltp = num(snap?.close);
  const invested = ctx.openInvested.get(o.symbol) ?? 0;
  const capitalNeeded = buy !== null && qty ? buy * qty : null;
  const currentPct = ctx.capital ? (invested / ctx.capital) * 100 : null;
  const additionPct = capitalNeeded !== null && ctx.capital
    ? (capitalNeeded / ctx.capital) * 100 : null;
  const totalPct = additionPct !== null && currentPct !== null
    ? currentPct + additionPct : additionPct ?? currentPct;
  return {
    cap,
    ltp,
    dayPct: dayPct(snap),
    athFallPct: num(snap?.fall_from_ath_pct as string),
    potentialPct: buy && target ? ((target - buy) / buy) * 100 : null,
    potentialGain: buy !== null && target !== null && qty ? (target - buy) * qty : null,
    toTrigPct: buy && ltp !== null ? ((ltp - buy) / buy) * 100 : null,
    currentPct,
    additionPct,
    totalPct,
    capitalNeeded,
    totalExposure: capitalNeeded !== null ? invested + capitalNeeded : null,
    marker: allocState(totalPct, cap),
  };
}

// ---- Open trades ----------------------------------------------------------------

export interface OpenDerived {
  cap: CapBucket | null;
  buyValue: number;
  allocPct: number | null;        // this lot / capital
  symbolAllocPct: number | null;  // all OPEN lots of symbol / capital
  cmp: number | null;
  currentValue: number | null;
  gainAmt: number | null;
  gainPct: number | null;
  dayPct: number | null;
  remainingPct: number | null;    // (target-cmp)/cmp
  potentialPct: number | null;    // (target-buy)/buy
  potentialGain: number | null;   // (target-buy)*qty
  athFallPct: number | null;
  days: number | null;
  annualPct: number | null;
  marker: AllocState | null;
}

export function deriveOpenTrade(t: Trade, ctx: JournalCtx): OpenDerived {
  const snap = ctx.snaps.get(t.symbol);
  const cap = effectiveCap(t.cap_bucket, snap);
  const buy = num(t.buy_price) ?? 0;
  const target = num(t.target_price);
  const cmp = num(snap?.close);
  const buyValue = buy * t.qty;
  const currentValue = cmp !== null ? cmp * t.qty : null;
  const gainAmt = currentValue !== null ? currentValue - buyValue : null;
  const gainPct = gainAmt !== null && buyValue ? (gainAmt / buyValue) * 100 : null;
  const days = daysBetween(t.buy_date);
  const symbolInvested = ctx.openInvested.get(t.symbol) ?? buyValue;
  const symbolAllocPct = ctx.capital ? (symbolInvested / ctx.capital) * 100 : null;
  return {
    cap,
    buyValue,
    allocPct: ctx.capital ? (buyValue / ctx.capital) * 100 : null,
    symbolAllocPct,
    cmp,
    currentValue,
    gainAmt,
    gainPct,
    dayPct: dayPct(snap),
    remainingPct: target && cmp ? ((target - cmp) / cmp) * 100 : null,
    potentialPct: target && buy ? ((target - buy) / buy) * 100 : null,
    potentialGain: target !== null ? (target - buy) * t.qty : null,
    athFallPct: num(snap?.fall_from_ath_pct as string),
    days,
    annualPct: gainPct !== null && days ? (gainPct / days) * 365 : null,
    marker: allocState(symbolAllocPct, cap),
  };
}

// ---- Closed trades ---------------------------------------------------------------

export interface ClosedDerived {
  buyValue: number;
  sellValue: number | null;
  gain: number | null;
  days: number | null;
  gainPct: number | null;
  annualPct: number | null;
}

export function deriveClosedTrade(t: Trade): ClosedDerived {
  const buy = num(t.buy_price) ?? 0;
  const sell = num(t.sell_price);
  const buyValue = buy * t.qty;
  const sellValue = sell !== null ? sell * t.qty : null;
  const gain = sellValue !== null ? sellValue - buyValue : null;
  const days = daysBetween(t.buy_date, t.sell_date);
  const gainPct = gain !== null && buyValue ? (gain / buyValue) * 100 : null;
  return {
    buyValue, sellValue, gain, days, gainPct,
    annualPct: gainPct !== null && days ? (gainPct / days) * 365 : null,
  };
}

// ---- Portfolio -------------------------------------------------------------------

export interface HoldingRow {
  symbol: string;
  cap: CapBucket | null;
  qty: number;
  invested: number;
  allocPct: number | null;
  currentValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
  marker: AllocState | null;
  lots: number;
}

export interface CapSummaryRow {
  cap: CapBucket | "Unknown";
  stocks: number;
  invested: number;
  pctOfCapital: number | null;
  limitPct: number | null; // per-stock limit, shown for reference
}

export function buildPortfolio(openTrades: Trade[], ctx: JournalCtx): {
  holdings: HoldingRow[];
  capSummary: CapSummaryRow[];
  totals: { invested: number; currentValue: number; pnl: number;
            deployedPct: number | null };
} {
  const bySymbol = new Map<string, Trade[]>();
  for (const t of openTrades) {
    const arr = bySymbol.get(t.symbol) ?? [];
    arr.push(t);
    bySymbol.set(t.symbol, arr);
  }
  const holdings: HoldingRow[] = [];
  for (const [symbol, lots] of bySymbol) {
    const snap = ctx.snaps.get(symbol);
    const cap = effectiveCap(lots.find((l) => l.cap_bucket)?.cap_bucket ?? null, snap);
    const qty = lots.reduce((s, l) => s + l.qty, 0);
    const invested = lots.reduce((s, l) => s + (num(l.buy_price) ?? 0) * l.qty, 0);
    const cmp = num(snap?.close);
    const currentValue = cmp !== null ? cmp * qty : null;
    const pnl = currentValue !== null ? currentValue - invested : null;
    const allocPct = ctx.capital ? (invested / ctx.capital) * 100 : null;
    holdings.push({
      symbol, cap, qty, invested, allocPct, currentValue, pnl,
      pnlPct: pnl !== null && invested ? (pnl / invested) * 100 : null,
      marker: allocState(allocPct, cap),
      lots: lots.length,
    });
  }
  holdings.sort((a, b) => (b.invested - a.invested));

  const capAgg = new Map<string, { stocks: number; invested: number }>();
  for (const h of holdings) {
    const key = h.cap ?? "Unknown";
    const slot = capAgg.get(key) ?? { stocks: 0, invested: 0 };
    slot.stocks += 1;
    slot.invested += h.invested;
    capAgg.set(key, slot);
  }
  const capSummary: CapSummaryRow[] = [...CAP_ORDER, "Unknown" as const]
    .filter((c) => capAgg.has(c))
    .map((c) => {
      const s = capAgg.get(c)!;
      return {
        cap: c as CapSummaryRow["cap"],
        stocks: s.stocks,
        invested: s.invested,
        pctOfCapital: ctx.capital ? (s.invested / ctx.capital) * 100 : null,
        limitPct: c === "Unknown" ? null : CAP_LIMITS[c as CapBucket],
      };
    });

  const invested = holdings.reduce((s, h) => s + h.invested, 0);
  const currentValue = holdings.reduce((s, h) => s + (h.currentValue ?? h.invested), 0);
  return {
    holdings,
    capSummary,
    totals: {
      invested,
      currentValue,
      pnl: currentValue - invested,
      deployedPct: ctx.capital ? (invested / ctx.capital) * 100 : null,
    },
  };
}

// ---- ABCD averaging ---------------------------------------------------------------
//
// The initial lot in a stock is leg A. When CMP falls ABCD_DROP_PCT below the
// latest leg's entry the position becomes eligible for the next leg (B, C, D…),
// and that leg TARGETS the previous leg's entry. Nothing is persisted: the
// signal derives from the OPEN lots + CMP, so logging the new leg moves the
// reference and the signal clears on its own. Advisory only — the caller
// decides whether fundamentals justify adding.

/** Drop below the reference leg's entry that makes the next leg eligible. */
export const ABCD_DROP_PCT: Record<CapBucket, number> = {
  Large: 10, Mid: 10, Small: 15, Micro: 15,
};

/** Leg 0 → "A", 1 → "B" … past Z falls back to a number. */
export function legLabel(index: number): string {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : `#${index + 1}`;
}

/** "due": price has triggered and the cap limit leaves room · "blocked":
 * triggered but the position is already at/over its limit · null otherwise. */
export type AbcdZone = "due" | "blocked" | null;

export interface AbcdSignal {
  symbol: string;
  cap: CapBucket | null;
  /** OPEN lots, oldest first — leg A is legs[0]. */
  legs: Trade[];
  /** Letter of the leg that would be added next ("B" when only A is held). */
  nextLeg: string;
  /** The reference lot: latest leg by buy date (then id). */
  ref: Trade;
  refLeg: string;
  refEntry: number;
  /** Threshold for this cap bucket; null when the bucket is unknown. */
  thresholdPct: number | null;
  /** refEntry × (1 − threshold) — the suggested buy trigger. */
  triggerPrice: number | null;
  /** Previous leg's entry — the next leg's target. */
  targetPrice: number;
  cmp: number | null;
  /** How far CMP sits below the reference entry (positive = below). */
  fallPct: number | null;
  /** (cmp − trigger) / cmp — further fall needed; ≤ 0 means triggered. */
  toTriggerPct: number | null;
  triggered: boolean;
  /** Shares the cap limit still allows at the trigger price (null: unknown). */
  maxQty: number | null;
  roomValue: number | null;
  /** Reference-leg qty, capped to what the limit allows. */
  suggestedQty: number | null;
  zone: AbcdZone;
}

function lotOrder(a: Trade, b: Trade): number {
  return a.buy_date.localeCompare(b.buy_date) || a.id - b.id;
}

/** ABCD signal for one symbol's OPEN lots. Returns null with no open lots. */
export function deriveAbcd(
  openLots: Trade[],
  ctx: JournalCtx,
  thresholds: Record<CapBucket, number> = ABCD_DROP_PCT,
): AbcdSignal | null {
  const legs = openLots.filter((t) => t.status === "OPEN").sort(lotOrder);
  const ref = legs[legs.length - 1];
  if (!ref) return null;
  const symbol = ref.symbol;
  const snap = ctx.snaps.get(symbol);
  const cap = effectiveCap(legs.find((l) => l.cap_bucket)?.cap_bucket ?? null, snap);
  const refEntry = num(ref.buy_price) ?? 0;
  const cmp = num(snap?.close);
  const thresholdPct = cap ? thresholds[cap] : null;
  const triggerPrice = thresholdPct !== null && refEntry
    ? refEntry * (1 - thresholdPct / 100) : null;
  const fallPct = cmp !== null && refEntry ? ((refEntry - cmp) / refEntry) * 100 : null;
  const toTriggerPct = triggerPrice !== null && cmp
    ? ((cmp - triggerPrice) / cmp) * 100 : null;
  const triggered = fallPct !== null && thresholdPct !== null && fallPct >= thresholdPct;

  // Room under the cap limit, priced at the trigger (what a GTT would fill at).
  const alloc = planAllocation({ symbol, cap, buyPrice: triggerPrice, qty: null, ctx });
  const maxQty = alloc.maxQty;
  const suggestedQty = maxQty === null ? ref.qty : Math.min(ref.qty, maxQty);
  const zone: AbcdZone = !triggered ? null
    : maxQty === 0 ? "blocked" : "due";

  return {
    symbol, cap, legs,
    nextLeg: legLabel(legs.length),
    ref, refLeg: legLabel(legs.length - 1), refEntry,
    thresholdPct, triggerPrice, targetPrice: refEntry,
    cmp, fallPct, toTriggerPct, triggered,
    maxQty, roomValue: alloc.roomValue,
    suggestedQty: suggestedQty > 0 ? suggestedQty : null,
    zone,
  };
}

/** One signal per held symbol. CLOSED rows are ignored. */
export function buildAbcdSignals(
  trades: Trade[],
  ctx: JournalCtx,
  thresholds: Record<CapBucket, number> = ABCD_DROP_PCT,
): Map<string, AbcdSignal> {
  const bySymbol = new Map<string, Trade[]>();
  for (const t of trades) {
    if (t.status !== "OPEN") continue;
    (bySymbol.get(t.symbol) ?? bySymbol.set(t.symbol, []).get(t.symbol)!).push(t);
  }
  const out = new Map<string, AbcdSignal>();
  for (const [symbol, lots] of bySymbol) {
    const sig = deriveAbcd(lots, ctx, thresholds);
    if (sig) out.set(symbol, sig);
  }
  return out;
}

const money2 = (v: number) => (Math.round(v * 100) / 100).toString();

/** Prefill for the next leg's trade form. Buy price is the CMP once the
 * trigger has fired (an instant buy fills there), else the trigger itself
 * (a GTT waits for it). Target = the previous leg's entry. */
export function abcdLegDraft(sig: AbcdSignal): TradeDraft {
  const fired = sig.triggered && sig.cmp !== null;
  const price = fired ? sig.cmp! : sig.triggerPrice;
  return {
    symbol: sig.symbol,
    cap_bucket: sig.legs.find((l) => l.cap_bucket)?.cap_bucket ?? null,
    order_type: fired ? "Instant" : "GTT",
    buy_price: price !== null ? money2(price) : undefined,
    qty: sig.suggestedQty ?? undefined,
    strategy: "ABCD",
    target_price: money2(sig.targetPrice),
    comments: `Leg ${sig.nextLeg} — averaging below leg ${sig.refLeg} entry ₹${money2(sig.refEntry)}`,
  };
}
