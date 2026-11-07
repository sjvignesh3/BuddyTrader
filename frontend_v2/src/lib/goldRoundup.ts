// -----------------------------------------------------------------------------
// Gold Round-Up — payment sizing for a gold savings plan that credits weight
// to 3 decimals (1 mg) and rounds half up, with a % benefit rounded the same
// way. Observed on GRT Insta Gold: all 56 passbook rows (31 Oct – 6 Nov 2026)
// match  weight = round_half_up(amount / rate, 0.001 g)  and
//        benefit = round_half_up(benefit% × weight, 0.001 g).
//
// Everything is integer paise and integer milligrams, so no float rounding can
// move a payment across an edge. Pure functions only — the page renders them.
// -----------------------------------------------------------------------------

export interface RoundupOptions {
  /** Benefit in basis points (7% = 700). */
  benefitBp: number;
  /** Smallest payment the plan accepts, in paise. */
  minPaise: number;
  /** Extra paise added on top of the cheapest amount, to survive a rate tick. */
  bufferPaise: number;
  /** Only whole-rupee amounts. */
  wholeRupees: boolean;
  /** Skip amounts that land exactly on x.xxx5 g — the plan may round those down. */
  skipEdge: boolean;
}

export interface PaymentResult {
  amountPaise: number;
  /** Credited weight, mg (0.001 g). */
  weightMg: number;
  /** Credited benefit, mg. */
  benefitMg: number;
  /** Exact grams the money buys at the rate, unrounded. */
  exactG: number;
  /** Weight + benefit, grams. */
  totalG: number;
  /** What an exact (unrounded) scheme would credit: exact × (1 + benefit). */
  fairG: number;
  /** Rupees paid per credited gram. */
  costPerG: number;
  /** How much cheaper than the day's rate, as a fraction (0.15 = 15%). */
  discount: number;
  /** Extra gold over the exact scheme, as a fraction. */
  edge: number;
  /** Highest rate (paise) at which this amount still credits weightMg. */
  holdsUntilPaise: number | null;
  /** True when amount / rate sits exactly on a rounding edge. */
  onEdge: boolean;
}

/** Credited weight in mg: amount / rate in grams, rounded half up to 1 mg. */
export function creditedMg(amountPaise: number, ratePaise: number): number {
  return Math.floor((2000 * amountPaise + ratePaise) / (2 * ratePaise));
}

/** True when 1000 × amount / rate is exactly k + 0.5. */
export function onRoundingEdge(amountPaise: number, ratePaise: number): boolean {
  const twice = 2000 * amountPaise;
  return twice % ratePaise === 0 && (twice / ratePaise) % 2 === 1;
}

/** Benefit in mg: benefitBp/10000 of the credited weight, rounded half up. */
export function benefitMg(weightMg: number, benefitBp: number): number {
  return Math.floor((2 * benefitBp * weightMg + 10000) / 20000);
}

export function evaluatePayment(amountPaise: number, ratePaise: number, benefitBp: number): PaymentResult {
  const weightMg = creditedMg(amountPaise, ratePaise);
  const bMg = benefitMg(weightMg, benefitBp);
  const exactG = amountPaise / ratePaise;
  const totalG = (weightMg + bMg) / 1000;
  const fairG = exactG * (1 + benefitBp / 10000);
  // Still credits weightMg while 2000·amount > (2·weightMg − 1)·rate.
  const holdsUntilPaise = weightMg > 0
    ? Math.ceil((2000 * amountPaise) / (2 * weightMg - 1)) - 1
    : null;
  return {
    amountPaise, weightMg, benefitMg: bMg, exactG, totalG, fairG,
    costPerG: totalG > 0 ? amountPaise / 100 / totalG : Infinity,
    discount: totalG > 0 ? 1 - amountPaise / totalG / ratePaise : 0,
    edge: fairG > 0 ? totalG / fairG - 1 : 0,
    holdsUntilPaise,
    onEdge: onRoundingEdge(amountPaise, ratePaise),
  };
}

/** Cheapest payment (paise) that credits at least `mg`, buffer included. */
export function cheapestForWeight(mg: number, ratePaise: number, o: RoundupOptions): number {
  const step = o.wholeRupees ? 100 : 1;
  let a = Math.ceil(((2 * mg - 1) * ratePaise) / 2000);
  a = Math.ceil(Math.max(a, o.minPaise) / step) * step;
  while (creditedMg(a, ratePaise) < mg || (o.skipEdge && onRoundingEdge(a, ratePaise))) a += step;
  return a + o.bufferPaise;
}

export interface RoundupPlan {
  best: PaymentResult;
  /** Cheapest payment for each credited weight, ascending by amount. */
  options: PaymentResult[];
}

/** Every useful payment up to `maxPaise`, and the one with the most gold per rupee. */
export function planPayments(ratePaise: number, o: RoundupOptions, maxPaise = 500_000): RoundupPlan | null {
  if (!(ratePaise > 0)) return null;
  const seen = new Set<number>();
  const options: PaymentResult[] = [];
  for (let mg = 1; mg <= 1000; mg++) {
    const a = cheapestForWeight(mg, ratePaise, o);
    if (a > maxPaise) break;
    if (seen.has(a)) continue;
    seen.add(a);
    const r = evaluatePayment(a, ratePaise, o.benefitBp);
    if (r.totalG > 0) options.push(r);
  }
  const first = options[0];
  if (!first) return null;
  // Most gold per paisa; ties go to the smaller payment (options are ascending).
  const best = options.reduce((m, r) =>
    r.totalG * m.amountPaise > m.totalG * r.amountPaise + 1e-12 ? r : m, first);
  return { best, options };
}

/** The n best-value payments, re-sorted by amount. */
export function topOptions(plan: RoundupPlan, n: number): PaymentResult[] {
  return [...plan.options]
    .sort((a, b) => b.totalG / b.amountPaise - a.totalG / a.amountPaise)
    .slice(0, n)
    .sort((a, b) => a.amountPaise - b.amountPaise);
}

export interface BudgetSplit {
  payments: number;
  spentPaise: number;
  leftoverPaise: number;
  /** Grams if the spent money bought gold directly at the rate. */
  directG: number;
  /** Grams from an exact scheme with the benefit. */
  fairG: number;
  /** Grams credited by repeating the best payment. */
  creditedG: number;
}

export function splitBudget(best: PaymentResult, budgetPaise: number, ratePaise: number, benefitBp: number): BudgetSplit {
  const payments = Math.max(0, Math.floor(budgetPaise / best.amountPaise));
  const spentPaise = payments * best.amountPaise;
  const directG = spentPaise / ratePaise;
  return {
    payments, spentPaise, leftoverPaise: budgetPaise - spentPaise,
    directG, fairG: directG * (1 + benefitBp / 10000),
    creditedG: payments * best.totalG,
  };
}
