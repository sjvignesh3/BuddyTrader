import { describe, expect, it } from "vitest";
import type { Snapshot } from "./api";
import type { Trade } from "./journalApi";
import type { JournalCtx } from "./journal";
import {
  ABCD_DROP_PCT, abcdLegDraft, buildAbcdSignals, buildOpenInvested, deriveAbcd, legLabel,
  stockPath,
} from "./journal";

const trade = (over: Partial<Trade>): Trade => ({
  id: 1, opportunity_id: null, order_type: "GTT", cap_bucket: null, symbol: "TCS",
  buy_date: "2026-08-01", buy_price: "100", qty: 10, strategy: null, target_price: null,
  stop_price: null, status: "OPEN", close_label: null, sell_date: null, sell_price: null,
  comments: null, risk_notes: null, ...over,
});

const snap = (symbol: string, close: string, extra: Partial<Snapshot> = {}): Snapshot => ({
  symbol, snapshot_date: "2026-09-16", open: close, high: close, low: close, close,
  adj_close: close, volume: 0, ...extra,
});

const ctxOf = (capital: number, open: Trade[], snaps: Snapshot[] = []): JournalCtx => ({
  capital,
  snaps: new Map(snaps.map((s) => [s.symbol, s])),
  openInvested: buildOpenInvested(open),
});

// Capital 10L: Large limit 5% = ₹50,000; Small limit 2% = ₹20,000.
const CAPITAL = 1_000_000;

describe("legLabel", () => {
  it("letters the legs A, B, C… and falls back past Z", () => {
    expect(legLabel(0)).toBe("A");
    expect(legLabel(1)).toBe("B");
    expect(legLabel(3)).toBe("D");
    expect(legLabel(26)).toBe("#27");
  });
});

describe("deriveAbcd — thresholds and trigger", () => {
  it("returns null with no open lots", () => {
    expect(deriveAbcd([], ctxOf(CAPITAL, []))).toBeNull();
    const closed = trade({ status: "CLOSED", sell_price: "120", sell_date: "2026-09-01" });
    expect(deriveAbcd([closed], ctxOf(CAPITAL, []))).toBeNull();
  });

  it("with only leg A held, the next leg is B, triggered 10% below entry for Large/Mid", () => {
    const a = trade({ buy_price: "200", qty: 50, cap_bucket: "Large" });
    const ctx = ctxOf(CAPITAL, [a], [snap("TCS", "190")]);   // −5%: not yet
    const s = deriveAbcd([a], ctx)!;
    expect(s.nextLeg).toBe("B");
    expect(s.refLeg).toBe("A");
    expect(s.ref.id).toBe(a.id);
    expect(s.thresholdPct).toBe(10);
    expect(s.triggerPrice).toBeCloseTo(180);
    expect(s.targetPrice).toBe(200);          // B targets A's entry
    expect(s.fallPct).toBeCloseTo(5);
    expect(s.toTriggerPct).toBeCloseTo((190 - 180) / 190 * 100);
    expect(s.triggered).toBe(false);
    expect(s.zone).toBeNull();
  });

  it("flags leg B due once CMP is at/below the trigger", () => {
    const a = trade({ buy_price: "200", qty: 50, cap_bucket: "Mid" });
    const at = deriveAbcd([a], ctxOf(CAPITAL, [a], [snap("TCS", "180")]))!;
    expect(at.triggered).toBe(true);
    expect(at.zone).toBe("due");
    const below = deriveAbcd([a], ctxOf(CAPITAL, [a], [snap("TCS", "170")]))!;
    expect(below.fallPct).toBeCloseTo(15);
    expect(below.toTriggerPct).toBeLessThan(0);
    expect(below.zone).toBe("due");
  });

  it("uses the 15% threshold for Small/Micro", () => {
    const a = trade({ buy_price: "100", qty: 10, cap_bucket: "Small" });
    const notYet = deriveAbcd([a], ctxOf(CAPITAL, [a], [snap("TCS", "88")]))!; // −12%
    expect(notYet.thresholdPct).toBe(15);
    expect(notYet.triggerPrice).toBeCloseTo(85);
    expect(notYet.zone).toBeNull();
    const due = deriveAbcd([a], ctxOf(CAPITAL, [a], [snap("TCS", "85")]))!;
    expect(due.zone).toBe("due");
    const micro = trade({ buy_price: "100", qty: 10, cap_bucket: "Micro" });
    expect(deriveAbcd([micro], ctxOf(CAPITAL, [micro]))!.thresholdPct).toBe(ABCD_DROP_PCT.Micro);
  });

  it("takes the cap bucket from the snapshot when no lot sets one", () => {
    const a = trade({ buy_price: "100", qty: 10 });
    const ctx = ctxOf(CAPITAL, [a], [snap("TCS", "89", { cap_bucket: "Large Cap" } as Partial<Snapshot>)]);
    const s = deriveAbcd([a], ctx)!;
    expect(s.cap).toBe("Large");
    expect(s.zone).toBe("due");
  });

  it("cannot signal without a cap bucket or without CMP", () => {
    const a = trade({ buy_price: "100", qty: 10 });
    const noCap = deriveAbcd([a], ctxOf(CAPITAL, [a], [snap("TCS", "50")]))!;
    expect(noCap.thresholdPct).toBeNull();
    expect(noCap.triggerPrice).toBeNull();
    expect(noCap.zone).toBeNull();
    const noCmp = deriveAbcd([a], ctxOf(CAPITAL, [a]))!;
    expect(noCmp.cmp).toBeNull();
    expect(noCmp.triggered).toBe(false);
    expect(noCmp.zone).toBeNull();
  });

  it("accepts custom thresholds", () => {
    const a = trade({ buy_price: "100", qty: 10, cap_bucket: "Large" });
    const ctx = ctxOf(CAPITAL, [a], [snap("TCS", "93")]);
    expect(deriveAbcd([a], ctx)!.zone).toBeNull();
    const custom = { Large: 5, Mid: 5, Small: 8, Micro: 8 };
    const s = deriveAbcd([a], ctx, custom)!;
    expect(s.thresholdPct).toBe(5);
    expect(s.triggerPrice).toBeCloseTo(95);
    expect(s.zone).toBe("due");
  });
});

describe("deriveAbcd — legs and auto-clear", () => {
  it("references the LATEST leg by buy date (then id), whatever the array order", () => {
    const a = trade({ id: 1, buy_date: "2026-07-01", buy_price: "200", qty: 10, cap_bucket: "Large" });
    const b = trade({ id: 2, buy_date: "2026-08-15", buy_price: "180", qty: 10, cap_bucket: "Large" });
    const s = deriveAbcd([b, a], ctxOf(CAPITAL, [a, b], [snap("TCS", "178")]))!;
    expect(s.legs.map((l) => l.id)).toEqual([1, 2]);
    expect(s.ref.id).toBe(2);
    expect(s.refLeg).toBe("B");
    expect(s.nextLeg).toBe("C");
    expect(s.targetPrice).toBe(180);            // C targets B's entry
    expect(s.triggerPrice).toBeCloseTo(162);

    const sameDay = trade({ id: 3, buy_date: "2026-08-15", buy_price: "175", qty: 5, cap_bucket: "Large" });
    const s2 = deriveAbcd([sameDay, b, a], ctxOf(CAPITAL, [a, b, sameDay]))!;
    expect(s2.ref.id).toBe(3);
    expect(s2.nextLeg).toBe("D");
  });

  it("clears the signal once the averaging leg is logged, then re-arms for the next leg", () => {
    const a = trade({ id: 1, buy_date: "2026-07-01", buy_price: "200", qty: 10, cap_bucket: "Large" });
    // CMP 178: B is due (−11% from A).
    expect(deriveAbcd([a], ctxOf(CAPITAL, [a], [snap("TCS", "178")]))!.zone).toBe("due");

    // User takes leg B at 178. Same CMP → reference moves to B, drop is 0 → clear.
    const b = trade({ id: 2, buy_date: "2026-09-16", buy_price: "178", qty: 10, cap_bucket: "Large" });
    const after = deriveAbcd([a, b], ctxOf(CAPITAL, [a, b], [snap("TCS", "178")]))!;
    expect(after.zone).toBeNull();
    expect(after.nextLeg).toBe("C");
    expect(after.triggerPrice).toBeCloseTo(160.2);
    expect(after.targetPrice).toBe(178);

    // Falls another 10% below B → C is due.
    const later = deriveAbcd([a, b], ctxOf(CAPITAL, [a, b], [snap("TCS", "160")]))!;
    expect(later.zone).toBe("due");
    expect(later.nextLeg).toBe("C");
  });
});

describe("deriveAbcd — cap-limit room", () => {
  it("caps the suggested qty to what the limit allows at the trigger price", () => {
    // Large limit ₹50,000. Held 200 × 100 = ₹20,000 → ₹30,000 room; trigger 90 → 333 shares.
    const a = trade({ buy_price: "100", qty: 200, cap_bucket: "Large" });
    const s = deriveAbcd([a], ctxOf(CAPITAL, [a], [snap("TCS", "89")]))!;
    expect(s.maxQty).toBe(333);
    expect(s.roomValue).toBeCloseTo(30_000);
    expect(s.suggestedQty).toBe(200);          // mirrors the reference leg, fits
    expect(s.zone).toBe("due");

    // Held 400 × 100 = ₹40,000 → ₹10,000 room → 111 shares < ref qty 400.
    const big = trade({ buy_price: "100", qty: 400, cap_bucket: "Large" });
    const s2 = deriveAbcd([big], ctxOf(CAPITAL, [big], [snap("TCS", "89")]))!;
    expect(s2.maxQty).toBe(111);
    expect(s2.suggestedQty).toBe(111);
    expect(s2.zone).toBe("due");
  });

  it("marks the leg blocked when the price triggers but the limit leaves no room", () => {
    // Held 500 × 100 = ₹50,000 = exactly the Large limit.
    const a = trade({ buy_price: "100", qty: 500, cap_bucket: "Large" });
    const s = deriveAbcd([a], ctxOf(CAPITAL, [a], [snap("TCS", "85")]))!;
    expect(s.triggered).toBe(true);
    expect(s.maxQty).toBe(0);
    expect(s.suggestedQty).toBeNull();
    expect(s.zone).toBe("blocked");
    // Not triggered yet → no zone even when there is no room.
    const quiet = deriveAbcd([a], ctxOf(CAPITAL, [a], [snap("TCS", "95")]))!;
    expect(quiet.zone).toBeNull();
  });

  it("leaves room unknown (and the leg due) when capital is not set", () => {
    const a = trade({ buy_price: "100", qty: 10, cap_bucket: "Large" });
    const s = deriveAbcd([a], ctxOf(0, [a], [snap("TCS", "85")]))!;
    expect(s.maxQty).toBeNull();
    expect(s.suggestedQty).toBe(10);
    expect(s.zone).toBe("due");
  });
});

describe("buildAbcdSignals", () => {
  it("groups OPEN lots per symbol and ignores CLOSED rows", () => {
    const tcsA = trade({ id: 1, symbol: "TCS", buy_price: "100", qty: 10, cap_bucket: "Large" });
    const infyA = trade({ id: 2, symbol: "INFY", buy_price: "50", qty: 10, cap_bucket: "Small" });
    const infyOld = trade({ id: 3, symbol: "INFY", buy_price: "60", qty: 10, status: "CLOSED",
                            sell_price: "70", sell_date: "2026-06-01", buy_date: "2026-01-01" });
    const open = [tcsA, infyA];
    const ctx = ctxOf(CAPITAL, open, [snap("TCS", "89"), snap("INFY", "45")]);
    const m = buildAbcdSignals([tcsA, infyA, infyOld], ctx);
    expect([...m.keys()].sort()).toEqual(["INFY", "TCS"]);
    expect(m.get("TCS")!.zone).toBe("due");           // −11% vs 10%
    expect(m.get("INFY")!.zone).toBeNull();           // −10% vs 15%
    expect(m.get("INFY")!.legs).toHaveLength(1);      // closed lot is not a leg
  });
});

describe("abcdLegDraft", () => {
  it("prefills the next leg with target = previous entry and the ABCD strategy", () => {
    const a = trade({ buy_date: "2026-07-01", buy_price: "200", qty: 50, cap_bucket: "Large" });
    const due = abcdLegDraft(deriveAbcd([a], ctxOf(CAPITAL, [a], [snap("TCS", "176.5")]))!);
    expect(due.symbol).toBe("TCS");
    expect(due.cap_bucket).toBe("Large");
    expect(due.strategy).toBe("ABCD");
    expect(due.target_price).toBe("200");
    expect(due.buy_price).toBe("176.5");    // fired → buy at CMP
    expect(due.order_type).toBe("Instant");
    expect(due.qty).toBe(50);
    expect(due.comments).toMatch(/Leg B/);
    expect(due.comments).toMatch(/leg A entry ₹200/);

    const waiting = abcdLegDraft(deriveAbcd([a], ctxOf(CAPITAL, [a], [snap("TCS", "195")]))!);
    expect(waiting.buy_price).toBe("180");   // not fired → GTT at the trigger
    expect(waiting.order_type).toBe("GTT");
  });

  it("leaves cap_bucket to Auto when the lots never set one", () => {
    const a = trade({ buy_price: "100", qty: 10 });
    const ctx = ctxOf(CAPITAL, [a], [snap("TCS", "80", { cap_bucket: "Mid" } as Partial<Snapshot>)]);
    const d = abcdLegDraft(deriveAbcd([a], ctx)!);
    expect(d.cap_bucket).toBeNull();
    expect(d.target_price).toBe("100");
  });
});

describe("stockPath", () => {
  it("prefers the snapshot's yfinance spelling, else assumes NSE", () => {
    expect(stockPath("TCS", snap("TCS.NS", "100"))).toBe("/stocks/TCS.NS");
    expect(stockPath("TCS", snap("TCS.BO", "100"))).toBe("/stocks/TCS.BO");
    expect(stockPath("TCS")).toBe("/stocks/TCS.NS");
    expect(stockPath("TCS.BO")).toBe("/stocks/TCS.BO");
  });

  it("URL-encodes symbols with special characters", () => {
    expect(stockPath("M&M")).toBe("/stocks/M%26M.NS");
  });
});
