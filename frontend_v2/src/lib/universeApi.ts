// -----------------------------------------------------------------------------
// Universe API client — pool membership is the single source of truth for
// every Market Analysis pool, scan and journal lookup, so this is a writable
// client (like journalApi) kept apart from the read-only lib/api.ts.
//
// Contract with plutus/api/universe.py:
//   * symbols go up in any spelling ("tcs", "TCS", "TCS.NS") and come back
//     canonical ("TCS.NS");
//   * cap types / sector groups are normalised server-side to one vocabulary;
//   * nothing deletes a stock — removing the last pool retires it, unless
//     the Trading Journal still references it;
//   * every import is recorded in universe_syncs (the same table the S200
//     Screener sync will use for its preview → consent → apply flow).
// -----------------------------------------------------------------------------
import { authHeaders, handleUnauthorized } from "./auth";
import type { Pool, Stock } from "./api";

const BASE = import.meta.env.VITE_PLUTUS_API_URL ?? "";

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized();
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error ?? j.detail ?? msg;
    } catch { /* keep statusText */ }
    const err = new Error(msg || `${method} ${path} failed`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

// ---- Types (wire contract) ---------------------------------------------------

export type SectorGroup = "Banks" | "NBFC" | "Normal";
export type CapType = "Large" | "Mid" | "Small" | "Micro";
export const SECTOR_GROUPS: SectorGroup[] = ["Banks", "NBFC", "Normal"];
export const CAP_TYPES: CapType[] = ["Large", "Mid", "Small", "Micro"];

export interface UniverseStock extends Stock {
  sector_group: SectorGroup | null;
  metadata: Record<string, unknown> & {
    membership?: Record<string, { source: string; at: string }>;
  };
  updated_at?: string;
}

export interface JournalRef { open_trades: number; active_opps: number }

export interface UniverseSync {
  id: number;
  pool_code: string;
  kind: "import" | "screen";
  status: "running" | "preview" | "applied" | "discarded" | "failed";
  mode: "merge" | "replace";
  criteria: Record<string, unknown>;
  diff: ImportDiff;
  error: string | null;
  triggered_by: string;
  created_at: string;
  applied_at: string | null;
}

export interface Universe {
  pools: Pool[];
  stocks: UniverseStock[];
  counts: Record<string, number>;
  /** plain symbol ("TCS") → open trades / active opportunities */
  journal_refs: Record<string, JournalRef>;
  /** pool code → latest applied change-set */
  last_syncs: Record<string, UniverseSync>;
  editable_pools: string[];
}

export interface StockDraft {
  name?: string | null;
  sector?: string | null;
  industry?: string | null;
  cap_type_manual?: string | null;
  sector_group?: string | null;
}

export interface ImportRow {
  symbol: string;
  name?: string;
  sector?: string;
  cap_type?: string;
  sector_group?: string;
}

export interface ImportDiff {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
  new_stocks: string[];
  rejected?: { symbol: string; reason: string }[];
  kept_for_journal?: string[];
}

export interface ImportResult {
  pool: string;
  mode: "merge" | "replace";
  dry_run: boolean;
  diff: ImportDiff;
  row_count: number;
  sync?: UniverseSync;
}

export interface ScreenCriteria {
  normal: { net_debt_to_equity_max: string; roce_min: string; net_profit_min_cr: string };
  banks_nbfc: { roe_min: string; net_profit_min_cr: string };
}

// ---- Endpoints -------------------------------------------------------------

export const universeApi = {
  get: (includeInactive = false) =>
    send<Universe>("GET", `/api/universe${includeInactive ? "?include_inactive=true" : ""}`),

  updateStock: (symbol: string, draft: StockDraft) =>
    send<{ stock: UniverseStock }>("PUT", `/api/universe/stocks/${encodeURIComponent(symbol)}`, draft),

  addMember: (pool: string, symbol: string, draft: StockDraft = {}) =>
    send<{ stock: UniverseStock; already_member: boolean }>(
      "POST", `/api/universe/pools/${encodeURIComponent(pool)}/members`, { symbol, ...draft }),

  removeMember: (pool: string, symbol: string) =>
    send<{ stock: UniverseStock; retired: boolean }>(
      "DELETE",
      `/api/universe/pools/${encodeURIComponent(pool)}/members/${encodeURIComponent(symbol)}`),

  /** dry_run=true returns the diff without writing — the consent step. */
  importMembers: (pool: string, rows: ImportRow[], mode: "merge" | "replace", dryRun: boolean) =>
    send<ImportResult>("POST", `/api/universe/pools/${encodeURIComponent(pool)}/import`,
      { rows, mode, dry_run: dryRun }),

  criteria: (pool: string) =>
    send<{ pool: string; criteria: ScreenCriteria; updated_at: string | null; defaults: ScreenCriteria }>(
      "GET", `/api/universe/pools/${encodeURIComponent(pool)}/criteria`),

  saveCriteria: (pool: string, criteria: ScreenCriteria) =>
    send<{ pool: string; criteria: ScreenCriteria; updated_at: string }>(
      "PUT", `/api/universe/pools/${encodeURIComponent(pool)}/criteria`, criteria),

  syncs: (pool?: string, limit = 20) =>
    send<{ syncs: UniverseSync[]; count: number }>(
      "GET", `/api/universe/syncs?limit=${limit}${pool ? `&pool=${encodeURIComponent(pool)}` : ""}`),

  /** Starts the Screener screen for a quantitative pool. 501 until wired. */
  startScreen: (pool: string) =>
    send<{ sync: UniverseSync }>("POST", `/api/universe/pools/${encodeURIComponent(pool)}/screen`),

  discardSync: (id: number) =>
    send<{ sync: UniverseSync }>("POST", `/api/universe/syncs/${id}/discard`),
};

/** "TCS.NS" → "TCS" for display and journal matching. */
export const plainSymbol = (s: string): string => s.replace(/\.(NS|BO)$/i, "");
