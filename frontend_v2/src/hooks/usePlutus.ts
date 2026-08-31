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
  syncJobs: (jobType?: string) => ["sync_jobs", jobType ?? "all"] as const,
  history: (symbol: string, days: number) => ["history", symbol, days] as const,
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

export function useHistory(symbol: string, days = 60) {
  return useQuery({
    queryKey: qk.history(symbol, days),
    queryFn: () => api.history(symbol, days),
    enabled: Boolean(symbol),
  });
}
