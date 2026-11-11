// US journal (phase 2): quantity rules, per-market query keys, snapshot
// lookup that never crosses markets, and the US rule cap.
import { describe, expect, it } from "vitest";
import type { Snapshot } from "./api";
import type { Trade } from "./journalApi";
import {
  CAP_LIMITS, US_RULE_CAP, buildOpenInvested, buildPortfolio, effectiveCap,
  journalSnaps, planAllocation, snapshotSymbols, stockPath, type JournalCtx,
} from "./journal";
import { exportOpenTrades, locateSheet, mapSheet, parseCsv } from "./journalCsv";
import { badQty, fmtQty, jkey, moneyFor, qtyOrNull } from "./moneyContext";

function snap(symbol: string, close: string, over: Partial<Snapshot> = {}): Snapshot {
  return {
    symbol, snapshot_date: "2026-11-10", open: close, high: close, low: close,
    close, adj_close: close, volume: 1, ...over,
  };
}

function trade(over: Partial<Trade>): Trade {
  return {
    id: 1, opportunity_id: null, order_type: null, cap_bucket: null, symbol: "NVDA",
    buy_date: "2026-11-01", buy_price: "150", qty: 2.5, strategy: null, target_price: null,
    stop_price: null, status: "OPEN", close_label: null, sell_date: null, sell_price: null,
    comments: null, risk_notes: null, ...over,
  } as Trade;
}

describe("quantities", () => {
  it("India: whole numbers only (rounded, as the forms always did)", () => {
    expect(qtyOrNull("IN", "10")).toBe(10);
    expect(qtyOrNull("IN", "1,000")).toBe(1000);
    expect(qtyOrNull("IN", "0.4")).toBeNull();
    expect(qtyOrNull("IN", "")).toBeNull();
    expect(badQty("IN", "abc")).toBe(true);
    expect(badQty("IN", "")).toBe(false);
  });
  it("US: fractions up to four decimals", () => {
    expect(qtyOrNull("US", "0.5")).toBe(0.5);
    expect(qtyOrNull("US", "2.123456")).toBe(2.1235);
    expect(qtyOrNull("US", "3")).toBe(3);
    expect(qtyOrNull("US", "0")).toBeNull();
    expect(qtyOrNull("US", "-1")).toBeNull();
    expect(badQty("US", "0.25")).toBe(false);
  });
  it("displays without float noise or trailing zeros", () => {
    expect(fmtQty(10)).toBe("10");
    expect(fmtQty(2.5)).toBe("2.5");
    expect(fmtQty(0.1 + 0.2)).toBe("0.3");
    expect(fmtQty("1.7500")).toBe("1.75");
    expect(fmtQty(null)).toBe("—");
  });
});

describe("money per market", () => {
  it("formats in the market's own grouping and sign", () => {
    const us = moneyFor("US"); const india = moneyFor("IN");
    expect(us.cur).toBe("$");
    expect(india.cur).toBe("₹");
    expect(us.fmtMoney(1234567.891)).toBe("1,234,567.89");
    expect(india.fmtMoney(1234567.891)).toBe("12,34,567.89");
    // US amounts always show cents — "+0" would hide a real +$0.46.
    expect(us.fmtMoney(8000, 0)).toBe("8,000.00");
    expect(us.fmtMoney(47.97, 0)).toBe("47.97");
    expect(us.fmtMoney(0.4589, 0)).toBe("0.46");
    expect(us.minDigits).toBe(2);
    // India is unchanged: whole rupees where the journal asked for them.
    expect(india.fmtMoney(17562.5, 0)).toBe("17,563");
    expect(india.minDigits).toBe(0);
    // Capital is a round figure the owner typed — never padded.
    expect(us.fmtWhole(1000)).toBe("1,000");
    expect(us.fmtWhole("1000")).toBe("1,000");
    expect(us.fmtWhole(1250.5)).toBe("1,250.50");
    expect(india.fmtWhole(500000)).toBe("5,00,000");
    expect(us.fractionalQty && !india.fractionalQty).toBe(true);
  });
  it("query keys: India keeps the historic key, US gets its own", () => {
    expect(jkey("IN", "trades")).toEqual(["journal", "trades"]);
    expect(jkey("US", "trades")).toEqual(["journal", "US", "trades"]);
    expect(jkey("US", "trades", "symbol", "NVDA")[0]).toBe("journal"); // same family
  });
});

describe("snapshots never cross markets", () => {
  const rows = [snap("IDEA.NS", "10"), snap("IDEA", "20"), snap("NVDA", "168.89"),
                snap("TCS.NS", "3500", { cap_bucket: "Large" })];
  it("India sees Indian rows only, keyed by plain symbol", () => {
    const m = journalSnaps(rows, "IN");
    expect([...m.keys()].sort()).toEqual(["IDEA", "TCS"]);
    expect(m.get("IDEA")?.close).toBe("10");
    expect(m.get("IDEA")?.cap_bucket).toBeUndefined();          // not tagged
  });
  it("US sees US rows only, tagged with the US rule cap", () => {
    const m = journalSnaps(rows, "US");
    expect([...m.keys()].sort()).toEqual(["IDEA", "NVDA"]);
    expect(m.get("IDEA")?.close).toBe("20");
    expect(m.get("NVDA")?.cap_bucket).toBe(US_RULE_CAP);
    expect(effectiveCap(null, m.get("NVDA"))).toBe("Large");
  });
  it("asks the API for the right spelling", () => {
    expect(snapshotSymbols(["NVDA", "CAT"], "US")).toEqual(["NVDA", "CAT"]);
    expect(snapshotSymbols(["TCS"], "IN")).toEqual(["TCS.NS"]);
  });
  it("links a US journal row to the US stock page", () => {
    expect(stockPath("NVDA", undefined, "US")).toBe("/stocks/NVDA");
    expect(stockPath("TCS")).toBe("/stocks/TCS.NS");
    expect(stockPath("TCS", snap("TCS.NS", "1"))).toBe("/stocks/TCS.NS");
  });
});

describe("US portfolio maths", () => {
  const open = [trade({ id: 1, qty: 2.5, buy_price: "150" }),
                trade({ id: 2, qty: 0.25, buy_price: "160" }),
                trade({ id: 3, symbol: "CAT", qty: 1, buy_price: "600" })];
  const ctx: JournalCtx = {
    capital: 10000, market: "US",
    snaps: journalSnaps([snap("NVDA", "170"), snap("CAT", "580")], "US"),
    openInvested: buildOpenInvested(open),
  };
  it("sums fractional lots as numbers", () => {
    expect(ctx.openInvested.get("NVDA")).toBeCloseTo(415, 6);
    const { holdings, totals } = buildPortfolio(open, ctx);
    const nvda = holdings.find((h) => h.symbol === "NVDA")!;
    expect(nvda.qty).toBeCloseTo(2.75, 6);
    expect(nvda.currentValue).toBeCloseTo(467.5, 6);
    expect(nvda.cap).toBe("Large");
    expect(totals.invested).toBeCloseTo(1015, 6);
  });
  it("applies the flat 5% limit through the US rule cap", () => {
    const a = planAllocation({ symbol: "NVDA", cap: effectiveCap(null, ctx.snaps.get("NVDA")),
                               buyPrice: 170, qty: 1, ctx });
    expect(a.limitPct).toBe(CAP_LIMITS.Large);
    expect(a.limitValue).toBe(500);
    expect(a.heldValue).toBeCloseTo(415, 6);
    expect(a.state).toBe("over");                     // 415 + 170 > 500
    expect(a.maxQty).toBe(0);
  });
});

describe("CSV import", () => {
  // Round trip through the journal's own export format.
  const csv = exportOpenTrades([
    trade({ id: 1, symbol: "NVDA", qty: 0.5, buy_price: "120.50" }),
    trade({ id: 2, symbol: "CAT", qty: 2, buy_price: "600" }),
  ]);
  it("keeps fractions for a US import and rounds for an Indian one", () => {
    const rows = parseCsv(csv);
    const loc = locateSheet(rows);
    expect(loc?.kind).toBe("open");
    if (!loc) return;
    const us = mapSheet(rows, loc, true);
    expect(us.trades.map((t) => [t.symbol, t.qty])).toEqual([["NVDA", 0.5], ["CAT", 2]]);
    expect(us.trades[0]?.buy_price).toBe("120.50");
    // The same sheet read as Indian: 0.5 rounds to 1 (whole shares only).
    const india = mapSheet(rows, loc);
    expect(india.trades.every((t) => Number.isInteger(t.qty))).toBe(true);
  });
});
