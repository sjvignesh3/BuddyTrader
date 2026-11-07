// -----------------------------------------------------------------------------
// IPO journal — pure derivations for the Journal → IPOs tab.
//
// Nothing here is stored: stage, gains, %, days held and money-locked all
// derive from the application row + its sells (+ a live LTP for shares
// still held). Charges are not tracked, so every ₹ figure is gross.
//
// Day counts are calendar days between ISO dates (UTC-parsed, so no time-
// zone drift): a listing-day sell is 0 days held.
// -----------------------------------------------------------------------------
import type { Ipo } from "./journalApi";
import { num } from "./journal";

export type IpoStage = "Applied" | "Not allotted" | "Allotted" | "Holding" | "Partly sold" | "Sold";

/** Today as YYYY-MM-DD in the viewer's local time. */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Calendar days from `a` to `b` (ISO dates). Null when either is missing. */
export function dayDiff(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const pa = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const pb = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return null;
  return Math.round((pb - pa) / 86_400_000);
}

export interface IpoDerived {
  stage: IpoStage;
  issue: number;
  /** Amount blocked by the ASBA mandate: every lot applied for × issue price. */
  blocked: number;
  allotted: number;
  invested: number;
  soldQty: number;
  held: number;
  soldValue: number;
  avgSell: number | null;
  /** Gross ₹ booked on the shares sold so far. */
  realised: number;
  /** Return % on the cost of the shares sold so far. */
  realisedPct: number | null;
  ltp: number | null;
  unrealised: number | null;
  /** realised + unrealised (unrealised counts 0 when no LTP is known). */
  totalPnl: number;
  /** totalPnl on the full invested amount. */
  returnPct: number | null;
  listingOpen: number | null;
  listingGainPct: number | null;
  listingCloseGainPct: number | null;
  /** What selling every allotted share at the listing open would have made. */
  listingOpenPnl: number | null;
  /** realised − listingOpenPnl, once fully sold: did holding pay? */
  edgeVsListing: number | null;
  lastSellDate: string | null;
  /** Listing day → final sell (or today while holding). */
  daysHeld: number | null;
  /** Application day → money free again (refund, final sell, or today). */
  lockDays: number | null;
  /** totalPnl per day of lock — compares a 3-day 8% with a 14-day 10%. */
  perDay: number | null;
}

export function deriveIpo(ipo: Ipo, ltp: number | null = null, today = localToday()): IpoDerived {
  const issue = num(ipo.issue_price) ?? 0;
  const blocked = issue * ipo.lot_size * ipo.lots_applied;
  const allotted = ipo.status === "ALLOTTED" ? ipo.shares_allotted ?? 0 : 0;
  const invested = allotted * issue;

  const sells = ipo.sells ?? [];
  const soldQty = sells.reduce((s, x) => s + x.qty, 0);
  const soldValue = sells.reduce((s, x) => s + x.qty * (num(x.sell_price) ?? 0), 0);
  const held = Math.max(0, allotted - soldQty);
  const realised = soldValue - soldQty * issue;
  const realisedPct = soldQty && issue ? (realised / (soldQty * issue)) * 100 : null;
  const unrealised = held && ltp !== null ? held * (ltp - issue) : null;
  const totalPnl = realised + (unrealised ?? 0);
  const returnPct = invested ? (totalPnl / invested) * 100 : null;

  const stage: IpoStage =
    ipo.status === "APPLIED" ? "Applied"
    : ipo.status === "NOT_ALLOTTED" ? "Not allotted"
    : soldQty >= allotted && allotted > 0 ? "Sold"
    : soldQty > 0 ? "Partly sold"
    : ipo.listing_date && ipo.listing_date <= today ? "Holding"
    : "Allotted";

  const listingOpen = num(ipo.listing_open);
  const listingClose = num(ipo.listing_close);
  const pct = (p: number | null) => (p !== null && issue ? ((p - issue) / issue) * 100 : null);
  const listingOpenPnl = listingOpen !== null && allotted ? allotted * (listingOpen - issue) : null;

  const lastSellDate = sells.reduce<string | null>(
    (m, s) => (m === null || s.sell_date > m ? s.sell_date : m), null);
  const exitDay = stage === "Sold" ? lastSellDate : today;
  const daysHeld = allotted ? dayDiff(ipo.listing_date, exitDay) : null;

  // Money is locked from the application until it is free again: refunded
  // (not allotted), fully sold, or — while still pending or held — today.
  const freeDay =
    ipo.status === "NOT_ALLOTTED" ? ipo.allotment_date
    : stage === "Sold" ? lastSellDate
    : today;
  const lockRaw = dayDiff(ipo.apply_date, freeDay);
  const lockDays = lockRaw === null ? null : Math.max(1, lockRaw);

  return {
    stage, issue, blocked, allotted, invested, soldQty, held, soldValue,
    avgSell: soldQty ? soldValue / soldQty : null,
    realised, realisedPct, ltp, unrealised, totalPnl, returnPct,
    listingOpen,
    listingGainPct: pct(listingOpen),
    listingCloseGainPct: pct(listingClose),
    listingOpenPnl,
    edgeVsListing: stage === "Sold" && listingOpenPnl !== null ? realised - listingOpenPnl : null,
    lastSellDate,
    daysHeld: daysHeld === null ? null : Math.max(0, daysHeld),
    lockDays,
    perDay: lockDays && allotted ? totalPnl / lockDays : null,
  };
}

// ---- Track record ------------------------------------------------------------------

export interface IpoSummary {
  applications: number;
  /** Results known (allotted + not allotted). */
  decided: number;
  allotted: number;
  /** allotted / decided, %. */
  hitRate: number | null;
  pending: number;
  /** Money blocked right now in applications awaiting allotment. */
  blockedNow: number;
  /** Cost of shares still held. */
  investedNow: number;
  realised: number;
  unrealised: number;
  avgListingGainPct: number | null;
  /** Average return % across fully-sold IPOs. */
  avgSoldReturnPct: number | null;
  avgDaysHeld: number | null;
  soldCount: number;
  wins: number;
  /** Σ (actual − sell-everything-at-listing-open) across fully-sold IPOs. */
  edgeVsListing: number | null;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarizeIpos(items: { ipo: Ipo; d: IpoDerived }[]): IpoSummary {
  const allotted = items.filter((x) => x.ipo.status === "ALLOTTED");
  const decided = items.filter((x) => x.ipo.status !== "APPLIED").length;
  const pending = items.filter((x) => x.ipo.status === "APPLIED");
  const sold = allotted.filter((x) => x.d.stage === "Sold");
  const edges = sold.map((x) => x.d.edgeVsListing).filter((v): v is number => v !== null);
  return {
    applications: items.length,
    decided,
    allotted: allotted.length,
    hitRate: decided ? (allotted.length / decided) * 100 : null,
    pending: pending.length,
    blockedNow: pending.reduce((s, x) => s + x.d.blocked, 0),
    investedNow: allotted.reduce((s, x) => s + x.d.held * x.d.issue, 0),
    realised: allotted.reduce((s, x) => s + x.d.realised, 0),
    unrealised: allotted.reduce((s, x) => s + (x.d.unrealised ?? 0), 0),
    avgListingGainPct: avg(allotted.map((x) => x.d.listingGainPct)
      .filter((v): v is number => v !== null)),
    avgSoldReturnPct: avg(sold.map((x) => x.d.realisedPct).filter((v): v is number => v !== null)),
    avgDaysHeld: avg(sold.map((x) => x.d.daysHeld).filter((v): v is number => v !== null)),
    soldCount: sold.length,
    wins: sold.filter((x) => x.d.realised > 0).length,
    edgeVsListing: edges.length ? edges.reduce((a, b) => a + b, 0) : null,
  };
}

/** Accounts offered in the form: the two defaults plus any already used. */
export const DEFAULT_ACCOUNTS = ["Self", "Father"];
export function accountsOf(ipos: Ipo[]): string[] {
  const seen = new Set(DEFAULT_ACCOUNTS);
  ipos.forEach((i) => seen.add(i.account));
  return [...seen];
}
