import { describe, expect, it } from "vitest";
import {
  benefitMg, cheapestForWeight, creditedMg, evaluatePayment, onRoundingEdge,
  planPayments, splitBudget, type RoundupOptions,
} from "./goldRoundup";

const P = (rupees: number) => Math.round(rupees * 100);
const OPTS: RoundupOptions = {
  benefitBp: 700, minPaise: P(100), bufferPaise: 0, wholeRupees: true, skipEdge: true,
};

describe("rounding matches the GRT passbook", () => {
  // [amount, rate, weight mg] — real rows, 31 Oct – 6 Nov 2026
  const rows: [number, number, number][] = [
    [109, 12730, 9], [109, 12775, 9], [109, 12800, 9], [110, 12825, 9],
    [101, 13385, 8], [100, 13150, 8],
  ];
  it.each(rows)("₹%d at ₹%d/g credits %d mg + 1 mg benefit", (amt, rate, mg) => {
    const r = evaluatePayment(P(amt), P(rate), 700);
    expect(r.weightMg).toBe(mg);
    expect(r.benefitMg).toBe(1);
  });

  it("sums 56 rows to the passbook total of 0.552 g", () => {
    const pays = [
      ...Array(34).fill([109, 12730]), ...Array(10).fill([109, 12775]),
      ...Array(3).fill([109, 12800]), [110, 12825],
      ...Array(6).fill([101, 13385]), ...Array(2).fill([100, 13150]),
    ] as [number, number][];
    const mg = pays.reduce((s, [a, r]) => {
      const w = creditedMg(P(a), P(r));
      return s + w + benefitMg(w, 700);
    }, 0);
    expect(pays).toHaveLength(56);
    expect(mg).toBe(552);
  });
});

describe("edges", () => {
  it("rounds 0.0085 g exactly up but flags it", () => {
    expect(creditedMg(P(105), P(14000))).toBe(8);   // 0.0075 → 0.008
    expect(onRoundingEdge(P(105), P(14000))).toBe(true);
    expect(onRoundingEdge(P(109), P(12730))).toBe(false);
  });
  it("drops a step one rupee below the best amount", () => {
    expect(creditedMg(P(108), P(12730))).toBe(8);
  });
  it("benefit vanishes below 8 mg", () => {
    expect(benefitMg(7, 700)).toBe(0);
    expect(benefitMg(8, 700)).toBe(1);
    expect(benefitMg(21, 700)).toBe(1);
    expect(benefitMg(22, 700)).toBe(2);
  });
  it("reports the rate a payment holds until", () => {
    const r = evaluatePayment(P(109), P(12730), 700);
    expect(r.holdsUntilPaise! / 100).toBeCloseTo(12823.52, 2);
    expect(creditedMg(P(109), r.holdsUntilPaise!)).toBe(9);
    expect(creditedMg(P(109), r.holdsUntilPaise! + 1)).toBe(8);
  });
});

describe("planPayments picks what was actually paid", () => {
  it.each([[12730, 109], [12800, 109], [12825, 110], [13150, 100], [13385, 101]])(
    "rate ₹%d → ₹%d", (rate, amt) => {
      expect(planPayments(P(rate), OPTS)!.best.amountPaise).toBe(P(amt));
    });
  it("skips an exact-edge amount when asked", () => {
    expect(planPayments(P(14000), OPTS)!.best.amountPaise).toBe(P(106));
    expect(planPayments(P(14000), { ...OPTS, skipEdge: false })!.best.amountPaise).toBe(P(105));
  });
  it("adds the safety buffer", () => {
    expect(cheapestForWeight(9, P(12730), { ...OPTS, bufferPaise: P(1) })).toBe(P(110));
  });
  it("respects the minimum payment", () => {
    for (const r of planPayments(P(9000), OPTS)!.options) expect(r.amountPaise).toBeGreaterThanOrEqual(P(100));
  });
  it("returns null for no rate", () => {
    expect(planPayments(0, OPTS)).toBeNull();
  });
});

describe("splitBudget", () => {
  it("₹5,000 at ₹12,730 → 45 payments of ₹109", () => {
    const best = planPayments(P(12730), OPTS)!.best;
    const s = splitBudget(best, P(5000), P(12730), 700);
    expect(s.payments).toBe(45);
    expect(s.spentPaise).toBe(P(4905));
    expect(s.creditedG).toBeCloseTo(0.45, 6);
    expect(s.creditedG).toBeGreaterThan(s.fairG);
    expect(s.fairG).toBeGreaterThan(s.directG);
  });
});
