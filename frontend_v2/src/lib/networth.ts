// -----------------------------------------------------------------------------
// Net Worth domain math — pure functions, no I/O, no UI.
//
//   manual assets − liabilities = net worth
//
// Net worth is manual-only by design: shares are entered as 'Direct Stocks'
// assets rather than pulled from the Trading Journal, so one number is never
// the sum of two overlapping sources. The journal is read for exactly one
// thing here — the money-weighted return (XIRR) of the trading book — which
// is a performance metric, not a balance.
//
// then everything the dashboard shows — allocation, month-over-month change,
// portfolio XIRR, emergency runway, savings rate, milestone ETAs, freedom
// projection, concentration checks and plain-English insights — is derived
// here from the raw rows. Only the monthly snapshot is ever persisted.
//
// Every function returns null / "insufficient" instead of inventing a value
// when the underlying data is missing. Money math is display math on
// Numbers parsed from the API's strings; nothing is written back as money.
// -----------------------------------------------------------------------------
import type { Insight } from "./expenses";
import { addMonths, monthLabel, type MonthStats } from "./expenses";
import type { Trade } from "./journalApi";
import type {
  Asset, AssetClass, IncomeRow, Liability, Milestone, NetWorthSnapshot,
  SnapshotBreakdown,
} from "./networthApi";

export const num = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : v;
  return Number.isFinite(n) ? n : 0;
};

const rupees = (n: number): string => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** "₹18.4L" / "₹1.02Cr" — the compact Indian scale for hero numbers. */
export function fmtIndian(n: number, digits = 1): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(digits)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(digits)}L`;
  return `${sign}₹${Math.round(abs).toLocaleString("en-IN")}`;
}

// ---- Aggregation ------------------------------------------------------------------

/** Cash-like classes that count toward the emergency runway. */
export const LIQUID_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>(["Cash", "FD"]);

/** Classes that are not "investable" — a home is wealth, not deployable capital. */
export const NON_INVESTABLE_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>(["Real Estate"]);

/** Classes that ARE equity exposure, counted alongside the journal's own
 * holdings when judging how equity-heavy the portfolio is. Mutual funds are
 * deliberately excluded: a fund may be equity, debt or hybrid and Plutus has
 * no way to tell, so counting one would make the observation dishonest. */
export const EQUITY_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>(["Direct Stocks"]);

export const activeAssets = (assets: Asset[]): Asset[] => assets.filter((a) => !a.archived);
export const activeLiabilities = (rows: Liability[]): Liability[] => rows.filter((l) => !l.archived);

export function sumAssets(assets: Asset[]): number {
  return activeAssets(assets).reduce((s, a) => s + num(a.current_value), 0);
}

export function sumLiabilities(rows: Liability[]): number {
  return activeLiabilities(rows).reduce((s, l) => s + num(l.outstanding), 0);
}

export function assetsByClass(assets: Asset[]): Map<AssetClass, number> {
  const m = new Map<AssetClass, number>();
  for (const a of activeAssets(assets)) {
    m.set(a.asset_class, (m.get(a.asset_class) ?? 0) + num(a.current_value));
  }
  return m;
}

export function liabilitiesByKind(rows: Liability[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of activeLiabilities(rows)) {
    m.set(l.kind, (m.get(l.kind) ?? 0) + num(l.outstanding));
  }
  return m;
}

export function liquidAssets(assets: Asset[]): number {
  return activeAssets(assets)
    .filter((a) => LIQUID_CLASSES.has(a.asset_class))
    .reduce((s, a) => s + num(a.current_value), 0);
}

/** ₹ of manual assets that are shares — equity the journal does not track. */
export function manualEquity(assets: Asset[]): number {
  return activeAssets(assets)
    .filter((a) => EQUITY_CLASSES.has(a.asset_class))
    .reduce((s, a) => s + num(a.current_value), 0);
}

/** Unrealised gain on a manual asset — only where a cost basis exists. */
export function assetGain(a: Asset): { gain: number; pct: number | null } | null {
  if (a.cost_basis === null || a.cost_basis === "") return null;
  const cost = num(a.cost_basis);
  const gain = num(a.current_value) - cost;
  return { gain, pct: cost > 0 ? (gain / cost) * 100 : null };
}

export interface NetWorthTotals {
  assets: number;        // all active manual assets
  liabilities: number;
  netWorth: number;      // assets − liabilities
}

export function computeNetWorth(p: { assets: number; liabilities: number }): NetWorthTotals {
  return { ...p, netWorth: p.assets - p.liabilities };
}

// ---- Allocation -----------------------------------------------------------------------

export interface AllocationSlice {
  key: AssetClass;
  label: string;
  value: number;
  pct: number;      // of total assets
}

export function allocation(assets: Asset[]): AllocationSlice[] {
  const slices: AllocationSlice[] = [];
  assetsByClass(assets).forEach((value, cls) => {
    if (value > 0) slices.push({ key: cls, label: cls, value, pct: 0 });
  });
  const total = slices.reduce((s, x) => s + x.value, 0);
  return slices
    .map((s) => ({ ...s, pct: total ? (s.value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

/** The breakdown persisted with a snapshot — money as strings, so the JSONB
 * record carries exactly what was shown and never a float. */
export function snapshotBreakdown(assets: Asset[], liabilities: Liability[]): SnapshotBreakdown {
  const a: Record<string, string> = {};
  assetsByClass(assets).forEach((v, k) => { a[k] = v.toFixed(2); });
  const l: Record<string, string> = {};
  liabilitiesByKind(liabilities).forEach((v, k) => { l[k] = v.toFixed(2); });
  return { assets: a, liabilities: l };
}

/** Equity a snapshot recorded: its Direct Stocks bucket plus the legacy
 * journal-derived equity_value from before Net Worth went manual-only. */
export function snapshotEquity(s: NetWorthSnapshot): number {
  return num(s.equity_value) + num(s.breakdown?.assets?.["Direct Stocks"]);
}

/** Everything a snapshot counted on the asset side (legacy equity included). */
export function snapshotAssets(s: NetWorthSnapshot): number {
  return num(s.equity_value) + num(s.assets_value);
}

// ---- History ---------------------------------------------------------------------------

export const monthKeyOf = (iso: string): string => iso.slice(0, 7);

/** Snapshots oldest → newest. */
export function sortSnapshots(snaps: NetWorthSnapshot[]): NetWorthSnapshot[] {
  return [...snaps].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
}

/** The most recent snapshot taken BEFORE the given month — the baseline for
 * "this month's change". */
export function baselineSnapshot(
  snaps: NetWorthSnapshot[], currentMonth: string,
): NetWorthSnapshot | null {
  const earlier = sortSnapshots(snaps).filter((s) => monthKeyOf(s.snapshot_date) < currentMonth);
  return earlier.length ? earlier[earlier.length - 1]! : null;
}

export interface Delta { abs: number; pct: number | null }

export function changeSince(current: number, previous: number | null): Delta | null {
  if (previous === null) return null;
  return { abs: current - previous, pct: previous !== 0 ? ((current - previous) / Math.abs(previous)) * 100 : null };
}

/** Count of consecutive month-over-month increases ending at the latest
 * snapshot (0 when the latest month fell or there is only one point). */
export function growthStreak(snaps: NetWorthSnapshot[]): number {
  const s = sortSnapshots(snaps);
  let streak = 0;
  for (let i = s.length - 1; i > 0; i--) {
    if (num(s[i]!.net_worth) > num(s[i - 1]!.net_worth)) streak += 1;
    else break;
  }
  return streak;
}

// ---- XIRR (money-weighted return) --------------------------------------------------------

export interface Cashflow { date: string; amount: number } // negative = money in

const DAY = 86_400_000;

function yearsBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / DAY / 365;
}

/** Annualised money-weighted return of dated cashflows. Newton–Raphson with a
 * bisection fallback; null when the flows have no sign change or no root in
 * (−99%, +1000%). */
export function xirr(flows: Cashflow[]): number | null {
  if (flows.length < 2) return null;
  const hasNeg = flows.some((f) => f.amount < 0);
  const hasPos = flows.some((f) => f.amount > 0);
  if (!hasNeg || !hasPos) return null;
  const t0 = flows.reduce((m, f) => (f.date < m ? f.date : m), flows[0]!.date);
  const ts = flows.map((f) => ({ t: yearsBetween(t0, f.date), a: f.amount }));
  const npv = (r: number) => ts.reduce((s, f) => s + f.a / Math.pow(1 + r, f.t), 0);
  const dnpv = (r: number) => ts.reduce((s, f) => s - (f.t * f.a) / Math.pow(1 + r, f.t + 1), 0);

  let r = 0.1;
  for (let i = 0; i < 50; i++) {
    const f = npv(r); const d = dnpv(r);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (next <= -0.99 || next > 10 || !Number.isFinite(next)) break;
    if (Math.abs(next - r) < 1e-9) return next;
    r = next;
  }
  // Bisection on a wide bracket.
  let lo = -0.99; let hi = 10;
  let flo = npv(lo); const fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-7 || hi - lo < 1e-9) return mid;
    if (flo * fm < 0) { hi = mid; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/** Journal trades → cashflows: every buy is money out on buy_date, every
 * sell is money in on sell_date, and the open book is valued at `asOf`. */
export function portfolioCashflows(trades: Trade[], currentValue: number, asOf: string): Cashflow[] {
  const flows: Cashflow[] = [];
  for (const t of trades) {
    const buy = num(t.buy_price) * t.qty;
    if (buy > 0 && t.buy_date) flows.push({ date: t.buy_date, amount: -buy });
    if (t.status === "CLOSED" && t.sell_date && t.sell_price !== null) {
      flows.push({ date: t.sell_date, amount: num(t.sell_price) * t.qty });
    }
  }
  if (currentValue > 0) flows.push({ date: asOf, amount: currentValue });
  return flows;
}

export interface XirrResult {
  rate: number | null;     // % p.a.
  flows: number;
  spanDays: number;
  reason: string | null;   // why it is unavailable
}

export const XIRR_MIN_SPAN_DAYS = 30;

export function portfolioXirr(trades: Trade[], currentValue: number, asOf: string): XirrResult {
  const flows = portfolioCashflows(trades, currentValue, asOf);
  const buys = flows.filter((f) => f.amount < 0);
  if (!buys.length) return { rate: null, flows: flows.length, spanDays: 0, reason: "No buys in the journal yet." };
  const first = buys.reduce((m, f) => (f.date < m ? f.date : m), buys[0]!.date);
  const spanDays = Math.round(yearsBetween(first, asOf) * 365);
  if (spanDays < XIRR_MIN_SPAN_DAYS) {
    return { rate: null, flows: flows.length, spanDays,
             reason: `Only ${spanDays} day${spanDays === 1 ? "" : "s"} of history — XIRR needs at least ${XIRR_MIN_SPAN_DAYS}.` };
  }
  const r = xirr(flows);
  if (r === null) return { rate: null, flows: flows.length, spanDays, reason: "Cashflows do not resolve to a return yet." };
  return { rate: r * 100, flows: flows.length, spanDays, reason: null };
}

// ---- Emergency runway ------------------------------------------------------------------------

export type RunwayState = "danger" | "caution" | "healthy";

/** Months of runway that separate the states — kept here so they can become
 * a setting later without touching the callers. */
export const RUNWAY_THRESHOLDS = { danger: 3, healthy: 6 } as const;

export interface Runway { months: number | null; state: RunwayState | null }

export function runway(liquid: number, avgBurn: number): Runway {
  if (!(avgBurn > 0)) return { months: null, state: null };
  const months = liquid / avgBurn;
  const state: RunwayState = months < RUNWAY_THRESHOLDS.danger ? "danger"
    : months < RUNWAY_THRESHOLDS.healthy ? "caution" : "healthy";
  return { months, state };
}

/** Average spend of the last `n` COMPLETED months before `currentMonth` that
 * have data — the burn rate the runway divides by. */
export function averageBurn(
  monthly: Map<string, MonthStats>, currentMonth: string, n = 3,
): { avg: number; months: number } {
  let sum = 0; let count = 0;
  for (let i = 1; i <= n; i++) {
    const s = monthly.get(addMonths(currentMonth, -i));
    if (s && s.total > 0) { sum += s.total; count += 1; }
  }
  return { avg: count ? sum / count : 0, months: count };
}

// ---- Savings rate ------------------------------------------------------------------------------

export function savingsRate(income: number | null, expenses: number): number | null {
  if (income === null || !(income > 0)) return null;
  return ((income - expenses) / income) * 100;
}

export interface SavingsPoint {
  key: string;            // "YYYY-MM"
  income: number | null;  // null = not entered
  expenses: number;
  rate: number | null;
}

export function incomeByMonth(rows: IncomeRow[]): Map<string, number> {
  const m = new Map<string, number>();
  rows.forEach((r) => m.set(monthKeyOf(r.month), num(r.amount)));
  return m;
}

/** Rate per month for the given keys (oldest → newest as passed). */
export function savingsSeries(
  keys: string[], income: Map<string, number>, monthly: Map<string, MonthStats>,
): SavingsPoint[] {
  return keys.map((key) => {
    const inc = income.has(key) ? income.get(key)! : null;
    const exp = monthly.get(key)?.total ?? 0;
    return { key, income: inc, expenses: exp, rate: savingsRate(inc, exp) };
  });
}

/** Mean of the last `n` points that have a rate (null when none). */
export function averageRate(series: SavingsPoint[], n: number): { avg: number | null; months: number } {
  const pts = series.filter((p) => p.rate !== null).slice(-n);
  if (!pts.length) return { avg: null, months: 0 };
  return { avg: pts.reduce((s, p) => s + (p.rate ?? 0), 0) / pts.length, months: pts.length };
}

// ---- Milestones -----------------------------------------------------------------------------------

export interface MilestoneProgress {
  target: number;
  pct: number;          // clamped 0..100
  remaining: number;    // ≥ 0
  achieved: boolean;
}

export function milestoneProgress(m: Milestone, netWorth: number): MilestoneProgress {
  const target = num(m.target);
  const pct = target > 0 ? Math.max(0, Math.min(100, (netWorth / target) * 100)) : 0;
  return { target, pct, remaining: Math.max(0, target - netWorth), achieved: netWorth >= target };
}

export interface GrowthTrend {
  perMonth: number;     // average monthly Δ over the window
  months: number;       // number of month gaps used
  volatile: boolean;    // std-dev of monthly Δ exceeds the mean Δ
}

export const ETA_MIN_SNAPSHOTS = 3;

/** Average monthly change across the last snapshots (needs ≥ 3 points). */
export function growthTrend(snaps: NetWorthSnapshot[], window = 6): GrowthTrend | null {
  const s = sortSnapshots(snaps).slice(-(window + 1));
  if (s.length < ETA_MIN_SNAPSHOTS) return null;
  const deltas: number[] = [];
  for (let i = 1; i < s.length; i++) {
    const gap = Math.max(1, Math.round(yearsBetween(s[i - 1]!.snapshot_date, s[i]!.snapshot_date) * 12));
    deltas.push((num(s[i]!.net_worth) - num(s[i - 1]!.net_worth)) / gap);
  }
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const sd = Math.sqrt(deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / deltas.length);
  return { perMonth: mean, months: deltas.length, volatile: mean <= 0 || sd > Math.abs(mean) };
}

export interface MilestoneEta {
  months: number | null;   // null = cannot be estimated
  monthKey: string | null; // "YYYY-MM" the target is reached, at the current trend
  basis: string;           // how it was estimated / why it wasn't
  rough: boolean;          // true when the trend is volatile — show as "~"
}

export function milestoneEta(
  target: number, netWorth: number, snaps: NetWorthSnapshot[], currentMonth: string,
): MilestoneEta {
  if (netWorth >= target) return { months: 0, monthKey: currentMonth, basis: "reached", rough: false };
  const trend = growthTrend(snaps);
  if (!trend) {
    return { months: null, monthKey: null, rough: true,
             basis: `Needs ${ETA_MIN_SNAPSHOTS} monthly snapshots to estimate a pace.` };
  }
  if (trend.perMonth <= 0) {
    return { months: null, monthKey: null, rough: true,
             basis: `Net worth has not grown on average over the last ${trend.months} months.` };
  }
  const months = Math.ceil((target - netWorth) / trend.perMonth);
  return {
    months, monthKey: addMonths(currentMonth, months), rough: trend.volatile,
    basis: `At the average of ${rupees(trend.perMonth)}/month over the last ${trend.months} months.`,
  };
}

// ---- Financial freedom -----------------------------------------------------------------------------

export interface FreedomProjection {
  progressPct: number;            // current / target
  monthlyRate: number;            // real return per month (fraction)
  monthsToTarget: number | null;  // null = never at these inputs
  monthKey: string | null;
  projectedAt: (months: number) => number;  // corpus after n months
}

export function freedomProjection(p: {
  current: number; monthlySavings: number; realReturnPct: number; target: number;
  currentMonth: string;
}): FreedomProjection | null {
  if (!(p.target > 0)) return null;
  const r = Math.pow(1 + p.realReturnPct / 100, 1 / 12) - 1;
  const fv = (n: number) => r === 0
    ? p.current + p.monthlySavings * n
    : p.current * Math.pow(1 + r, n) + p.monthlySavings * ((Math.pow(1 + r, n) - 1) / r);
  let months: number | null;
  if (p.current >= p.target) months = 0;
  else if (r === 0) months = p.monthlySavings > 0 ? Math.ceil((p.target - p.current) / p.monthlySavings) : null;
  else {
    const numer = p.target * r + p.monthlySavings;
    const denom = p.current * r + p.monthlySavings;
    months = numer > 0 && denom > 0 && numer > denom
      ? Math.ceil(Math.log(numer / denom) / Math.log(1 + r)) : null;
  }
  return {
    progressPct: Math.max(0, Math.min(100, (p.current / p.target) * 100)),
    monthlyRate: r,
    monthsToTarget: months,
    monthKey: months === null ? null : addMonths(p.currentMonth, months),
    projectedAt: fv,
  };
}

/** Corpus needed TODAY to coast to `target` in `years` with no further
 * savings, at the given real return. */
export function coastCorpus(target: number, realReturnPct: number, years: number): number | null {
  if (!(target > 0) || !(years >= 0)) return null;
  return target / Math.pow(1 + realReturnPct / 100, years);
}

// ---- Concentration / diversification health -----------------------------------------------------

export interface HealthCheck { tone: "warn" | "good" | "info"; text: string }

export const HEALTH_LIMITS = {
  equityOfInvestablePct: 70,        // direct stocks vs investable assets
  debtToAssetsPct: 50,              // liabilities vs total assets
} as const;

export function concentrationChecks(p: {
  totals: NetWorthTotals; assets: Asset[]; runway: Runway;
}): HealthCheck[] {
  const out: HealthCheck[] = [];
  const { totals } = p;
  if (totals.netWorth <= 0 && totals.assets <= 0) return out;

  // 1. Equity (Direct Stocks) vs investable assets (real estate excluded).
  const nonInvestable = activeAssets(p.assets)
    .filter((a) => NON_INVESTABLE_CLASSES.has(a.asset_class))
    .reduce((s, a) => s + num(a.current_value), 0);
  const investable = totals.assets - nonInvestable;
  const equity = manualEquity(p.assets);
  if (investable > 0 && equity > 0) {
    const share = (equity / investable) * 100;
    out.push({
      tone: share >= HEALTH_LIMITS.equityOfInvestablePct ? "warn" : "info",
      text: `${share.toFixed(0)}% of your investable assets are in equities.`,
    });
  }
  // 2. Runway.
  if (p.runway.months !== null) {
    out.push({
      tone: p.runway.state === "healthy" ? "good" : p.runway.state === "caution" ? "info" : "warn",
      text: `Cash + FD cover ${p.runway.months.toFixed(1)} months of average expenses.`,
    });
  }
  // 3. Debt load.
  if (totals.assets > 0 && totals.liabilities > 0) {
    const ratio = (totals.liabilities / totals.assets) * 100;
    out.push({
      tone: ratio >= HEALTH_LIMITS.debtToAssetsPct ? "warn" : "info",
      text: `Liabilities are ${ratio.toFixed(0)}% of your total assets.`,
    });
  }
  return out;
}

// ---- Insight engine -------------------------------------------------------------------------------

export function buildNetWorthInsights(p: {
  totals: NetWorthTotals;
  snaps: NetWorthSnapshot[];
  currentMonth: string;
  monthly: Map<string, MonthStats>;
  savings: SavingsPoint[];        // oldest → newest, ending at currentMonth
  assets: Asset[];
  runway: Runway;
}): Insight[] {
  const out: Insight[] = [];
  const { totals, snaps, currentMonth } = p;
  const sorted = sortSnapshots(snaps);

  if (sorted.length < 2) {
    out.push({
      tone: "info", icon: "📸", score: 100,
      text: sorted.length === 0
        ? "Take your first monthly snapshot — trends and month-over-month insights unlock after two."
        : "One snapshot so far — take next month's to see how your wealth is moving.",
    });
  }

  // 1. Growth streak.
  const streak = growthStreak(snaps);
  if (streak >= 2) {
    out.push({ tone: "good", icon: "📈", score: 90,
               text: `Your net worth increased for ${streak} consecutive months.` });
  }

  // 2. This month's change, decomposed into its driver.
  const base = baselineSnapshot(snaps, currentMonth);
  if (base) {
    // Stock holdings are compared like-for-like: today's Direct Stocks vs
    // what the baseline recorded for them (plus its legacy journal equity),
    // so re-entering the journal's positions by hand is not read as a move.
    const dNw = totals.netWorth - num(base.net_worth);
    const curEq = manualEquity(p.assets);
    const dEq = curEq - snapshotEquity(base);
    const dAs = (totals.assets - curEq) - (snapshotAssets(base) - snapshotEquity(base));
    const dLi = -(totals.liabilities - num(base.liabilities_value));
    if (Math.abs(dNw) >= 1000) {
      const parts = [
        { name: "your stock holdings", v: dEq },
        { name: "changes in other assets", v: dAs },
        { name: "debt paid down", v: dLi },
      ].filter((x) => Math.sign(x.v) === Math.sign(dNw));
      const driver = parts.sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
      if (driver && Math.abs(driver.v) / Math.abs(dNw) >= 0.5) {
        const share = Math.min(100, Math.round((Math.abs(driver.v) / Math.abs(dNw)) * 100));
        out.push({
          tone: dNw > 0 ? "good" : "warn", icon: dNw > 0 ? "🧱" : "📉", score: 85,
          text: `${share}% of this month's net-worth ${dNw > 0 ? "increase" : "decrease"} came from ${driver.name}.`,
        });
      }
    }
    // 3. Spending-driven slowdown.
    const prevBase = baselineSnapshot(snaps, monthKeyOf(base.snapshot_date));
    const curSpend = p.monthly.get(currentMonth)?.total ?? 0;
    const prevSpend = p.monthly.get(addMonths(currentMonth, -1))?.total ?? 0;
    if (prevBase && prevSpend > 0 && curSpend > prevSpend * 1.15) {
      const prevGrowth = num(base.net_worth) - num(prevBase.net_worth);
      if (dNw < prevGrowth) {
        const up = Math.round(((curSpend - prevSpend) / prevSpend) * 100);
        out.push({
          tone: "warn", icon: "🛒", score: 80,
          text: `Net-worth growth slowed this month while expenses rose ${up}% versus ${monthLabel(addMonths(currentMonth, -1), true)}.`,
        });
      }
    }
  }

  // 4. Savings-rate movement over three months.
  const rated = p.savings.filter((s) => s.rate !== null);
  if (rated.length >= 3) {
    const a = rated[rated.length - 3]!.rate!; const b = rated[rated.length - 1]!.rate!;
    if (Math.abs(b - a) >= 5) {
      out.push({
        tone: b > a ? "good" : "warn", icon: "🏦", score: 70,
        text: `Your savings rate ${b > a ? "improved" : "fell"} from ${Math.round(a)}% to ${Math.round(b)}% over the last three months.`,
      });
    }
  }

  // 5. Runway.
  if (p.runway.months !== null) {
    out.push({
      tone: p.runway.state === "healthy" ? "good" : p.runway.state === "caution" ? "info" : "warn",
      icon: "🛟", score: 60,
      text: `Your liquid assets cover about ${p.runway.months.toFixed(1)} months of average spending.`,
    });
  } else if (totals.assets > 0) {
    out.push({
      tone: "info", icon: "🛟", score: 20,
      text: "Runway needs a month of expenses in the Expense Tracker and a Cash or FD asset here.",
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}
