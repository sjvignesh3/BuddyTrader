// -----------------------------------------------------------------------------
// Expense analytics engine — pure functions, no I/O.
//
// The backend stores raw rows only (journal precedent: derived values are
// never persisted). Everything the dashboard shows — monthly stats, category
// rollups, needs/wants, comparisons, plain-English insights — is derived
// here from the full expense list, which at personal scale (a few thousand
// rows/year) is trivially cheap to recompute in a useMemo.
//
// Money contract: amounts arrive as strings; we Number() them for analysis
// display only — results are never written back.
// -----------------------------------------------------------------------------
import type { Budget, Category, Expense, Intent, Recurring } from "./expensesApi";

export const num = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ---- Date helpers -------------------------------------------------------------

export const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** "2026-09-04" → "2026-09" */
export const monthKey = (iso: string): string => iso.slice(0, 7);

export const thisMonthKey = (): string => monthKey(todayIso());

/** "2026-09" + (-1) → "2026-08" */
export const addMonths = (key: string, delta: number): string => {
  const [y, m] = key.split("-").map(Number);
  const idx = (y ?? 0) * 12 + ((m ?? 1) - 1) + delta;
  const yy = Math.floor(idx / 12);
  const mm = (idx % 12) + 1;
  return `${yy}-${String(mm).padStart(2, "0")}`;
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09" → "Sep 2026" (short: "Sep"). */
export const monthLabel = (key: string, short = false): string => {
  const [y, m] = key.split("-").map(Number);
  const name = MONTH_NAMES[(m ?? 1) - 1] ?? key;
  return short ? name : `${name} ${y}`;
};

export const daysInMonth = (key: string): number => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y ?? 2000, m ?? 1, 0).getDate();
};

/** Days of the month that have already happened (full length for past months). */
export const elapsedDays = (key: string): number => {
  const today = todayIso();
  const cur = monthKey(today);
  if (key > cur) return 0;
  if (key < cur) return daysInMonth(key);
  return Number(today.slice(8, 10));
};

// ---- Category maps -------------------------------------------------------------

export interface CategoryMaps {
  byId: Map<number, Category>;
  roots: Category[];                       // top-level, unarchived, sorted
  childrenOf: Map<number, Category[]>;
  /** Top-level ancestor of any category id. */
  rootOf: (id: number | null) => Category | null;
  /** True when the category or its root is flagged exclude_from_spending. */
  isExcluded: (id: number | null) => boolean;
  /** "Food & Dining › Snacks & Cravings" (root-only names stay single). */
  label: (id: number | null) => string;
  /** Effective need/want for an expense: own value, else category default,
   * else the root category default. */
  intentOf: (e: Pick<Expense, "intent" | "category_id">) => Intent | null;
}

export function buildCategoryMaps(categories: Category[]): CategoryMaps {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const roots = categories
    .filter((c) => c.parent_id === null && !c.archived)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const childrenOf = new Map<number, Category[]>();
  for (const c of categories) {
    if (c.parent_id !== null && !c.archived) {
      const list = childrenOf.get(c.parent_id) ?? [];
      list.push(c);
      childrenOf.set(c.parent_id, list);
    }
  }
  childrenOf.forEach((list) =>
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)));

  const rootOf = (id: number | null): Category | null => {
    let c = id === null ? undefined : byId.get(id);
    while (c && c.parent_id !== null) c = byId.get(c.parent_id);
    return c ?? null;
  };
  const isExcluded = (id: number | null): boolean => {
    const c = id === null ? undefined : byId.get(id);
    if (!c) return false;
    return c.exclude_from_spending || (rootOf(id)?.exclude_from_spending ?? false);
  };
  const label = (id: number | null): string => {
    const c = id === null ? undefined : byId.get(id);
    if (!c) return "Uncategorised";
    if (c.parent_id === null) return c.name;
    const root = rootOf(id);
    return root && root.id !== c.id ? `${root.name} › ${c.name}` : c.name;
  };
  const intentOf = (e: Pick<Expense, "intent" | "category_id">): Intent | null => {
    if (e.intent) return e.intent;
    const c = e.category_id === null ? undefined : byId.get(e.category_id);
    return c?.default_intent ?? rootOf(e.category_id)?.default_intent ?? null;
  };
  return { byId, roots, childrenOf, rootOf, isExcluded, label, intentOf };
}

// ---- Monthly stats --------------------------------------------------------------

export interface MonthStats {
  key: string;
  total: number;                 // spending only (excluded categories out)
  txCount: number;
  needs: number;
  wants: number;
  unclassified: number;          // spending with no effective intent
  excludedTotal: number;         // investments / transfers logged this month
  recurringTotal: number;        // spending rows linked to a recurring template
  byRoot: Map<number, number>;   // root category id → spend (0 = uncategorised)
  bySub: Map<number, { total: number; count: number }>; // exact category id
  byDay: Map<string, number>;    // ISO date → spend
  byName: Map<string, { total: number; count: number }>;
  weekendTotal: number;
  weekendDays: number;
  weekdayTotal: number;
  weekdayDays: number;
}

const emptyStats = (key: string): MonthStats => ({
  key, total: 0, txCount: 0, needs: 0, wants: 0, unclassified: 0,
  excludedTotal: 0, recurringTotal: 0,
  byRoot: new Map(), bySub: new Map(), byDay: new Map(), byName: new Map(),
  weekendTotal: 0, weekendDays: 0, weekdayTotal: 0, weekdayDays: 0,
});

/** Group all expenses into per-month stats. Returns a map keyed "YYYY-MM". */
export function buildMonthlyStats(
  expenses: Expense[], maps: CategoryMaps,
): Map<string, MonthStats> {
  const out = new Map<string, MonthStats>();
  for (const e of expenses) {
    const key = monthKey(e.expense_date);
    let s = out.get(key);
    if (!s) { s = emptyStats(key); out.set(key, s); }
    const amt = num(e.amount);
    if (maps.isExcluded(e.category_id)) {
      s.excludedTotal += amt;
      continue;
    }
    s.total += amt;
    s.txCount += 1;
    if (e.recurring_id !== null) s.recurringTotal += amt;
    const intent = maps.intentOf(e);
    if (intent === "need") s.needs += amt;
    else if (intent === "want") s.wants += amt;
    else s.unclassified += amt;

    const rootId = maps.rootOf(e.category_id)?.id ?? 0;
    s.byRoot.set(rootId, (s.byRoot.get(rootId) ?? 0) + amt);
    const subId = e.category_id ?? 0;
    const sub = s.bySub.get(subId) ?? { total: 0, count: 0 };
    sub.total += amt; sub.count += 1;
    s.bySub.set(subId, sub);
    s.byDay.set(e.expense_date, (s.byDay.get(e.expense_date) ?? 0) + amt);
    const nameKey = e.name.trim().toLowerCase();
    const byName = s.byName.get(nameKey) ?? { total: 0, count: 0 };
    byName.total += amt; byName.count += 1;
    s.byName.set(nameKey, byName);
  }
  // Weekend/weekday split per month (only days with spend count).
  out.forEach((s) => {
    s.byDay.forEach((total, iso) => {
      const dow = new Date(`${iso}T00:00:00`).getDay();
      if (dow === 0 || dow === 6) { s.weekendTotal += total; s.weekendDays += 1; }
      else { s.weekdayTotal += total; s.weekdayDays += 1; }
    });
  });
  return out;
}

export const statsFor = (
  monthly: Map<string, MonthStats>, key: string,
): MonthStats => monthly.get(key) ?? emptyStats(key);

/** Average total of the N months before `key` that actually have data. */
export function trailingAverage(
  monthly: Map<string, MonthStats>, key: string, n: number,
): { avg: number; months: number } {
  let sum = 0; let count = 0;
  for (let i = 1; i <= n; i++) {
    const s = monthly.get(addMonths(key, -i));
    if (s && (s.total > 0 || s.txCount > 0)) { sum += s.total; count += 1; }
  }
  return { avg: count ? sum / count : 0, months: count };
}

/** Monthly-equivalent cost of the active recurring templates. */
export function recurringMonthlyLoad(recurring: Recurring[]): number {
  const factor: Record<string, number> = {
    weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12,
  };
  return recurring
    .filter((r) => r.active)
    .reduce((sum, r) => sum + num(r.amount) * (factor[r.frequency] ?? 1), 0);
}

// ---- Insights --------------------------------------------------------------------

export type InsightTone = "warn" | "info" | "good";

export interface Insight {
  tone: InsightTone;
  icon: string;
  text: string;
  /** Higher = shown first. */
  score: number;
}

const rupees = (n: number): string =>
  `₹${Math.round(n).toLocaleString("en-IN")}`;

const pctStr = (n: number): string => `${Math.round(Math.abs(n))}%`;

/**
 * Plain-English findings for one month. Rules only fire when there is
 * enough history to make them honest; the list grows richer as data
 * accumulates. Capped and sorted by relevance.
 */
export function buildInsights(opts: {
  monthKeySel: string;
  monthly: Map<string, MonthStats>;
  maps: CategoryMaps;
  budgets: Budget[];
  recurring: Recurring[];
}): Insight[] {
  const { monthKeySel, monthly, maps, budgets, recurring } = opts;
  const cur = statsFor(monthly, monthKeySel);
  const prev = statsFor(monthly, addMonths(monthKeySel, -1));
  const out: Insight[] = [];
  const rootName = (id: number): string =>
    id === 0 ? "Uncategorised" : maps.byId.get(id)?.name ?? "Unknown";

  // 1. Month-over-month change, attributed to its biggest driver.
  if (cur.total > 0 && prev.total > 0) {
    const diff = cur.total - prev.total;
    const pct = (diff / prev.total) * 100;
    if (Math.abs(pct) >= 8 && Math.abs(diff) >= 200) {
      let driverId = -1; let driverDiff = 0;
      const rootIds = new Set([...cur.byRoot.keys(), ...prev.byRoot.keys()]);
      rootIds.forEach((id) => {
        const d = (cur.byRoot.get(id) ?? 0) - (prev.byRoot.get(id) ?? 0);
        if ((diff > 0 && d > driverDiff) || (diff < 0 && d < driverDiff)) {
          driverId = id; driverDiff = d;
        }
      });
      const driver = driverId >= 0 && Math.abs(driverDiff) >= Math.abs(diff) * 0.3
        ? ` — mainly ${rootName(driverId)} (${driverDiff > 0 ? "+" : "−"}${rupees(Math.abs(driverDiff))})`
        : "";
      out.push({
        tone: diff > 0 ? "warn" : "good",
        icon: diff > 0 ? "📈" : "📉",
        score: 90 + Math.min(9, Math.abs(pct) / 10),
        text: `You spent ${rupees(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than ${monthLabel(prev.key)} (${diff > 0 ? "↑" : "↓"}${pctStr(pct)})${driver}.`,
      });
    }
  }

  // 2. vs trailing 3-month average.
  const t3 = trailingAverage(monthly, monthKeySel, 3);
  if (cur.total > 0 && t3.months >= 2) {
    const diff = cur.total - t3.avg;
    const pct = (diff / t3.avg) * 100;
    if (Math.abs(pct) >= 12 && Math.abs(diff) >= 300) {
      out.push({
        tone: diff > 0 ? "warn" : "good",
        icon: "🧭",
        score: 80,
        text: `This month is ${pctStr(pct)} ${diff > 0 ? "above" : "below"} your ${t3.months}-month average of ${rupees(t3.avg)}.`,
      });
    }
  }

  // 3. A category rising three months in a row.
  maps.roots.forEach((root) => {
    const a = statsFor(monthly, addMonths(monthKeySel, -2)).byRoot.get(root.id) ?? 0;
    const b = statsFor(monthly, addMonths(monthKeySel, -1)).byRoot.get(root.id) ?? 0;
    const c = cur.byRoot.get(root.id) ?? 0;
    if (a > 0 && b > a * 1.05 && c > b * 1.05 && c >= 300) {
      out.push({
        tone: "warn", icon: "🪜", score: 70,
        text: `${root.name} has risen three months running: ${rupees(a)} → ${rupees(b)} → ${rupees(c)}.`,
      });
    }
  });

  // 4. Death by a thousand cuts — many small purchases of one item.
  {
    let best: { name: string; count: number; total: number } | null = null;
    cur.byName.forEach((v, name) => {
      if (v.count >= 8 && v.total / v.count <= 250 &&
          (!best || v.total > best.total)) {
        best = { name, count: v.count, total: v.total };
      }
    });
    const b = best as { name: string; count: number; total: number } | null;
    if (b) {
      const label = b.name.replace(/\b\w/g, (ch) => ch.toUpperCase());
      out.push({
        tone: "info", icon: "🫘", score: 60,
        text: `${b.count} small "${label}" entries quietly add up to ${rupees(b.total)} this month.`,
      });
    }
  }

  // 5. Spending concentration.
  if (cur.total > 0 && cur.byRoot.size >= 4) {
    const sorted = [...cur.byRoot.entries()].sort((x, y) => y[1] - x[1]);
    const top3 = sorted.slice(0, 3);
    const share = top3.reduce((s, [, v]) => s + v, 0) / cur.total;
    if (share >= 0.7) {
      out.push({
        tone: "info", icon: "🎯", score: 50,
        text: `${pctStr(share * 100)} of this month came from just ${top3.map(([id]) => rootName(id)).join(", ")}.`,
      });
    }
  }

  // 6. Weekend multiplier.
  if (cur.weekendDays >= 2 && cur.weekdayDays >= 4) {
    const we = cur.weekendTotal / cur.weekendDays;
    const wd = cur.weekdayTotal / cur.weekdayDays;
    if (wd > 0 && we / wd >= 1.6) {
      out.push({
        tone: "info", icon: "🎡", score: 45,
        text: `Weekend days average ${rupees(we)} — ${(we / wd).toFixed(1)}× your weekday average of ${rupees(wd)}.`,
      });
    }
  }

  // 7. Positive: biggest category drop vs its 3-month average.
  if (t3.months >= 2) {
    let bestDrop: { name: string; pct: number; diff: number } | null = null;
    maps.roots.forEach((root) => {
      let sum = 0; let n = 0;
      for (let i = 1; i <= 3; i++) {
        const s = monthly.get(addMonths(monthKeySel, -i));
        if (s && (s.total > 0 || s.txCount > 0)) { sum += s.byRoot.get(root.id) ?? 0; n += 1; }
      }
      if (n < 2) return;
      const avg = sum / n;
      const now = cur.byRoot.get(root.id) ?? 0;
      const diff = avg - now;
      if (avg >= 300 && diff / avg >= 0.2 &&
          (!bestDrop || diff > bestDrop.diff)) {
        bestDrop = { name: root.name, pct: (diff / avg) * 100, diff };
      }
    });
    const bd = bestDrop as { name: string; pct: number; diff: number } | null;
    if (bd && cur.total > 0) {
      out.push({
        tone: "good", icon: "🌱", score: 55,
        text: `${bd.name} is down ${pctStr(bd.pct)} vs your recent average — ${rupees(bd.diff)} kept in your pocket.`,
      });
    }
  }

  // 8. Budget alerts (selected month).
  budgets.forEach((b) => {
    const limit = num(b.monthly_amount);
    if (limit <= 0) return;
    const spent = b.category_id === null
      ? cur.total
      : cur.byRoot.get(b.category_id) ?? cur.bySub.get(b.category_id)?.total ?? 0;
    const name = b.category_id === null
      ? "Overall" : maps.byId.get(b.category_id)?.name ?? "Category";
    if (spent > limit) {
      out.push({
        tone: "warn", icon: "🚨", score: 95,
        text: `${name} budget blown: ${rupees(spent)} of ${rupees(limit)} (${pctStr((spent / limit) * 100)}).`,
      });
    } else if (spent >= limit * 0.85) {
      out.push({
        tone: "info", icon: "⏳", score: 65,
        text: `${name} budget is ${pctStr((spent / limit) * 100)} used — ${rupees(limit - spent)} left for ${monthLabel(monthKeySel, true)}.`,
      });
    }
  });

  // 9. Locked-in recurring load (info, only when meaningful).
  const locked = recurringMonthlyLoad(recurring);
  if (locked > 0 && cur.total > 0) {
    out.push({
      tone: "info", icon: "🔒", score: 30,
      text: `Recurring commitments lock in ${rupees(locked)}/month before you spend a rupee by choice.`,
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}
