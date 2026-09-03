// -----------------------------------------------------------------------------
// Row model for the pool table — merges a snapshot with its stock metadata
// and scan results into the exact shape the BuddyTrader view rendered.
// Numbers are converted from the wire's money-safe strings ONCE here, for
// display/sort only (never fed back into any computation).
// -----------------------------------------------------------------------------
import type { ScanResult, Snapshot, Stock } from "./api";

export interface FundaCheck {
  id: string;
  label: string;
  passed: boolean | null;
  detail: string;
}

export interface FundaScore {
  points: number;
  pointsMax: number;
  unknown: number;
  checks: FundaCheck[];
  data: Record<string, string | null>;
}

export interface StockRow {
  symbol: string;
  sector: string | null;
  cap: string | null;
  close: number | null;
  dma200: number | null;
  belowDmaPct: number | null;
  low52w: number | null;
  high52w: number | null;
  fromLowPct: number | null;
  ath: number | null;
  downFromAthPct: number | null;
  trendPct: number | null;
  score: number | null;          // funda points (out of 11)
  bestStatus: string | null;     // strongest TECHNICAL signal
  daysSinceRally: number | null;
  pctToNextBuy: number | null;   // (close - last_rally_low) / low * 100
  rallyPct: number | null;
  hasRally: boolean;
  rallyLow: number | null;
  rallyHigh: number | null;
  marketCapCr: number | null;
  pe: number | null;
  pb: number | null;
  funda: FundaScore | null;
  results: ScanResult[];         // all strategies, for the expanded row
  snapshot: Snapshot;
}

// Cap-aware "deep fall from ATH" rule — a stock only counts as beaten-down
// once its fall from ATH clears the bar for its size class:
//   Large > 20% · Mid > 30% · Small & Micro > 40%.
export const ATH_FALL_RULE: Record<string, number> = {
  Large: 20, Mid: 30, Small: 40, Micro: 40,
};

/** Threshold for a cap bucket (unknown cap falls back to the Mid bar). */
export function athFallThreshold(cap: string | null): number {
  return (cap && ATH_FALL_RULE[cap]) || 30;
}

/** true = clears the rule · false = short of it · null = not computable. */
export function passesAthRule(r: Pick<StockRow, "cap" | "downFromAthPct">): boolean | null {
  if (r.downFromAthPct === null) return null;
  return r.downFromAthPct > athFallThreshold(r.cap);
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Legacy best_status ordering for the Signal column (technical only).
const TECH_RANK: Record<string, number> = {
  BUY_ZONE: 4, OPPORTUNITY: 3, VALID: 2, NO_SIGNAL: 1, INVALID: 1,
};
const TECH_STRATEGIES = new Set([
  "envelope_200dma", "week52_high_low", "rally_20_percent",
]);

export function parseFunda(r: ScanResult | undefined): FundaScore | null {
  const ms = r?.metrics_snapshot as Record<string, unknown> | undefined;
  if (!ms || ms.points === undefined) return null;
  const checks = Array.isArray(ms.checks) ? (ms.checks as FundaCheck[]) : [];
  const data: Record<string, string | null> = {};
  const rawData = (ms.data ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawData)) {
    data[k] = v === null || v === undefined ? null : String(v);
  }
  return {
    points: Number(ms.points),
    pointsMax: Number(ms.points_max ?? 11),
    unknown: Number(ms.unknown ?? 0),
    checks,
    data,
  };
}

export function buildRows(
  snapshots: Snapshot[],
  stocksBySymbol: Map<string, Stock>,
  resultsBySymbol: Map<string, ScanResult[]>,
): StockRow[] {
  return snapshots.map((s) => {
    const stock = stocksBySymbol.get(s.symbol);
    const results = resultsBySymbol.get(s.symbol) ?? [];
    const fundaResult = results.find((r) => r.strategy_id === "fundamental_screener");
    const funda = parseFunda(fundaResult);
    // Legacy "NOT IN CACHE" semantics: when every check is unknown the
    // symbol was never fundamentally scored — show a dash, not a red 0/11.
    const notScored = funda !== null && funda.unknown >= funda.pointsMax;

    let bestStatus: string | null = null;
    let bestRank = 0;
    for (const r of results) {
      if (!TECH_STRATEGIES.has(r.strategy_id)) continue;
      const rank = TECH_RANK[r.status] ?? 0;
      if (rank > bestRank) {
        bestRank = rank;
        bestStatus = r.status;
      }
    }

    const close = num(s.close);
    const rallyLow = num(s.last_rally_low);
    let pctToNextBuy: number | null = null;
    if (close !== null && rallyLow !== null && rallyLow > 0) {
      pctToNextBuy = ((close - rallyLow) / rallyLow) * 100;
    }
    const mcap = num(s.market_cap);

    return {
      symbol: s.symbol,
      sector: stock?.sector ?? null,
      cap: (s.cap_bucket as string | null) ?? stock?.cap_type_manual ?? null,
      close,
      dma200: num(s.dma_200),
      belowDmaPct: num(s.below_200dma_pct),
      low52w: num(s.low_52w),
      high52w: num(s.high_52w),
      fromLowPct: num(s.distance_from_52w_low_pct),
      ath: num(s.ath),
      downFromAthPct: num(s.fall_from_ath_pct),
      trendPct: num(s.price_change_nd_pct),
      score: notScored ? null
        : funda ? funda.points
          : (fundaResult ? Number(fundaResult.score) : null),
      bestStatus,
      daysSinceRally: num(s.days_since_last_rally),
      pctToNextBuy,
      rallyPct: num(s.last_rally_pct),
      hasRally: Boolean(s.has_valid_20pct_rally),
      rallyLow,
      rallyHigh: num(s.last_rally_high),
      marketCapCr: mcap !== null ? mcap / 1e7 : null,
      pe: num(s.pe_current),
      pb: num(s.pb_current),
      funda,
      results,
      snapshot: s,
    };
  });
}
