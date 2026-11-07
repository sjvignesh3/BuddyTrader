import { describe, expect, it } from "vitest";
import type { Ipo } from "./journalApi";
import { accountsOf, dayDiff, deriveIpo, localToday, summarizeIpos } from "./ipo";

const TODAY = "2026-11-07";

function ipo(over: Partial<Ipo> = {}): Ipo {
  return {
    id: 1, account: "Self", ipo_name: "Acme", symbol: "ACME",
    apply_date: "2026-10-01", issue_price: "100.00", lot_size: 150, lots_applied: 2,
    status: "APPLIED", allotment_date: null, shares_allotted: null,
    listing_date: null, listing_open: null, listing_close: null, notes: null, sells: [],
    ...over,
  };
}

const sold = (over: Partial<Ipo> = {}) => ipo({
  status: "ALLOTTED", shares_allotted: 150, allotment_date: "2026-10-06",
  listing_date: "2026-10-08", listing_open: "120.00", listing_close: "126.00",
  sells: [
    { id: 1, ipo_id: 1, sell_date: "2026-10-08", sell_price: "121.00", qty: 75, notes: null },
    { id: 2, ipo_id: 1, sell_date: "2026-10-15", sell_price: "130.00", qty: 75, notes: null },
  ],
  ...over,
});

describe("dates", () => {
  it("counts calendar days, listing day = 0", () => {
    expect(dayDiff("2026-10-08", "2026-10-08")).toBe(0);
    expect(dayDiff("2026-10-08", "2026-10-15")).toBe(7);
    expect(dayDiff("2026-02-28", "2026-03-01")).toBe(1);
    expect(dayDiff(null, "2026-10-01")).toBeNull();
  });
  it("localToday is YYYY-MM-DD", () => {
    expect(localToday(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("deriveIpo", () => {
  it("pending application: blocked money and days locked so far", () => {
    const d = deriveIpo(ipo(), null, TODAY);
    expect(d.stage).toBe("Applied");
    expect(d.blocked).toBe(30_000);
    expect(d.invested).toBe(0);
    expect(d.lockDays).toBe(37);
    expect(d.perDay).toBeNull();
    expect(d.returnPct).toBeNull();
  });

  it("not allotted: locked until the refund date", () => {
    const d = deriveIpo(ipo({ status: "NOT_ALLOTTED", allotment_date: "2026-10-06" }), null, TODAY);
    expect(d.stage).toBe("Not allotted");
    expect(d.lockDays).toBe(5);
    expect(d.totalPnl).toBe(0);
  });

  it("fully sold in two legs", () => {
    const d = deriveIpo(sold(), null, TODAY);
    expect(d.stage).toBe("Sold");
    expect(d.invested).toBe(15_000);
    expect(d.soldValue).toBe(75 * 121 + 75 * 130);
    expect(d.avgSell).toBe(125.5);
    expect(d.realised).toBe(75 * 21 + 75 * 30);          // 3,825
    expect(d.realisedPct).toBeCloseTo(25.5);
    expect(d.returnPct).toBeCloseTo(25.5);
    expect(d.listingGainPct).toBeCloseTo(20);
    expect(d.listingCloseGainPct).toBeCloseTo(26);
    // Selling all 150 at the 120 open = ₹3,000; holding made ₹3,825.
    expect(d.listingOpenPnl).toBe(3000);
    expect(d.edgeVsListing).toBe(825);
    expect(d.daysHeld).toBe(7);
    expect(d.lockDays).toBe(14);
    expect(d.perDay).toBeCloseTo(3825 / 14);
  });

  it("partly sold with a live price: unrealised on the rest", () => {
    const one = sold();
    const d = deriveIpo({ ...one, sells: one.sells.slice(0, 1) }, 140, TODAY);
    expect(d.stage).toBe("Partly sold");
    expect(d.held).toBe(75);
    expect(d.realised).toBe(75 * 21);
    expect(d.unrealised).toBe(75 * 40);
    expect(d.totalPnl).toBe(75 * 21 + 75 * 40);
    expect(d.edgeVsListing).toBeNull();      // only once fully sold
    expect(d.daysHeld).toBe(30);             // listing → today while holding
  });

  it("allotted, not listed yet", () => {
    const d = deriveIpo(ipo({ status: "ALLOTTED", shares_allotted: 150 }), null, TODAY);
    expect(d.stage).toBe("Allotted");
    expect(d.held).toBe(150);
    expect(d.daysHeld).toBeNull();
    expect(d.listingGainPct).toBeNull();
  });

  it("listing date in the future is still Allotted", () => {
    const d = deriveIpo(ipo({ status: "ALLOTTED", shares_allotted: 150, listing_date: "2026-11-10" }),
                        null, TODAY);
    expect(d.stage).toBe("Allotted");
  });
});

describe("summarizeIpos", () => {
  it("track record across accounts", () => {
    const rows = [
      sold(),
      ipo({ id: 2, status: "NOT_ALLOTTED", allotment_date: "2026-10-06" }),
      ipo({ id: 3, account: "Father" }),                                     // pending
      sold({ id: 4, account: "Father", listing_open: "90.00",
             sells: [{ id: 9, ipo_id: 4, sell_date: "2026-10-09", sell_price: "95.00", qty: 150, notes: null }] }),
    ].map((i) => ({ ipo: i, d: deriveIpo(i, null, TODAY) }));
    const s = summarizeIpos(rows);
    expect(s.applications).toBe(4);
    expect(s.decided).toBe(3);
    expect(s.allotted).toBe(2);
    expect(s.hitRate).toBeCloseTo(66.67, 1);
    expect(s.pending).toBe(1);
    expect(s.blockedNow).toBe(30_000);
    expect(s.realised).toBe(3825 - 750);
    expect(s.avgListingGainPct).toBeCloseTo((20 - 10) / 2);
    expect(s.soldCount).toBe(2);
    expect(s.wins).toBe(1);
    // (3825 − 3000) + (−750 − (−1500))
    expect(s.edgeVsListing).toBe(825 + 750);
  });

  it("empty is all nulls / zeros", () => {
    const s = summarizeIpos([]);
    expect(s.hitRate).toBeNull();
    expect(s.avgListingGainPct).toBeNull();
    expect(s.edgeVsListing).toBeNull();
    expect(s.realised).toBe(0);
  });
});

describe("accountsOf", () => {
  it("keeps Self and Father first and adds any others", () => {
    expect(accountsOf([ipo({ account: "Father" }), ipo({ account: "Mother" })]))
      .toEqual(["Self", "Father", "Mother"]);
  });
});
