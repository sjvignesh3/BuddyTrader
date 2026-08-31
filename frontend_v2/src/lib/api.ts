// -----------------------------------------------------------------------------
// Thin fetch wrapper for the Plutus read-only API.
// Never writes. All money fields arrive as strings — do NOT coerce to Number
// at the boundary. Format only at render time via lib/money.ts.
// -----------------------------------------------------------------------------

const BASE = import.meta.env.VITE_PLUTUS_API_URL ?? "";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${path}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ---- Types (mirror the API wire contract) ----------------------------------

export interface Pool {
  code: string;
  name: string;
  description: string;
  display_order: number;
  strategies: string[];
  metadata: Record<string, unknown>;
}

export interface Stock {
  id: number;
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  exchange: string;
  active: boolean;
  pools: string[];
  cap_type_manual: string | null;
}

/** All monetary / ratio fields are strings — precision-safe. */
export interface Snapshot {
  symbol: string;
  snapshot_date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  adj_close: string;
  volume: number;
  dma_200?: string | null;
  below_200dma_pct?: string | null;
  distance_from_52w_high_pct?: string | null;
  distance_from_52w_low_pct?: string | null;
  has_valid_20pct_rally?: boolean | null;
  cap_bucket?: string | null;
  [k: string]: unknown;
}

export interface Scan {
  id: number;
  pool_code: string;
  snapshot_date: string;
  started_at: string;
  finished_at?: string | null;
  triggered_by?: string | null;
}

export interface ScanResult {
  scan_id: number;
  symbol: string;
  strategy_id: string;
  status: string;
  score: string;
  reasons: unknown[];
  metrics_snapshot: Record<string, unknown>;
}

export interface SyncJob {
  id: number;
  job_type: string;
  started_at: string;
  finished_at?: string | null;
  status: string;
  symbols_total?: number | null;
  symbols_ok?: number | null;
  symbols_failed?: number | null;
  snapshots_written?: number | null;
  payload_json: Record<string, unknown>;
}

// ---- Endpoints -------------------------------------------------------------

export const api = {
  health: () => get<{ status: string }>("/api/health"),
  pools: () => get<{ pools: Pool[] }>("/api/pools"),
  stocks: (pool?: string) =>
    get<{ stocks: Stock[]; count: number }>(
      `/api/stocks${pool ? `?pool=${encodeURIComponent(pool)}` : ""}`
    ),
  stock: (symbol: string) =>
    get<{ stock: Stock }>(`/api/stocks/${encodeURIComponent(symbol)}`),
  latestSnapshots: (pool: string, date?: string) =>
    get<{
      pool: string;
      snapshot_date: string | null;
      snapshots: Snapshot[];
      count: number;
    }>(
      `/api/snapshots/latest?pool=${encodeURIComponent(pool)}${
        date ? `&snapshot_date=${date}` : ""
      }`
    ),
  history: (symbol: string, days = 60) =>
    get<{ symbol: string; days: number; bars: Snapshot[] }>(
      `/api/snapshots/${encodeURIComponent(symbol)}/history?days=${days}`
    ),
  latestScan: (pool: string) =>
    get<{ scan: Scan | null }>(
      `/api/scans/latest?pool=${encodeURIComponent(pool)}`
    ),
  scanResults: (scanId: number, opts?: { strategy?: string; status?: string[] }) => {
    const q = new URLSearchParams({ scan_id: String(scanId) });
    if (opts?.strategy) q.set("strategy_id", opts.strategy);
    if (opts?.status?.length) q.set("status", opts.status.join(","));
    return get<{ scan_id: string; results: ScanResult[]; count: number }>(
      `/api/scan_results?${q.toString()}`
    );
  },
  syncJobs: (jobType?: string, limit = 10) =>
    get<{ jobs: SyncJob[]; count: number }>(
      `/api/sync_jobs/latest?limit=${limit}${
        jobType ? `&job_type=${encodeURIComponent(jobType)}` : ""
      }`
    ),
};
