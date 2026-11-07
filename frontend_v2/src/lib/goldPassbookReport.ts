// -----------------------------------------------------------------------------
// Passbook report — what each payment actually earned. Credited gold splits
// into four parts, each worked out per payment and only then summed:
//
//   exact           payment ÷ rate: the gold the money buys at that day's rate
//   weight round    credited weight − exact (0.0075988 → 0.008)
//   honest          benefit% × exact: what the scheme promises (inside the window)
//   benefit round   credited benefit − honest (0.000532 → 0.001)
//
// "rounding" = weight round + benefit round. The honest part is never rounded,
// so 7% of a day's total equals the sum of 7% of each payment.
//
// Rupee values use each payment's own rate, so "₹ gained" means "₹ of gold you
// got for free on the day you paid". Today's value adds gold price movement on
// top:  value − paid = price movement + honest + rounding  (exactly).
// -----------------------------------------------------------------------------
import { evaluatePayment, planPayments, type RoundupOptions } from "./goldRoundup";
import type { PassbookTxn } from "./grtPassbook";

export const WINDOW_DAYS = 120;

export interface TxnInsight {
  txn: PassbookTxn;
  /** Benefit applied to this payment (0 outside the benefit window). */
  benefitBp: number;
  exactG: number;
  creditedG: number;
  honestG: number;
  /** Credited minus exact-with-benefit. Negative = rounding cost you. */
  roundingG: number;
  /** Credited weight minus exact grams. */
  weightRoundG: number;
  /** Credited benefit minus the honest benefit. */
  benefitRoundG: number;
  honestRs: number;
  roundingRs: number;
  weightRoundRs: number;
  benefitRoundRs: number;
  /** Passbook weight and benefit match the rounding rule. */
  ruleMatch: boolean;
  /** Best amount at this payment's rate. */
  bestAmountPaise: number;
  /** ₹ of gold left on the table by not paying the best amount. */
  missedRs: number;
}

export interface GroupStats {
  key: string;
  label: string;
  payments: number;
  days: number;
  paidRs: number;
  exactG: number;
  creditedG: number;
  honestG: number;
  weightRoundG: number;
  benefitRoundG: number;
  honestRs: number;
  roundingRs: number;
  weightRoundRs: number;
  benefitRoundRs: number;
  missedRs: number;
}

export type Grouping = "day" | "week" | "month";

const DAY_MS = 86_400_000;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-06" → UTC midnight ms. */
export function dayMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}
export function msDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDays(day: string, n: number): string {
  return msDay(dayMs(day) + n * DAY_MS);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / DAY_MS);
}
export function fmtDay(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTH_NAMES[(m ?? 1) - 1]}`;
}

export const isCompleted = (t: PassbookTxn) => t.status === "" || /complet/i.test(t.status);

/** Per-payment insight. `windowStart` = first day of the benefit window. */
export function analyseTxns(
  txns: PassbookTxn[], o: RoundupOptions, windowStart: string, windowDays = WINDOW_DAYS,
): TxnInsight[] {
  const windowEnd = addDays(windowStart, windowDays);   // exclusive
  const planCache = new Map<string, ReturnType<typeof planPayments>>();
  return txns.filter(isCompleted).map((txn) => {
    const inWindow = txn.day >= windowStart && txn.day < windowEnd;
    const bp = inWindow ? o.benefitBp : 0;
    const exactG = txn.amountPaise / txn.ratePaise;
    const creditedG = txn.totalMg / 1000;
    const honestG = (exactG * bp) / 10000;
    const roundingG = creditedG - exactG - honestG;
    const weightRoundG = txn.weightMg / 1000 - exactG;
    const benefitRoundG = roundingG - weightRoundG;   // = credited benefit − honest
    const rateRs = txn.ratePaise / 100;
    const expect = evaluatePayment(txn.amountPaise, txn.ratePaise, bp);

    const ck = `${txn.ratePaise}|${bp}`;
    if (!planCache.has(ck)) planCache.set(ck, planPayments(txn.ratePaise, { ...o, benefitBp: bp, bufferPaise: 0 }));
    const best = planCache.get(ck)?.best;
    let missedRs = 0;
    if (best) {
      const atBestRatio = (best.totalG / best.amountPaise) * txn.amountPaise;
      missedRs = Math.max(0, (atBestRatio - creditedG) * rateRs);
      if (missedRs < 0.01) missedRs = 0;
    }
    return {
      txn, benefitBp: bp, exactG, creditedG, honestG, roundingG, weightRoundG, benefitRoundG,
      honestRs: honestG * rateRs, roundingRs: roundingG * rateRs,
      weightRoundRs: weightRoundG * rateRs, benefitRoundRs: benefitRoundG * rateRs,
      ruleMatch: expect.weightMg === txn.weightMg && expect.benefitMg === txn.benefitMg,
      bestAmountPaise: best?.amountPaise ?? txn.amountPaise,
      missedRs,
    };
  });
}

function groupKey(day: string, g: Grouping): { key: string; label: string } {
  if (g === "day") return { key: day, label: fmtDay(day) };
  if (g === "month") {
    const [y, m] = day.split("-");
    return { key: `${y}-${m}`, label: `${MONTH_NAMES[Number(m) - 1]} ${y}` };
  }
  const dow = (new Date(dayMs(day)).getUTCDay() + 6) % 7;   // Monday = 0
  const monday = addDays(day, -dow);
  return { key: monday, label: `${fmtDay(monday)} – ${fmtDay(addDays(monday, 6))}` };
}

function emptyStats(key: string, label: string): GroupStats {
  return {
    key, label, payments: 0, days: 0, paidRs: 0, exactG: 0, creditedG: 0,
    honestG: 0, weightRoundG: 0, benefitRoundG: 0,
    honestRs: 0, roundingRs: 0, weightRoundRs: 0, benefitRoundRs: 0, missedRs: 0,
  };
}

function add(s: GroupStats, i: TxnInsight) {
  s.payments++;
  s.paidRs += i.txn.amountPaise / 100;
  s.exactG += i.exactG;
  s.creditedG += i.creditedG;
  s.honestG += i.honestG;
  s.weightRoundG += i.weightRoundG;
  s.benefitRoundG += i.benefitRoundG;
  s.honestRs += i.honestRs;
  s.roundingRs += i.roundingRs;
  s.weightRoundRs += i.weightRoundRs;
  s.benefitRoundRs += i.benefitRoundRs;
  s.missedRs += i.missedRs;
}

export function groupInsights(ins: TxnInsight[], g: Grouping): GroupStats[] {
  const map = new Map<string, GroupStats & { _days: Set<string> }>();
  for (const i of ins) {
    const { key, label } = groupKey(i.txn.day, g);
    let s = map.get(key);
    if (!s) { s = { ...emptyStats(key, label), _days: new Set() }; map.set(key, s); }
    add(s, i);
    s._days.add(i.txn.day);
  }
  return [...map.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ _days, ...s }) => ({ ...s, days: _days.size }));
}

export function totalInsights(ins: TxnInsight[]): GroupStats {
  const s = emptyStats("all", "All");
  for (const i of ins) add(s, i);
  s.days = new Set(ins.map((i) => i.txn.day)).size;
  return s;
}

/** Shares of what was paid. */
export const pctOfPaid = (rs: number, s: GroupStats) => (s.paidRs > 0 ? rs / s.paidRs : 0);

export interface ValueToday {
  valueRs: number;
  gainRs: number;
  priceRs: number;
  honestRs: number;
  roundingRs: number;
  weightRoundRs: number;
  benefitRoundRs: number;
}

export function valueToday(ins: TxnInsight[], todayRatePaise: number): ValueToday {
  const today = todayRatePaise / 100;
  const t = totalInsights(ins);
  let priceRs = 0;
  for (const i of ins) priceRs += i.creditedG * (today - i.txn.ratePaise / 100);
  const valueRs = t.creditedG * today;
  return {
    valueRs, gainRs: valueRs - t.paidRs, priceRs,
    honestRs: t.honestRs, roundingRs: t.roundingRs,
    weightRoundRs: t.weightRoundRs, benefitRoundRs: t.benefitRoundRs,
  };
}

export interface Redemption {
  /** Extra cash paid at redemption: making charge + GST on gold and making. */
  costRs: number;
  netGainRs: number;
}

export function redemption(v: ValueToday, paidRs: number, makingPct: number, gstPct: number): Redemption {
  const making = v.valueRs * (makingPct / 100);
  const gst = (v.valueRs + making) * (gstPct / 100);
  const costRs = making + gst;
  return { costRs, netGainRs: v.valueRs - paidRs - costRs };
}

export interface WindowProgress {
  start: string;
  /** Last day of the window (inclusive). */
  end: string;
  elapsed: number;
  left: number;
  paidPerDay: number;
  projectedPaidRs: number;
  projectedHonestRs: number;
  projectedRoundingRs: number;
  /** Completed payments that fall outside the window (no benefit applied). */
  outside: number;
}

export function windowProgress(
  ins: TxnInsight[], start: string, asOf: string, windowDays = WINDOW_DAYS,
): WindowProgress {
  const end = addDays(start, windowDays - 1);
  const elapsed = Math.min(windowDays, Math.max(0, daysBetween(start, asOf) + 1));
  const left = windowDays - elapsed;
  const inside = ins.filter((i) => i.txn.day >= start && i.txn.day <= end);
  const t = totalInsights(inside);
  const paidPerDay = elapsed > 0 ? t.paidRs / elapsed : 0;
  const projectedPaidRs = paidPerDay * left;
  return {
    start, end, elapsed, left, paidPerDay, projectedPaidRs,
    projectedHonestRs: projectedPaidRs * pctOfPaid(t.honestRs, t),
    projectedRoundingRs: projectedPaidRs * pctOfPaid(t.roundingRs, t),
    outside: ins.length - inside.length,
  };
}
