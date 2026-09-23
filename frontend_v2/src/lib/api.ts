// -----------------------------------------------------------------------------
// Thin fetch wrapper for the Plutus read-only API.
// Never writes. All money fields arrive as strings — do NOT coerce to Number
// at the boundary. Format only at render time via lib/money.ts.
// -----------------------------------------------------------------------------

import { authHeaders, handleUnauthorized } from "./auth";

const BASE = import.meta.env.VITE_PLUTUS_API_URL ?? "";

async function get<T>(path: string, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { Accept: "application/json", ...authHeaders(), ...headers },
  });
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized();
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${path}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// The ONE write-shaped call in this module: it never writes to the DB —
// it asks the API to dispatch a GitHub Actions workflow (the PAT stays
// server-side; we only send the per-browser admin token as a header).
async function post<T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...authHeaders(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized();
    let detail = "";
    try {
      const j = await res.json();
      detail = j?.error ?? j?.detail ?? "";
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`API ${res.status} ${path}: ${detail || res.statusText}`);
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
  /** S200 criteria group — Banks | NBFC | Normal (migration 019). */
  sector_group?: string | null;
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

/** Tier-B quarterly fundamentals row (money fields are strings). */
export interface Fundamentals {
  symbol: string;
  quarter_end_date: string;
  quarter_label?: string | null;
  sales?: string | null;
  pbt?: string | null;
  net_profit?: string | null;
  operating_margin_pct?: string | null;
  promoter_holding_pct?: string | null;
  institutional_pct?: string | null;
  public_holding_pct?: string | null;
  promoter_pledging_pct?: string | null;
  promoter_holding_source?: string | null;
  roce?: string | null;
  roe?: string | null;
  net_debt_to_equity?: string | null;
  pe_5y_avg?: string | null;
  pb_5y_avg?: string | null;
  data_source?: string | null;
  fetched_at?: string | null;
  [k: string]: unknown;
}

/** On-demand sync — workflow keys the API can dispatch on GitHub. */
export type SyncWorkflow = "daily" | "quarterly" | "ratios";

export interface TriggerStatus {
  configured: boolean;
  auth_required: boolean;
  workflows: SyncWorkflow[];
  pools: string[];
}

export interface TriggerResult {
  queued: boolean;
  workflow: SyncWorkflow;
  file: string;
  inputs: Record<string, string>;
  runs_url: string;
  note: string;
}

export interface WorkflowRun {
  id: number;
  run_number: number;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | null
  event: string;
  created_at: string;
  html_url: string;
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
  /** PlayArea watchlist mode — snapshots for an explicit symbol list. */
  latestSnapshotsForSymbols: (symbols: string[], date?: string) =>
    get<{
      pool: string | null;
      snapshot_date: string | null;
      snapshots: Snapshot[];
      count: number;
    }>(
      `/api/snapshots/latest?symbols=${encodeURIComponent(symbols.join(","))}${
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
  /** PlayArea mode — each symbol's LATEST result per strategy, any pool scan. */
  scanResultsForSymbols: (symbols: string[]) =>
    get<{ scan_id: null; results: ScanResult[]; count: number }>(
      `/api/scan_results?symbols=${encodeURIComponent(symbols.join(","))}`
    ),
  fundamentals: (symbol: string) =>
    get<{ symbol: string; fundamentals: Fundamentals | Fundamentals[] }>(
      `/api/fundamentals/${encodeURIComponent(symbol)}/latest`
    ),
  /** LOCAL-DEV only (FastAPI): trigger an on-demand sync + Screener fetch +
   * scan for symbols missing from the DB. 404s on the prod Edge Function. */
  adminSync: (symbols: string[]) =>
    get<{ started: string[]; already_running: string[]; note: string }>(
      `/api/admin/sync?symbols=${encodeURIComponent(symbols.join(","))}`
    ),
  /** On-demand sync trigger — capability probe (no auth needed). */
  triggerStatus: () => get<TriggerStatus>("/api/admin/trigger/status"),
  /** Dispatch a GitHub Actions sync workflow. adminToken → header only. */
  triggerSync: (
    body: {
      workflow: SyncWorkflow;
      pool?: string;
      symbols?: string[];
      dry_run?: boolean;
      limit?: number;
    },
    adminToken: string
  ) =>
    post<TriggerResult>("/api/admin/trigger", body, {
      "X-Plutus-Admin-Token": adminToken,
    }),
  /** Recent GitHub runs of one workflow — shows queued/in-progress state. */
  workflowRuns: (workflow: SyncWorkflow, adminToken: string, limit = 3) =>
    get<{ workflow: SyncWorkflow; runs: WorkflowRun[]; count: number }>(
      `/api/admin/trigger/runs?workflow=${workflow}&limit=${limit}`,
      { "X-Plutus-Admin-Token": adminToken }
    ),
  syncJobs: (jobType?: string, limit = 10) =>
    get<{ jobs: SyncJob[]; count: number }>(
      `/api/sync_jobs/latest?limit=${limit}${
        jobType ? `&job_type=${encodeURIComponent(jobType)}` : ""
      }`
    ),
};
