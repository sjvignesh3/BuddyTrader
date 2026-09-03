// -----------------------------------------------------------------------------
// TanStack Query hooks — one per API endpoint. Encapsulates cache keys, so
// components never construct keys directly (prevents cache collisions).
// -----------------------------------------------------------------------------
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export const qk = {
  pools: ["pools"] as const,
  stocks: (pool?: string) => ["stocks", pool ?? "all"] as const,
  snapshots: (pool: string, date?: string) => ["snapshots", pool, date ?? "latest"] as const,
  scan: (pool: string) => ["scan", pool] as const,
  scanResults: (scanId: number | undefined, strategy?: string) =>
    ["scan_results", scanId ?? "none", strategy ?? "all"] as const,
  stock: (symbol: string) => ["stock", symbol] as const,
  syncJobs: (jobType?: string) => ["sync_jobs", jobType ?? "all"] as const,
  history: (symbol: string, days: number) => ["history", symbol, days] as const,
  fundamentals: (symbol: string) => ["fundamentals", symbol] as const,
  snapshotsBySymbols: (symbols: string[]) =>
    ["snapshots_by_symbols", symbols.join(",")] as const,
  scanResultsForSymbols: (symbols: string[]) =>
    ["scan_results_for_symbols", symbols.join(",")] as const,
};

export function usePools() {
  return useQuery({ queryKey: qk.pools, queryFn: api.pools });
}

export function useStocks(pool?: string) {
  return useQuery({
    queryKey: qk.stocks(pool),
    queryFn: () => api.stocks(pool),
  });
}

/** One stock's metadata (name, sector, pools) — the stock detail page. */
export function useStock(symbol: string) {
  return useQuery({
    queryKey: qk.stock(symbol),
    queryFn: () => api.stock(symbol),
    enabled: Boolean(symbol),
    staleTime: 5 * 60_000, // metadata changes only on reseed
  });
}

export function useSnapshots(pool: string, date?: string) {
  return useQuery({
    queryKey: qk.snapshots(pool, date),
    queryFn: () => api.latestSnapshots(pool, date),
    enabled: Boolean(pool),
  });
}

export function useLatestScan(pool: string) {
  return useQuery({
    queryKey: qk.scan(pool),
    queryFn: () => api.latestScan(pool),
    enabled: Boolean(pool),
  });
}

export function useScanResults(scanId: number | undefined, strategy?: string) {
  return useQuery({
    queryKey: qk.scanResults(scanId, strategy),
    queryFn: () => api.scanResults(scanId!, { strategy }),
    enabled: scanId !== undefined,
  });
}

/**
 * Sync jobs — powers the header status pill and the `/sync` page.
 *
 * When a Realtime channel is provided AND it is currently `connected`, we
 * drop the 60 s polling interval — Realtime invalidates the cache on
 * every DB change. If Realtime is disabled OR the channel is
 * disconnected, we fall back to polling so the pill still updates
 * eventually.
 *
 * Callers wire this together via `useSyncJobsRealtime()` in
 * `hooks/useSyncJobsRealtime.ts`. The two hooks are decoupled: this file
 * has zero Supabase-client dependency.
 */
export function useSyncJobs(
  jobType?: string,
  opts?: { realtime?: { enabled: boolean; connected: boolean } }
) {
  const realtimeLive = Boolean(opts?.realtime?.enabled && opts?.realtime?.connected);
  return useQuery({
    queryKey: qk.syncJobs(jobType),
    queryFn: () => api.syncJobs(jobType),
    // Realtime live → no polling. Otherwise poll every 60 s as before.
    refetchInterval: realtimeLive ? false : 60_000,
  });
}

/** PlayArea watchlist — snapshots for an explicit symbol list. */
export function useSnapshotsBySymbols(symbols: string[]) {
  return useQuery({
    queryKey: qk.snapshotsBySymbols(symbols),
    queryFn: () => api.latestSnapshotsForSymbols(symbols),
    enabled: symbols.length > 0,
  });
}

/** PlayArea watchlist — latest scan result per (symbol, strategy). */
export function useScanResultsForSymbols(symbols: string[]) {
  return useQuery({
    queryKey: qk.scanResultsForSymbols(symbols),
    queryFn: () => api.scanResultsForSymbols(symbols),
    enabled: symbols.length > 0,
  });
}

/** Tier-B fundamentals for one symbol — fetched lazily when a row expands. */
export function useFundamentals(symbol: string, enabled = true) {
  return useQuery({
    queryKey: qk.fundamentals(symbol),
    queryFn: () => api.fundamentals(symbol),
    enabled: Boolean(symbol) && enabled,
    staleTime: 5 * 60_000, // quarterly data — no need to refetch per expand
  });
}

export function useHistory(symbol: string, days = 60) {
  return useQuery({
    queryKey: qk.history(symbol, days),
    queryFn: () => api.history(symbol, days),
    enabled: Boolean(symbol),
  });
}
