import { describe, expect, it } from "vitest";
import type { Snapshot } from "./api";
import type { Trade } from "./journalApi";
import type { JournalCtx } from "./journal";
import { buildOpenInvested } from "./journal";
import {
  allocationGuard, averageDown, buildLadder, existingPosition, planSummary,
  planTargets, portfolioHeat, riskFor, sizeByRisk, splitQty, suggestLevels,
} from "./sizing";

const trade = (over: Partial<Trade>): Trade => ({
  id: 1, opportunity_id: null, order_type: "GTT", cap_bucket: null, symbol: "TCS",
  buy_date: "2026-08-01", buy_price: "100", qty: 10, strategy: null, target_price: null,
  stop_price: null, status: "OPEN", close_label: null, sell_date: null, sell_price: null,
  comments: null, risk_notes: null, ...over,
});

const snap = (symbol: string, close: string, extra: Partial<Snapshot> = {}): Snapshot => ({
  symbol, snapshot_date: "2026-09-04", open: close, high: close, low: close, close,
  adj_close: close, volume: 0, ...extra,
});

const ctxOf = (capital: number, open: Trade[], snaps: Snapshot[] = []): JournalCtx => ({
  capital,
  snaps: new Map(snaps.map((s) => [s.symbol, s])),
  openInvested: buildOpenInvested(open),
});

// ---- sizeByRisk -------------------------------------------------------------------

describe("sizeByRisk", () => {
  it("sizes qty = floor(capital × risk% ÷ (entry − stop))", () => {
    const s = sizeByRisk({ capital: 300_000, riskPct: 1, entry: 450, stop: 430 });
    expect(s.problem).toBeNull();
    expect(s.riskBudget).toBe(3000);
    expect(s.riskPerShare).toBe(20);
    expect(s.qty).toBe(150);
    expect(s.deployed).toBe(67_500);
    expect(s.deployedPct).toBeCloseTo(22.5);
    expect(s.riskAmount).toBe(3000);
    expect(s.riskPctOfCapital).toBeCloseTo(1);
    expect(s.remainingCapital).toBe(232_500);
    expect(s.exceedsCapital).toBe(false);
    expect(s.stopDistancePct).toBeCloseTo(4.444, 2);
  });

  it("floors fractional quantities and reports the risk actually taken", () => {
    const s = sizeByRisk({ capital: 100_000, riskPct: 1, entry: 100, stop: 97 });
    expect(s.qty).toBe(333);          // 1000 / 3 = 333.33
    expect(s.riskAmount).toBe(999);   // less than the 1000 budget
  });

  it("names each invalid input instead of returning zeros silently", () => {
    expect(sizeByRisk({ capital: 0, riskPct: 1, entry: 10, stop: 9 }).problem).toBe("capital");
    expect(sizeByRisk({ capital: -5, riskPct: 1, entry: 10, stop: 9 }).problem).toBe("capital");
    expect(sizeByRisk({ capital: 100, riskPct: 0, entry: 10, stop: 9 }).problem).toBe("risk");
    expect(sizeByRisk({ capital: 100, riskPct: -1, entry: 10, stop: 9 }).problem).toBe("risk");
    expect(sizeByRisk({ capital: 100, riskPct: 1, entry: 0, stop: 9 }).problem).toBe("entry");
    expect(sizeByRisk({ capital: 100, riskPct: 1, entry: null, stop: 9 }).problem).toBe("entry");
    expect(sizeByRisk({ capital: 100, riskPct: 1, entry: 10, stop: 0 }).problem).toBe("stop");
    expect(sizeByRisk({ capital: 100, riskPct: 1, entry: 10, stop: null }).problem).toBe("stop");
  });

  it("rejects stop at or above entry", () => {
    const eq = sizeByRisk({ capital: 100_000, riskPct: 1, entry: 100, stop: 100 });
    expect(eq.problem).toBe("stop_not_below_entry");
    expect(eq.qty).toBe(0);
    expect(eq.message).toMatch(/below entry/);
    expect(sizeByRisk({ capital: 100_000, riskPct: 1, entry: 100, stop: 120 }).problem)
      .toBe("stop_not_below_entry");
  });

  it("flags a risk budget too small for even one share", () => {
    const s = sizeByRisk({ capital: 10_000, riskPct: 0.5, entry: 1000, stop: 900 });
    expect(s.problem).toBe("zero_qty");
    expect(s.qty).toBe(0);
    expect(s.riskBudget).toBe(50);
    expect(s.riskPerShare).toBe(100);
    expect(s.maxAffordableQty).toBe(10);
    expect(s.message).toMatch(/smaller/);
  });

  it("flags deployment beyond available capital without hiding the qty", () => {
    // Tight stop → huge qty → more capital than exists.
    const s = sizeByRisk({ capital: 100_000, riskPct: 2, entry: 100, stop: 99.5 });
    expect(s.problem).toBeNull();
    expect(s.qty).toBe(4000);
    expect(s.deployed).toBe(400_000);
    expect(s.exceedsCapital).toBe(true);
    expect(s.maxAffordableQty).toBe(1000);
    expect(s.remainingCapital).toBe(-300_000);
  });
});

describe("riskFor", () => {
  it("prices a hand-edited qty and refuses invalid stops", () => {
    expect(riskFor(50, 450, 430)).toBe(1000);
    expect(riskFor(50, 450, 450)).toBeNull();
    expect(riskFor(0, 450, 430)).toBeNull();
    expect(riskFor(null, 450, 430)).toBeNull();
  });
});

// ---- allocationGuard ----------------------------------------------------------------

describe("allocationGuard", () => {
  it("explains an over-limit position in rupees", () => {
    // Capital 25L, Small cap limit 2% = ₹50,000; ₹42,000 already held.
    const ctx = ctxOf(2_500_000, [trade({ symbol: "ABC", buy_price: "420", qty: 100 })]);
    const g = allocationGuard({ symbol: "ABC", cap: "Small", entry: 450, qty: 40, ctx });
    expect(g.limitValue).toBe(50_000);
    expect(g.heldValue).toBe(42_000);
    expect(g.addValue).toBe(18_000);
    expect(g.totalValue).toBe(60_000);
    expect(g.excessValue).toBe(10_000);
    expect(g.state).toBe("over");
    expect(g.maxQty).toBe(17);            // floor(8000 / 450)
    expect(g.roomValue).toBe(-10_000);
  });

  it("is ok / warn / over exactly like the journal rule", () => {
    const ctx = ctxOf(1_000_000, []);
    // Large cap: 5% = ₹50,000. 79% of limit → ok; 80% → warn; >100% → over.
    expect(allocationGuard({ symbol: "X", cap: "Large", entry: 100, qty: 395, ctx }).state).toBe("ok");
    expect(allocationGuard({ symbol: "X", cap: "Large", entry: 100, qty: 400, ctx }).state).toBe("warn");
    expect(allocationGuard({ symbol: "X", cap: "Large", entry: 100, qty: 501, ctx }).state).toBe("over");
    expect(allocationGuard({ symbol: "X", cap: "Large", entry: 100, qty: 500, ctx }).excessValue).toBe(0);
  });

  it("has no verdict without a cap bucket, and no room without capital", () => {
    const g = allocationGuard({ symbol: "X", cap: null, entry: 100, qty: 10, ctx: ctxOf(100_000, []) });
    expect(g.state).toBeNull();
    expect(g.limitValue).toBeNull();
    expect(g.excessValue).toBeNull();
    const z = allocationGuard({ symbol: "X", cap: "Mid", entry: 100, qty: 10, ctx: ctxOf(0, []) });
    expect(z.totalPct).toBeNull();
    expect(z.roomValue).toBeNull();
  });

  it("room left updates with the proposed qty", () => {
    const ctx = ctxOf(2_500_000, [trade({ symbol: "ABC", buy_price: "315", qty: 100 })]);
    const g0 = allocationGuard({ symbol: "ABC", cap: "Small", entry: 450, qty: null, ctx });
    expect(g0.roomValue).toBe(18_500);   // 50,000 − 31,500
    const g1 = allocationGuard({ symbol: "ABC", cap: "Small", entry: 450, qty: 20, ctx });
    expect(g1.roomValue).toBe(9_500);    // − 9,000 more
  });
});

// ---- planTargets --------------------------------------------------------------------

describe("planTargets", () => {
  it("computes gain, gain % and R multiple per target", () => {
    const rows = planTargets(450, 425, 20, [500, 550]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: "T1", price: 500, gainPerShare: 50, totalGain: 1000, valid: true });
    expect(rows[0]!.gainPct).toBeCloseTo(11.11, 2);
    expect(rows[0]!.rMultiple).toBeCloseTo(2);
    expect(rows[1]!.rMultiple).toBeCloseTo(4);
    expect(rows[1]!.gainPct).toBeCloseTo(22.22, 2);
  });

  it("keeps labels by slot, marks targets below entry invalid, and drops blanks", () => {
    const rows = planTargets(450, 430, 10, [null, 440, 0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("T2");
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.gainPerShare).toBe(-10);
  });

  it("has no R multiple without a valid stop, and nothing without an entry", () => {
    expect(planTargets(450, null, 10, [500])[0]!.rMultiple).toBeNull();
    expect(planTargets(450, 460, 10, [500])[0]!.rMultiple).toBeNull();
    expect(planTargets(null, 430, 10, [500])).toEqual([]);
  });
});

// ---- buildLadder ----------------------------------------------------------------------

describe("buildLadder", () => {
  const tranches = [
    { trigger: 450, qty: 20 }, { trigger: 430, qty: 20 }, { trigger: 410, qty: 20 },
  ];

  it("accumulates qty, capital, blended average and allocation per tranche", () => {
    const l = buildLadder({ tranches, capital: 500_000, heldValue: 0, cap: "Large", stop: 400 });
    expect(l.rows.map((r) => r.capital)).toEqual([9000, 8600, 8200]);
    expect(l.rows.map((r) => r.cumCapital)).toEqual([9000, 17_600, 25_800]);
    expect(l.rows.map((r) => r.cumQty)).toEqual([20, 40, 60]);
    expect(l.rows[1]!.cumAvg).toBe(440);
    expect(l.rows[2]!.cumAvg).toBe(430);
    expect(l.rows.map((r) => r.cumPct!.toFixed(2))).toEqual(["1.80", "3.52", "5.16"]);
    expect(l.totalQty).toBe(60);
    expect(l.avgPrice).toBe(430);
    // Large cap limit 5% of 5L = ₹25,000 → the full ladder is over.
    expect(l.rows.map((r) => r.state)).toEqual(["ok", "ok", "over"]);
    expect(l.state).toBe("over");
    expect(l.roomValue).toBe(-800);
    // Risk at stop after each tranche: (avg − 400) × cumQty.
    expect(l.rows.map((r) => r.riskAtStop)).toEqual([1000, 1600, 1800]);
  });

  it("includes what is already held when judging the limit", () => {
    const l = buildLadder({ tranches: [{ trigger: 100, qty: 10 }], capital: 100_000,
                            heldValue: 4000, cap: "Large", stop: null });
    // limit 5% = 5000; held 4000 + 1000 = 5000 → exactly at the limit (warn band)
    expect(l.rows[0]!.totalPct).toBeCloseTo(5);
    expect(l.rows[0]!.state).toBe("warn");
    expect(l.roomValue).toBe(0);
    expect(l.rows[0]!.riskAtStop).toBeNull();
  });

  it("skips incomplete tranches and handles no capital", () => {
    const l = buildLadder({ tranches: [{ trigger: null, qty: 5 }, { trigger: 100, qty: null },
                                       { trigger: 100, qty: 5 }],
                            capital: null, heldValue: 0, cap: "Mid", stop: null });
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0]!.index).toBe(1);
    expect(l.rows[0]!.cumPct).toBeNull();
    expect(l.state).toBeNull();
    expect(l.roomValue).toBeNull();
  });

  it("splits a qty across tranches with the remainder up front", () => {
    expect(splitQty(150, 3)).toEqual([50, 50, 50]);
    expect(splitQty(151, 3)).toEqual([51, 50, 50]);
    expect(splitQty(2, 3)).toEqual([1, 1, 0]);
    expect(splitQty(0, 3)).toEqual([]);
  });
});

// ---- suggestLevels ---------------------------------------------------------------------

describe("suggestLevels", () => {
  it("derives envelope, rally and 52-week levels from a full snapshot", () => {
    const levels = suggestLevels(snap("TCS", "480", {
      dma_200: "500", low_52w: "410", has_valid_20pct_rally: true, last_rally_low: "440",
    }));
    const byKey = Object.fromEntries(levels.map((l) => [l.key, l.price]));
    expect(byKey.cmp).toBe(480);
    expect(byKey.dma).toBe(500);
    expect(byKey.opp).toBeCloseTo(455);
    expect(byKey.buy).toBeCloseTo(430);
    expect(byKey.rally).toBe(440);
    expect(byKey.low52).toBe(410);
  });

  it("marks levels unavailable instead of fabricating them", () => {
    const levels = suggestLevels(snap("TCS", "480", { has_valid_20pct_rally: false, last_rally_low: "440" }));
    const byKey = Object.fromEntries(levels.map((l) => [l.key, l]));
    expect(byKey.dma!.price).toBeNull();
    expect(byKey.opp!.price).toBeNull();
    expect(byKey.buy!.price).toBeNull();
    expect(byKey.rally!.price).toBeNull();     // rally flag false → no level
    expect(byKey.low52!.price).toBeNull();
    expect(byKey.dma!.hint).toMatch(/history/);
    expect(suggestLevels(undefined).every((l) => l.price === null)).toBe(true);
  });
});

// ---- averaging down ----------------------------------------------------------------------

describe("existingPosition / averageDown", () => {
  const open = [
    trade({ id: 1, symbol: "ABC", buy_price: "500", qty: 10, stop_price: "440" }),
    trade({ id: 2, symbol: "ABC", buy_price: "460", qty: 10, stop_price: "450" }),
    trade({ id: 3, symbol: "XYZ", buy_price: "100", qty: 5 }),
  ];

  it("blends open lots into one position with the tightest stop", () => {
    const p = existingPosition(open, "ABC")!;
    expect(p.qty).toBe(20);
    expect(p.invested).toBe(9600);
    expect(p.avg).toBe(480);
    expect(p.lots).toBe(2);
    expect(p.stop).toBe(450);
    expect(existingPosition(open, "NOPE")).toBeNull();
    expect(existingPosition(open, "XYZ")!.stop).toBeNull();
  });

  it("computes the new blended average, allocation and risk at stop", () => {
    const a = averageDown({ existing: existingPosition(open, "ABC"), addQty: 20, addPrice: 420,
                            stop: 400, capital: 1_000_000, cap: "Mid" })!;
    expect(a.newQty).toBe(40);
    expect(a.totalValue).toBe(18_000);
    expect(a.newAvg).toBe(450);
    expect(a.avgChangePct).toBeCloseTo(-6.25);
    expect(a.newAllocPct).toBeCloseTo(1.8);
    expect(a.state).toBe("ok");
    expect(a.riskAtStop).toBe(2000);          // (450 − 400) × 40
    expect(a.riskPctOfCapital).toBeCloseTo(0.2);
  });

  it("treats a stop above the new average as zero risk, and needs a position", () => {
    const a = averageDown({ existing: existingPosition(open, "ABC"), addQty: 20, addPrice: 420,
                            stop: 470, capital: 1_000_000, cap: "Mid" })!;
    expect(a.riskAtStop).toBe(0);
    expect(averageDown({ existing: null, addQty: 1, addPrice: 1, stop: null, capital: 1, cap: null })).toBeNull();
    expect(averageDown({ existing: existingPosition(open, "ABC"), addQty: 0, addPrice: 420,
                         stop: null, capital: 1, cap: null })).toBeNull();
  });
});

// ---- portfolio heat ----------------------------------------------------------------------

describe("portfolioHeat", () => {
  const open = [
    trade({ id: 1, symbol: "ABC", buy_price: "500", qty: 10, stop_price: "460" }),  // cmp 520
    trade({ id: 2, symbol: "DEF", buy_price: "200", qty: 50, stop_price: "190" }),  // no cmp → buy
    trade({ id: 3, symbol: "GHI", buy_price: "100", qty: 5 }),                       // no stop
    trade({ id: 4, symbol: "JKL", buy_price: "80", qty: 10, stop_price: "90" }),    // cmp 85 < stop
  ];
  const snaps = new Map([["ABC", snap("ABC", "520")], ["JKL", snap("JKL", "85")]]);

  it("measures open risk from CMP when available, else buy price, never below zero", () => {
    const h = portfolioHeat({ openTrades: open, snaps, capital: 1_000_000, newRisk: 0 });
    const abc = h.lots.find((l) => l.symbol === "ABC")!;
    expect(abc.basisSource).toBe("cmp");
    expect(abc.risk).toBe(600);          // (520 − 460) × 10
    const def = h.lots.find((l) => l.symbol === "DEF")!;
    expect(def.basisSource).toBe("buy");
    expect(def.risk).toBe(500);          // (200 − 190) × 50
    expect(h.lots.find((l) => l.symbol === "JKL")!.risk).toBe(0); // stop above cmp
    expect(h.openRisk).toBe(1100);
    expect(h.openRiskPct).toBeCloseTo(0.11);
    expect(h.lotsWithStop).toBe(3);
    expect(h.lotsWithoutStop).toBe(1);
    expect(h.symbolsWithoutStop).toEqual(["GHI"]);
  });

  it("shows the new trade's share of the combined open risk", () => {
    const h = portfolioHeat({ openTrades: open, snaps, capital: 1_000_000, newRisk: 3200 });
    expect(h.combinedRisk).toBe(4300);
    expect(h.newShare).toBeCloseTo(74.42, 1);
    expect(h.combinedPct).toBeCloseTo(0.43);
  });

  it("copes with an empty book and no capital", () => {
    const h = portfolioHeat({ openTrades: [], snaps: new Map(), capital: null, newRisk: 0 });
    expect(h.openRisk).toBe(0);
    expect(h.openRiskPct).toBeNull();
    expect(h.newShare).toBeNull();
  });
});

describe("planSummary", () => {
  it("writes a one-line note including valid targets with R", () => {
    const targets = planTargets(450, 430, 150, [500, 440]);
    const s = planSummary({ entry: 450, stop: 430, qty: 150, riskPct: 1, riskAmount: 3000, targets });
    expect(s).toContain("150 × ₹450");
    expect(s).toContain("stop ₹430");
    expect(s).toContain("T1 ₹500 (2.5R)");
    expect(s).not.toContain("T2");
  });
});
