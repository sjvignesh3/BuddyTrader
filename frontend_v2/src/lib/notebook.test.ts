import { describe, expect, it } from "vitest";
import type { NotebookItem } from "./journalApi";
import { columnItems, dueState, filterItems, kindMeta, openCounts, sectionItems } from "./notebook";

const TODAY = "2026-11-11";

let seq = 0;
function item(over: Partial<NotebookItem> = {}): NotebookItem {
  seq += 1;
  return {
    id: seq, kind: "NOTE", title: `item ${seq}`, body: null, market: null, symbol: null,
    due_date: null, done: false, pinned: false, ...over,
  };
}

describe("dueState", () => {
  it("classifies by calendar days", () => {
    expect(dueState(item({ due_date: "2026-11-10" }), TODAY)).toBe("overdue");
    expect(dueState(item({ due_date: "2026-11-11" }), TODAY)).toBe("today");
    expect(dueState(item({ due_date: "2026-11-14" }), TODAY)).toBe("soon");
    expect(dueState(item({ due_date: "2026-11-30" }), TODAY)).toBe("later");
  });
  it("is null without a date or once done", () => {
    expect(dueState(item(), TODAY)).toBeNull();
    expect(dueState(item({ due_date: "2026-11-01", done: true }), TODAY)).toBeNull();
  });
});

describe("filterItems", () => {
  const items = [
    item({ kind: "TASK", market: "IN" }), item({ kind: "TASK", market: "US" }),
    item({ kind: "WATCH", market: "US" }), item({ kind: "NOTE" }),
  ];
  it("filters by kind and market", () => {
    expect(filterItems(items, "ALL", "ALL")).toHaveLength(4);
    expect(filterItems(items, "TASK", "ALL")).toHaveLength(2);
    expect(filterItems(items, "TASK", "US")).toHaveLength(1);
  });
  it("a market filter hides untagged items", () => {
    expect(filterItems(items, "ALL", "US").map((i) => i.kind)).toEqual(["TASK", "WATCH"]);
  });
});

describe("sectionItems", () => {
  it("splits pinned / open / done and never pins a done item", () => {
    const a = item({ pinned: true });
    const b = item();
    const c = item({ pinned: true, done: true });
    const s = sectionItems([a, b, c]);
    expect(s.pinned).toEqual([a]);
    expect(s.open).toEqual([b]);
    expect(s.done).toEqual([c]);
  });
  it("orders open items by due date, then newest first", () => {
    const old = item();
    const late = item({ due_date: "2026-12-01" });
    const early = item({ due_date: "2026-11-12" });
    const fresh = item();
    expect(sectionItems([old, late, early, fresh]).open).toEqual([early, late, fresh, old]);
  });
});

describe("board + counts", () => {
  it("a column holds one kind, pinned first, done left out", () => {
    const t1 = item({ kind: "TASK" });
    const t2 = item({ kind: "TASK", pinned: true });
    const t3 = item({ kind: "TASK", done: true });
    const n = item({ kind: "NOTE" });
    expect(columnItems([t1, t2, t3, n], "TASK")).toEqual([t2, t1]);
  });
  it("counts open items only", () => {
    const c = openCounts([item({ kind: "TASK" }), item({ kind: "TASK", done: true }),
                          item({ kind: "PLUTUS" })]);
    expect(c.ALL).toBe(2);
    expect(c.TASK).toBe(1);
    expect(c.PLUTUS).toBe(1);
    expect(c.WATCH).toBe(0);
  });
  it("only tasks and Plutus changes are checkable", () => {
    expect(kindMeta("TASK").checkable && kindMeta("PLUTUS").checkable).toBe(true);
    expect(kindMeta("TARGET").checkable || kindMeta("WATCH").checkable
      || kindMeta("NOTE").checkable).toBe(false);
  });
});
