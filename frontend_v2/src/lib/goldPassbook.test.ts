import { describe, expect, it } from "vitest";
import type { PdfPageText, PdfTextItem } from "./pdfText";
import { checkTotals, mergeTxns, parseGrtDate, parseGrtPassbook } from "./grtPassbook";
import {
  analyseTxns, groupInsights, pctOfPaid, redemption, totalInsights, valueToday, windowProgress,
} from "./goldPassbookReport";
import type { RoundupOptions } from "./goldRoundup";

const OPTS: RoundupOptions = { benefitBp: 700, minPaise: 10000, bufferPaise: 0, wholeRupees: true, skipEdge: true };

// --- a synthetic page laid out like a real GRT passbook (Nov 2026) -----------
const item = (str: string, x: number, y: number, rot = 0): PdfTextItem => ({ str, x, y, rot });

interface Row { sno: number; date: string; ampm: string; amt: string; rate: string; tran: string; w: string; b: string; t: string; status?: string }

function rowItems(r: Row, y: number): PdfTextItem[] {
  const hi = y + 4.7, lo = y - 4.7;
  return [
    item(String(r.sno), 25, y),
    item(r.date, 53.4, hi), item(r.ampm, 53.4, lo),
    item(r.amt, 134, y),
    item(r.rate.slice(0, -1), 186.1, hi), item(r.rate.slice(-1), 186.1, lo),   // "13150.0" / "0"
    item("UPI", 228.7, hi), item("Payment", 228.7, lo),
    item(r.tran.slice(0, 22), 276.1, hi), item(r.tran.slice(22), 276.1, lo),
    item((r.status ?? "COMPLETED").slice(0, 7), 389.8, hi), item((r.status ?? "COMPLETED").slice(7), 389.8, lo),
    item(`${r.w} g`, 441.9, y), item(`${r.b} g`, 489.3, y), item(`${r.t} g`, 536.7, y),
  ];
}

const HEADER = [
  item("Membership No.:", 20, 643.9), item("GIL-0001", 100.5, 643.9),
  item("Plan Name:", 20, 633.2), item("GRT INSTA GOLD", 76.5, 633.2),
  item("Sno.", 23, 597.1), item("Tran. Date", 53.4, 597.1), item("Amount", 133, 597.1), item("Rate", 186.1, 597.1),
  item("Pay.", 228.7, 602.5), item("Mode", 228.7, 591.8), item("Tran. No.", 276.1, 597.1), item("Status", 389.8, 597.1),
  item("Weight", 440.9, 597.1), item("Benefit", 488.3, 597.1), item("Total", 535.7, 602.5), item("Wt.", 535.7, 591.8),
];

const ROWS: Row[] = [
  { sno: 3, date: "06-Nov-2026 04:48", ampm: "PM", amt: "100.00", rate: "13150.00", tran: "GIG06K26GIL1648000000002177580", w: "0.008", b: "0.001", t: "0.009" },
  { sno: 2, date: "05-Nov-2026 12:07", ampm: "PM", amt: "101.00", rate: "13385.00", tran: "GIG05K26GIL1207000000002158506", w: "0.008", b: "0.001", t: "0.009" },
  { sno: 1, date: "31-Oct-2026 12:37", ampm: "AM", amt: "109.00", rate: "12730.00", tran: "GIG31J26GIL0037000000002042988", w: "0.009", b: "0.001", t: "0.010" },
];

function page(rows: Row[], withTotal: boolean, total = { amt: "Rs.310.0", w: "0.025", b: "0.003", t: "0.028" }): PdfPageText {
  const items = [...HEADER, item("GRT INSTAGOLD", 121.9, 244.1, 40), item("Page 1 of 1 - Generated on: 2026-11-07 09:00", 410.7, 21.8)];
  rows.forEach((r, i) => items.push(...rowItems(r, 567.6 - i * 28.5)));
  if (withTotal) {
    const y = 567.6 - rows.length * 28.5 - 6;
    items.push(item("Total", 23, y), item(total.amt, 134, y + 5.4), item("0", 134, y - 5.3),
      item(`${total.w} g`, 440.9, y), item(`${total.b} g`, 488.3, y), item(`${total.t} g`, 535.7, y));
  }
  return items;
}

describe("parseGrtDate", () => {
  it("handles 12 AM / 12 PM", () => {
    expect(parseGrtDate("31-Oct-2026 12:37 AM")).toBe("2026-10-31T00:37");
    expect(parseGrtDate("06-Nov-2026 12:35 PM")).toBe("2026-11-06T12:35");
    expect(parseGrtDate("06-Nov-2026 04:48 PM")).toBe("2026-11-06T16:48");
    expect(parseGrtDate("nonsense")).toBeNull();
  });
});

describe("parseGrtPassbook", () => {
  const book = parseGrtPassbook([page(ROWS, true)]);

  it("reads every row, joining wrapped cells", () => {
    expect(book.problems).toEqual([]);
    expect(book.txns.map((t) => t.sno)).toEqual([1, 2, 3]);   // sorted by time
    const t = book.txns[2]!;
    expect(t).toMatchObject({
      when: "2026-11-06T16:48", day: "2026-11-06", amountPaise: 10000, ratePaise: 1315000,
      mode: "UPI Payment", tranNo: "GIG06K26GIL1648000000002177580", status: "COMPLETED",
      weightMg: 8, benefitMg: 1, totalMg: 9,
    });
  });

  it("reads header fields and the Total row, ignoring the watermark", () => {
    expect(book.membershipNo).toBe("GIL-0001");
    expect(book.planName).toBe("GRT INSTA GOLD");
    expect(book.totals).toEqual({ amountPaise: 31000, weightMg: 25, benefitMg: 3, totalMg: 28 });
    expect(checkTotals(book)).toEqual({ ok: true, diffs: [] });
  });

  it("flags a mismatch with the Total row", () => {
    const bad = parseGrtPassbook([page(ROWS, true, { amt: "Rs.410.0", w: "0.025", b: "0.003", t: "0.028" })]);
    expect(checkTotals(bad)).toEqual({ ok: false, diffs: [{ field: "amountPaise", rows: 31000, passbook: 41000 }] });
  });

  it("continues on a page without a header", () => {
    const p2 = page([ROWS[0]!], false).filter((i) => !HEADER.includes(i));
    const b = parseGrtPassbook([page(ROWS.slice(1), false), p2]);
    expect(b.txns).toHaveLength(3);
  });

  it("drops duplicate transactions across files", () => {
    const a = parseGrtPassbook([page(ROWS.slice(0, 2), false)]);
    const b = parseGrtPassbook([page(ROWS.slice(1), false)]);
    const m = mergeTxns([a, b]);
    expect(m.txns).toHaveLength(3);
    expect(m.duplicates).toBe(1);
  });
});

describe("report", () => {
  const book = parseGrtPassbook([page(ROWS, true)]);
  const ins = analyseTxns(book.txns, OPTS, "2026-10-31");

  it("splits each payment into exact + honest + rounding", () => {
    const i = ins[0]!;   // ₹109 at ₹12,730
    expect(i.exactG).toBeCloseTo(109 / 12730, 10);
    expect(i.honestG).toBeCloseTo(0.07 * 109 / 12730, 10);
    expect(i.exactG + i.honestG + i.roundingG).toBeCloseTo(0.010, 10);
    expect(i.honestRs).toBeCloseTo(7.63, 2);
    expect(i.roundingRs).toBeCloseTo(0.010 * 12730 - 109 * 1.07, 6);
    expect(ins.every((x) => x.ruleMatch)).toBe(true);
    expect(ins.every((x) => x.missedRs === 0)).toBe(true);
  });

  it("splits rounding into weight and benefit parts (₹100 at ₹13,160 → 0.008 + 0.001 g)", () => {
    const [i] = analyseTxns([{
      ...book.txns[0]!, day: "2026-11-07", when: "2026-11-07T11:41",
      amountPaise: 10000, ratePaise: 1316000, weightMg: 8, benefitMg: 1, totalMg: 9,
    }], OPTS, "2026-10-31");
    expect(i!.honestRs).toBeCloseTo(7.0, 10);                   // 7% of ₹100, never rounded
    expect(i!.weightRoundRs).toBeCloseTo(0.008 * 13160 - 100, 8); // ₹5.28
    expect(i!.benefitRoundRs).toBeCloseTo(0.001 * 13160 - 7, 8);  // ₹6.16
    expect(i!.roundingRs).toBeCloseTo(11.44, 8);
    expect(i!.honestRs + i!.benefitRoundRs).toBeCloseTo(13.16, 8); // the 0.001 g benefit is worth ₹13.16
  });

  it("day totals equal the sum of per-payment figures", () => {
    const day = groupInsights(ins, "day")[0]!;
    const first = ins.filter((x) => x.txn.day === day.key);
    const sum = (f: (x: typeof ins[number]) => number) => first.reduce((s, x) => s + f(x), 0);
    expect(day.honestRs).toBeCloseTo(sum((x) => x.honestRs), 10);
    expect(day.weightRoundRs + day.benefitRoundRs).toBeCloseTo(day.roundingRs, 10);
  });

  it("prices a missed best amount", () => {
    const worse = analyseTxns([{ ...book.txns[0]!, amountPaise: 11500, weightMg: 9, benefitMg: 1, totalMg: 10 }], OPTS, "2026-10-31");
    expect(worse[0]!.bestAmountPaise).toBe(10900);
    expect(worse[0]!.missedRs).toBeGreaterThan(5);
  });

  it("applies no benefit outside the 120-day window", () => {
    const late = analyseTxns(book.txns, OPTS, "2026-06-01");
    expect(late.every((x) => x.benefitBp === 0 && x.honestRs === 0)).toBe(true);
    expect(windowProgress(late, "2026-06-01", "2026-11-07").outside).toBe(3);
  });

  it("groups by day, week and month", () => {
    expect(groupInsights(ins, "day").map((g) => g.label)).toEqual(["31 Oct", "5 Nov", "6 Nov"]);
    expect(groupInsights(ins, "week").map((g) => g.label)).toEqual(["26 Oct – 1 Nov", "2 Nov – 8 Nov"]);
    expect(groupInsights(ins, "month").map((g) => [g.label, g.payments])).toEqual([["Oct 2026", 1], ["Nov 2026", 2]]);
  });

  it("today's gain = price + honest + rounding", () => {
    const v = valueToday(ins, 1300000);
    expect(v.gainRs).toBeCloseTo(v.priceRs + v.honestRs + v.roundingRs, 8);
    const t = totalInsights(ins);
    expect(v.valueRs).toBeCloseTo(0.028 * 13000, 8);
    expect(pctOfPaid(t.honestRs, t)).toBeCloseTo(0.07, 10);
    const r = redemption(v, t.paidRs, 2, 3);
    expect(r.costRs).toBeCloseTo(v.valueRs * 0.02 + v.valueRs * 1.02 * 0.03, 8);
  });

  it("projects the rest of the window from the pace so far", () => {
    const w = windowProgress(ins, "2026-10-31", "2026-11-07");
    expect(w.elapsed).toBe(8);
    expect(w.left).toBe(112);
    expect(w.end).toBe("2027-02-27");
    expect(w.projectedPaidRs).toBeCloseTo((310 / 8) * 112, 6);
  });
});
