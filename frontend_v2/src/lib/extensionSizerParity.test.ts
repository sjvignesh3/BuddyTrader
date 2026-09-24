// -----------------------------------------------------------------------------
// Parity gate: the browser extension's position sizer (extension/shared/sizer.js)
// is a hand port of lib/sizing.ts + lib/journal.ts. Money decisions must not
// depend on which surface you sized a trade on, so this test runs both
// implementations over thousands of inputs and requires identical answers.
// A change to either side without the other fails here.
// -----------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { sizeByRisk } from "./sizing";
import { CAP_LIMITS, planAllocation, type JournalCtx } from "./journal";
import type { CapBucket } from "./journalApi";
// The extension file is a plain browser script (no module syntax). Load its
// source through Vite's typed `?raw` import and evaluate it against a sandbox
// `self`, exactly as a content script sees it — no Node typings needed, so
// `tsc -b` in the production build stays green.
import sizerSource from "../../../extension/shared/sizer.js?raw";

interface ExtSizer {
  CAP_LIMITS: Record<string, number>;
  sizeByRisk: (i: { capital: number | null; riskPct: number | null; entry: number | null; stop: number | null }) => ReturnType<typeof sizeByRisk>;
  allocation: (p: { capital: number; cap: CapBucket | null; entry: number | null; qty: number | null; heldValue: number }) => ReturnType<typeof planAllocation>;
}
const sandbox: { PlutusSizer?: ExtSizer } = {};
new Function("self", sizerSource)(sandbox);
const ext = sandbox.PlutusSizer as ExtSizer;

/** Small deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const NUMERIC_KEYS = [
  "riskPerShare", "stopDistancePct", "riskBudget", "qty", "deployed", "deployedPct",
  "riskAmount", "riskPctOfCapital", "remainingCapital", "maxAffordableQty",
] as const;

describe("extension sizer parity", () => {
  it("uses the same cap-bucket limits", () => {
    expect(ext.CAP_LIMITS).toEqual(CAP_LIMITS);
  });

  it("matches the web app's worked examples", () => {
    const s = ext.sizeByRisk({ capital: 300_000, riskPct: 1, entry: 450, stop: 430 });
    expect(s.qty).toBe(150);
    expect(s.deployed).toBe(67_500);
    expect(ext.sizeByRisk({ capital: 100_000, riskPct: 1, entry: 100, stop: 97 }).qty).toBe(333);
    expect(ext.sizeByRisk({ capital: 10_000, riskPct: 0.5, entry: 1000, stop: 900 }).problem).toBe("zero_qty");
    expect(ext.sizeByRisk({ capital: 100_000, riskPct: 1, entry: 100, stop: 100 }).problem).toBe("stop_not_below_entry");
  });

  it("agrees with sizeByRisk on 5 000 random inputs, including invalid ones", () => {
    const r = rng(20260924);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;
    for (let i = 0; i < 5000; i++) {
      const entry = pick([null, 0, -5, Math.round(r() * 5000 * 20) / 20 + 0.05]);
      const stop = entry && entry > 0 ? pick([null, 0, entry, entry * 1.1, Math.round(entry * (0.6 + r() * 0.39) * 20) / 20]) : pick([null, 10]);
      const input = {
        capital: pick([null, 0, -1, Math.round(r() * 5_000_000) + 1]),
        riskPct: pick([null, 0, -1, Math.round(r() * 300) / 100 + 0.05]),
        entry, stop,
      };
      const a = sizeByRisk(input);
      const b = ext.sizeByRisk(input);
      expect(b.problem, JSON.stringify(input)).toBe(a.problem);
      expect(b.exceedsCapital).toBe(a.exceedsCapital);
      for (const k of NUMERIC_KEYS) {
        if (a[k] === null) expect(b[k], `${k} ${JSON.stringify(input)}`).toBeNull();
        else expect(b[k], `${k} ${JSON.stringify(input)}`).toBeCloseTo(a[k] as number, 9);
      }
    }
  });

  it("agrees with planAllocation on 3 000 random plans", () => {
    const r = rng(7);
    const caps: (CapBucket | null)[] = [null, "Large", "Mid", "Small", "Micro"];
    for (let i = 0; i < 3000; i++) {
      const capital = Math.round(r() * 2_000_000) + 1000;
      const cap = caps[Math.floor(r() * caps.length)] ?? null;
      const entry = r() < 0.05 ? null : Math.round(r() * 4000 * 20) / 20 + 1;
      const qty = r() < 0.05 ? null : Math.floor(r() * 500);
      const heldValue = r() < 0.5 ? 0 : Math.round(r() * capital * 0.08);
      const ctx: JournalCtx = { capital, snaps: new Map(), openInvested: new Map([["TCS", heldValue]]) };
      const a = planAllocation({ symbol: "TCS", cap, buyPrice: entry, qty, ctx });
      const b = ext.allocation({ capital, cap, entry, qty, heldValue });
      for (const k of Object.keys(a) as (keyof typeof a)[]) {
        const av = a[k], bv = b[k];
        if (typeof av === "number") expect(bv, `${k}`).toBeCloseTo(av, 9);
        else expect(bv, `${k}`).toEqual(av);
      }
    }
  });
});
