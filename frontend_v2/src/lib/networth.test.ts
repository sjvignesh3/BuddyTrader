import { describe, expect, it } from "vitest";
import type { MonthStats } from "./expenses";
import type { HoldingRow } from "./journal";
import type { Trade } from "./journalApi";
import type { Asset, Liability, Milestone, NetWorthSnapshot } from "./networthApi";
import {
  allocation, assetGain, averageBurn, averageRate, baselineSnapshot, buildNetWorthInsights,
  changeSince, coastCorpus, computeNetWorth, concentrationChecks, fmtIndian,
  freedomProjection, growthStreak, growthTrend, incomeByMonth, liquidAssets, milestoneEta,
  milestoneProgress, portfolioCashflows, portfolioXirr, runway, savingsRate, savingsSeries,
  snapshotBreakdown, sumAssets, sumLiabilities, xirr,
} from "./networth";

// ---- fixtures ---------------------------------------------------------------------

const asset = (o: Partial<Asset>): Asset => ({
  id: 1, name: "a", asset_class: "Cash", institution: null, current_value: "0",
  cost_basis: null, as_of_date: "2026-09-01", notes: null, archived: false, ...o,
});
const liab = (o: Partial<Liability>): Liability => ({
  id: 1, name: "l", kind: "Other", outstanding: "0", interest_rate: null, emi: null,
  notes: null, archived: false, ...o,
});
const snap = (date: string, nw: number, eq = 0, as = nw, li = 0): NetWorthSnapshot => ({
  id: 1, snapshot_date: date, equity_value: String(eq), assets_value: String(as),
  liabilities_value: String(li), net_worth: String(nw), breakdown: {},
});
const trade = (o: Partial<Trade>): Trade => ({
  id: 1, opportunity_id: null, order_type: null, cap_bucket: null, symbol: "TCS",
  buy_date: "2025-01-01", buy_price: "100", qty: 10, strategy: null, target_price: null,
  stop_price: null, status: "OPEN", close_label: null, sell_date: null, sell_price: null,
  comments: null, risk_notes: null, ...o,
});
const stats = (key: string, total: number): MonthStats => ({
  key, total, txCount: total ? 1 : 0, needs: 0, wants: 0, unclassified: 0, excludedTotal: 0,
  recurringTotal: 0, byRoot: new Map(), bySub: new Map(), byDay: new Map(), byName: new Map(),
  weekendTotal: 0, weekendDays: 0, weekdayTotal: 0, weekdayDays: 0,
});
const monthlyOf = (entries: [string, number][]) =>
  new Map(entries.map(([k, v]) => [k, stats(k, v)]));
const holding = (o: Partial<HoldingRow>): HoldingRow => ({
  symbol: "TCS", cap: "Large", qty: 10, invested: 1000, allocPct: 1, currentValue: 1000,
  pnl: 0, pnlPct: 0, marker: "ok", lots: 1, ...o,
});

const ASSETS: Asset[] = [
  asset({ id: 1, asset_class: "Cash", current_value: "150000" }),
  asset({ id: 2, asset_class: "FD", current_value: "200000", cost_basis: "180000" }),
  asset({ id: 3, asset_class: "Mutual Fund", current_value: "300000", cost_basis: "250000" }),
  asset({ id: 4, asset_class: "Gold", current_value: "50000" }),
  asset({ id: 5, asset_class: "Cash", current_value: "999999", archived: true }),
];
const LIABS: Liability[] = [
  liab({ id: 1, kind: "Car Loan", outstanding: "100000" }),
  liab({ id: 2, kind: "Credit Card", outstanding: "20000" }),
  liab({ id: 3, kind: "Other", outstanding: "5555", archived: true }),
];

// ---- aggregation -------------------------------------------------------------------

describe("aggregation", () => {
  it("sums only active assets and liabilities", () => {
    expect(sumAssets(ASSETS)).toBe(700_000);
    expect(sumLiabilities(LIABS)).toBe(120_000);
    expect(liquidAssets(ASSETS)).toBe(350_000);      // Cash + FD, archived excluded
  });

  it("equity + assets − liabilities = net worth", () => {
    const t = computeNetWorth({ equity: 250_000, assets: 700_000, liabilities: 120_000 });
    expect(t.totalAssets).toBe(950_000);
    expect(t.netWorth).toBe(830_000);
    expect(computeNetWorth({ equity: 0, assets: 0, liabilities: 0 }).netWorth).toBe(0);
    expect(computeNetWorth({ equity: 0, assets: 100, liabilities: 300 }).netWorth).toBe(-200);
  });

  it("allocation is sorted by value with % of total assets", () => {
    const a = allocation(250_000, ASSETS);
    expect(a.map((s) => s.key)).toEqual(["Mutual Fund", "Equity", "FD", "Cash", "Gold"]);
    expect(a.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(100);
    expect(a.find((s) => s.key === "Equity")!.pct).toBeCloseTo(26.32, 1);
    expect(allocation(0, [])).toEqual([]);
  });

  it("asset gain only where a cost basis exists", () => {
    expect(assetGain(ASSETS[0]!)).toBeNull();
    expect(assetGain(ASSETS[1]!)).toEqual({ gain: 20_000, pct: expect.closeTo(11.11, 1) });
    expect(assetGain(asset({ current_value: "10", cost_basis: "0" }))).toEqual({ gain: 10, pct: null });
  });

  it("snapshot breakdown keeps money as fixed strings", () => {
    const b = snapshotBreakdown(250_000, ASSETS, LIABS,
                                [holding({ symbol: "TCS", currentValue: 250_000 })]);
    expect(b.equity).toBe("250000.00");
    expect(b.assets).toEqual({ Cash: "150000.00", FD: "200000.00", "Mutual Fund": "300000.00", Gold: "50000.00" });
    expect(b.liabilities).toEqual({ "Car Loan": "100000.00", "Credit Card": "20000.00" });
    expect(b.holdings).toEqual([{ symbol: "TCS", value: "250000.00" }]);
  });

  it("formats the Indian scale", () => {
    expect(fmtIndian(1_840_000)).toBe("₹18.4L");
    expect(fmtIndian(10_200_000, 2)).toBe("₹1.02Cr");
    expect(fmtIndian(52_300)).toBe("₹52,300");
    expect(fmtIndian(-250_000)).toBe("−₹2.5L");
  });
});

// ---- history -------------------------------------------------------------------------

describe("history", () => {
  const snaps = [
    snap("2026-06-01", 100), snap("2026-07-01", 110), snap("2026-09-01", 120),
    snap("2026-08-01", 115),
  ];

  it("finds the latest snapshot before the current month as the baseline", () => {
    expect(baselineSnapshot(snaps, "2026-09")!.snapshot_date).toBe("2026-08-01");
    expect(baselineSnapshot(snaps, "2026-10")!.snapshot_date).toBe("2026-09-01");
    expect(baselineSnapshot(snaps, "2026-06")).toBeNull();
  });

  it("computes the change since a baseline", () => {
    expect(changeSince(120, 100)).toEqual({ abs: 20, pct: 20 });
    expect(changeSince(80, -100)).toEqual({ abs: 180, pct: 180 });
    expect(changeSince(50, 0)).toEqual({ abs: 50, pct: null });
    expect(changeSince(50, null)).toBeNull();
  });

  it("counts consecutive months of growth", () => {
    expect(growthStreak(snaps)).toBe(3);
    expect(growthStreak([snap("2026-06-01", 100), snap("2026-07-01", 90)])).toBe(0);
    expect(growthStreak([snap("2026-06-01", 100)])).toBe(0);
    expect(growthStreak([])).toBe(0);
  });
});

// ---- XIRR ------------------------------------------------------------------------------

describe("xirr", () => {
  it("recovers a known annual return", () => {
    // 1000 → 1100 in exactly one year = 10%.
    const r = xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2026-01-01", amount: 1100 }])!;
    expect(r).toBeCloseTo(0.10, 3);
  });

  it("handles multiple dated flows", () => {
    const r = xirr([
      { date: "2025-01-01", amount: -1000 },
      { date: "2025-07-01", amount: -1000 },
      { date: "2026-01-01", amount: 2300 },
    ])!;
    // Money-weighted: ~21% (second lot only worked half a year).
    expect(r).toBeGreaterThan(0.19);
    expect(r).toBeLessThan(0.23);
  });

  it("is negative for a loss and null without a sign change", () => {
    expect(xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2026-01-01", amount: 800 }])!)
      .toBeCloseTo(-0.2, 3);
    expect(xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2026-01-01", amount: -1 }])).toBeNull();
    expect(xirr([{ date: "2025-01-01", amount: -1000 }])).toBeNull();
  });

  it("builds cashflows from journal buys, sells and the open book", () => {
    const flows = portfolioCashflows([
      trade({ buy_date: "2025-01-01", buy_price: "100", qty: 10 }),
      trade({ buy_date: "2025-03-01", buy_price: "50", qty: 10, status: "CLOSED",
              sell_date: "2025-06-01", sell_price: "60" }),
    ], 1200, "2026-01-01");
    expect(flows).toEqual([
      { date: "2025-01-01", amount: -1000 },
      { date: "2025-03-01", amount: -500 },
      { date: "2025-06-01", amount: 600 },
      { date: "2026-01-01", amount: 1200 },
    ]);
  });

  it("reports insufficient data honestly", () => {
    expect(portfolioXirr([], 0, "2026-01-01").reason).toMatch(/No buys/);
    const young = portfolioXirr([trade({ buy_date: "2025-12-20" })], 1100, "2026-01-01");
    expect(young.rate).toBeNull();
    expect(young.reason).toMatch(/at least 30/);
    const ok = portfolioXirr([trade({ buy_date: "2025-01-01" })], 1100, "2026-01-01");
    expect(ok.rate).toBeCloseTo(10, 1);
    expect(ok.reason).toBeNull();
  });
});

// ---- runway ----------------------------------------------------------------------------

describe("runway", () => {
  it("divides liquid assets by the average burn and grades it", () => {
    expect(runway(350_000, 60_000)).toEqual({ months: expect.closeTo(5.83, 2), state: "caution" });
    expect(runway(100_000, 60_000).state).toBe("danger");
    expect(runway(400_000, 60_000).state).toBe("healthy");
    expect(runway(179_999, 60_000).state).toBe("danger");     // just under 3
    expect(runway(180_000, 60_000).state).toBe("caution");    // exactly 3
    expect(runway(360_000, 60_000).state).toBe("healthy");    // exactly 6
    expect(runway(100_000, 0)).toEqual({ months: null, state: null });
  });

  it("averages only completed months that have spending", () => {
    const monthly = monthlyOf([["2026-09", 10_000], ["2026-08", 60_000], ["2026-07", 50_000],
                               ["2026-06", 0], ["2026-05", 70_000]]);
    const b = averageBurn(monthly, "2026-09", 3);
    expect(b).toEqual({ avg: 55_000, months: 2 });        // Jun has no spend → skipped
    expect(averageBurn(monthly, "2026-09", 4)).toEqual({ avg: 60_000, months: 3 });
    expect(averageBurn(new Map(), "2026-09")).toEqual({ avg: 0, months: 0 });
  });
});

// ---- savings rate ----------------------------------------------------------------------

describe("savings rate", () => {
  it("(income − expenses) ÷ income", () => {
    expect(savingsRate(100_000, 62_000)).toBeCloseTo(38);
    expect(savingsRate(100_000, 120_000)).toBeCloseTo(-20);
    expect(savingsRate(0, 10)).toBeNull();
    expect(savingsRate(null, 10)).toBeNull();
  });

  it("builds a monthly series and averages the months that have a rate", () => {
    const income = incomeByMonth([
      { id: 1, month: "2026-07-01", amount: "100000", notes: null },
      { id: 2, month: "2026-09-01", amount: "100000", notes: null },
    ]);
    const monthly = monthlyOf([["2026-07", 69_000], ["2026-08", 70_000], ["2026-09", 62_000]]);
    const series = savingsSeries(["2026-07", "2026-08", "2026-09"], income, monthly);
    expect(series.map((p) => p.rate)).toEqual([31, null, 38]);
    expect(series[1]!.income).toBeNull();
    expect(averageRate(series, 3)).toEqual({ avg: 34.5, months: 2 });
    expect(averageRate([], 3)).toEqual({ avg: null, months: 0 });
  });
});

// ---- milestones -------------------------------------------------------------------------

describe("milestones", () => {
  const m: Milestone = { id: 1, label: "₹25L", target: "2500000", achieved_on: null };

  it("progress is clamped and reports remaining", () => {
    expect(milestoneProgress(m, 1_840_000)).toEqual({ target: 2_500_000, pct: 73.6, remaining: 660_000, achieved: false });
    expect(milestoneProgress(m, 3_000_000)).toMatchObject({ pct: 100, remaining: 0, achieved: true });
    expect(milestoneProgress(m, -5)).toMatchObject({ pct: 0 });
  });

  it("needs three snapshots for a trend and flags volatility", () => {
    expect(growthTrend([snap("2026-07-01", 100), snap("2026-08-01", 110)])).toBeNull();
    const steady = growthTrend([snap("2026-06-01", 100), snap("2026-07-01", 110),
                                snap("2026-08-01", 120), snap("2026-09-01", 130)])!;
    expect(steady.perMonth).toBeCloseTo(10);
    expect(steady.months).toBe(3);
    expect(steady.volatile).toBe(false);
    const choppy = growthTrend([snap("2026-06-01", 100), snap("2026-07-01", 160),
                                snap("2026-08-01", 90), snap("2026-09-01", 130)])!;
    expect(choppy.volatile).toBe(true);
    // A skipped month divides the delta across the gap.
    const gap = growthTrend([snap("2026-05-01", 100), snap("2026-07-01", 120), snap("2026-08-01", 130)])!;
    expect(gap.perMonth).toBeCloseTo(10);
  });

  it("estimates an ETA only when there is a positive trend", () => {
    const snaps = [snap("2026-06-01", 1_000_000), snap("2026-07-01", 1_050_000),
                   snap("2026-08-01", 1_100_000), snap("2026-09-01", 1_150_000)];
    const eta = milestoneEta(1_500_000, 1_150_000, snaps, "2026-09");
    expect(eta.months).toBe(7);
    expect(eta.monthKey).toBe("2027-04");
    expect(eta.rough).toBe(false);
    expect(milestoneEta(1_000_000, 1_150_000, snaps, "2026-09")).toMatchObject({ months: 0, basis: "reached" });
    expect(milestoneEta(2_000_000, 1_000, [], "2026-09")).toMatchObject({ months: null, rough: true });
    const falling = [snap("2026-06-01", 300), snap("2026-07-01", 200), snap("2026-08-01", 100)];
    expect(milestoneEta(1000, 100, falling, "2026-08").months).toBeNull();
  });
});

// ---- financial freedom ---------------------------------------------------------------------

describe("freedom", () => {
  it("projects months to a target with compounding savings", () => {
    const f = freedomProjection({ current: 1_000_000, monthlySavings: 50_000, realReturnPct: 6,
                                  target: 10_000_000, currentMonth: "2026-09" })!;
    expect(f.progressPct).toBe(10);
    expect(f.monthsToTarget).not.toBeNull();
    // Sanity: the projection at that month reaches the target, one month earlier does not.
    expect(f.projectedAt(f.monthsToTarget!)).toBeGreaterThanOrEqual(10_000_000);
    expect(f.projectedAt(f.monthsToTarget! - 1)).toBeLessThan(10_000_000);
    expect(f.monthKey).toBeTruthy();
  });

  it("handles zero return, reached targets and unreachable inputs", () => {
    expect(freedomProjection({ current: 0, monthlySavings: 10_000, realReturnPct: 0,
                               target: 120_000, currentMonth: "2026-09" })!.monthsToTarget).toBe(12);
    expect(freedomProjection({ current: 500, monthlySavings: 0, realReturnPct: 5,
                               target: 100, currentMonth: "2026-09" })!.monthsToTarget).toBe(0);
    expect(freedomProjection({ current: 0, monthlySavings: 0, realReturnPct: 5,
                               target: 100, currentMonth: "2026-09" })!.monthsToTarget).toBeNull();
    expect(freedomProjection({ current: 0, monthlySavings: 0, realReturnPct: 0,
                               target: 100, currentMonth: "2026-09" })!.monthsToTarget).toBeNull();
    expect(freedomProjection({ current: 0, monthlySavings: 1, realReturnPct: 0,
                               target: 0, currentMonth: "2026-09" })).toBeNull();
  });

  it("coast corpus discounts the target", () => {
    expect(coastCorpus(1_000_000, 6, 10)!).toBeCloseTo(558_394.78, 0);
    expect(coastCorpus(1_000_000, 6, 0)).toBe(1_000_000);
    expect(coastCorpus(0, 6, 10)).toBeNull();
  });
});

// ---- concentration / insights ---------------------------------------------------------------

describe("concentrationChecks", () => {
  it("flags a dominant stock, heavy equity, debt and cap breaches", () => {
    const totals = computeNetWorth({ equity: 800_000, assets: 300_000, liabilities: 600_000 });
    const checks = concentrationChecks({
      holdings: [holding({ symbol: "ABC", currentValue: 200_000, marker: "over", cap: "Small", allocPct: 3 }),
                 holding({ symbol: "DEF", currentValue: 600_000 })],
      totals, assets: [asset({ asset_class: "Real Estate", current_value: "300000" })],
      runway: runway(0, 0),
    });
    const texts = checks.map((c) => c.text).join("\n");
    expect(texts).toMatch(/DEF alone is 120%/);
    expect(texts).toMatch(/100% of your investable assets are in equities/); // RE excluded
    expect(texts).toMatch(/Liabilities are 55%/);
    expect(texts).toMatch(/ABC exceeds the Small-cap limit of 2%/);
    expect(checks.filter((c) => c.tone === "warn").length).toBe(4);
  });

  it("says nothing with nothing", () => {
    expect(concentrationChecks({ holdings: [], totals: computeNetWorth({ equity: 0, assets: 0, liabilities: 0 }),
                                 assets: [], runway: runway(0, 0) })).toEqual([]);
  });
});

describe("buildNetWorthInsights", () => {
  const monthly = monthlyOf([["2026-07", 50_000], ["2026-08", 50_000], ["2026-09", 65_000]]);

  it("asks for snapshots before it has two", () => {
    const ins = buildNetWorthInsights({
      totals: computeNetWorth({ equity: 0, assets: 100, liabilities: 0 }), snaps: [],
      currentMonth: "2026-09", monthly, savings: [], holdings: [], runway: runway(0, 0),
    });
    expect(ins[0]!.text).toMatch(/first monthly snapshot/);
  });

  it("attributes this month's change to its driver and notices a streak", () => {
    const snaps = [snap("2026-06-01", 900_000, 400_000, 600_000, 100_000),
                   snap("2026-07-01", 950_000, 450_000, 600_000, 100_000),
                   snap("2026-08-01", 1_000_000, 500_000, 600_000, 100_000)];
    const totals = computeNetWorth({ equity: 580_000, assets: 610_000, liabilities: 100_000 }); // +90k, 80k equity
    const ins = buildNetWorthInsights({
      totals, snaps, currentMonth: "2026-09", monthly,
      savings: [{ key: "2026-07", income: 100_000, expenses: 69_000, rate: 31 },
                { key: "2026-08", income: 100_000, expenses: 65_000, rate: 35 },
                { key: "2026-09", income: 100_000, expenses: 62_000, rate: 38 }],
      holdings: [holding({ symbol: "ABC", marker: "over", cap: "Micro", allocPct: 2.1 })],
      runway: runway(350_000, 60_000),
    });
    const texts = ins.map((i) => i.text);
    expect(texts).toContainEqual(expect.stringMatching(/increased for 2 consecutive months/));
    expect(texts).toContainEqual(expect.stringMatching(/89% of this month's net-worth increase came from equity appreciation/));
    expect(texts).toContainEqual(expect.stringMatching(/savings rate improved from 31% to 38%/));
    expect(texts).toContainEqual(expect.stringMatching(/ABC is 2.1% of trading capital — above the Micro-cap limit of 1.5%/));
    expect(texts).toContainEqual(expect.stringMatching(/cover about 5.8 months/));
    expect(ins.length).toBeLessThanOrEqual(6);
  });

  it("links a slowdown to a spending jump", () => {
    const snaps = [snap("2026-07-01", 900_000), snap("2026-08-01", 1_000_000)];  // +100k last month
    const totals = computeNetWorth({ equity: 0, assets: 1_020_000, liabilities: 0 }); // only +20k now
    const ins = buildNetWorthInsights({
      totals, snaps, currentMonth: "2026-09", monthly, savings: [], holdings: [], runway: runway(0, 0),
    });
    expect(ins.map((i) => i.text)).toContainEqual(expect.stringMatching(/growth slowed.*expenses rose 30%/));
  });
});
