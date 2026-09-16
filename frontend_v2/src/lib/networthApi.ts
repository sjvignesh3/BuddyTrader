// -----------------------------------------------------------------------------
// Net Worth API client — manual assets, liabilities, monthly snapshots, income,
// milestones and the financial-freedom settings row. Same wire contract as the
// journal / expenses clients: money fields travel as strings (Decimal-safe).
//
// The equity side is NOT fetched from here — it is the Journal's open trades ×
// the latest daily_snapshots (lib/journal.ts buildPortfolio). Everything the
// dashboard shows is derived client-side in lib/networth.ts.
// -----------------------------------------------------------------------------

import { authHeaders, handleUnauthorized } from "./auth";

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
    throw new Error(`${method} ${path}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

// ---- Types (wire contract) ---------------------------------------------------

/** Order drives the picker in the asset modal. Mirrors ASSET_CLASSES in
 * plutus/api/networth.py and the CHECK constraint in migration 017. */
export const ASSET_CLASSES = [
  "Cash", "FD", "Mutual Fund", "Direct Stocks", "Gold", "EPF/PPF",
  "Real Estate", "Crypto", "Bonds", "Other",
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const LIABILITY_KINDS = [
  "Home Loan", "Personal Loan", "Car Loan", "Credit Card", "Other",
] as const;
export type LiabilityKind = (typeof LIABILITY_KINDS)[number];

export interface Asset {
  id: number;
  name: string;
  asset_class: AssetClass;
  institution: string | null;
  current_value: string;        // NUMERIC as string
  cost_basis: string | null;
  as_of_date: string;           // ISO YYYY-MM-DD
  notes: string | null;
  archived: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Liability {
  id: number;
  name: string;
  kind: LiabilityKind;
  outstanding: string;
  interest_rate: string | null; // % p.a.
  emi: string | null;
  notes: string | null;
  archived: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Allocation as it stood when the snapshot was taken (money as strings). */
export interface SnapshotBreakdown {
  equity?: string;
  assets?: Record<string, string>;
  liabilities?: Record<string, string>;
  holdings?: { symbol: string; value: string }[];
}

export interface NetWorthSnapshot {
  id: number;
  snapshot_date: string;        // always the 1st of the month
  equity_value: string;
  assets_value: string;
  liabilities_value: string;
  net_worth: string;
  breakdown: SnapshotBreakdown;
  created_at?: string;
}

export interface IncomeRow {
  id: number;
  month: string;                // always the 1st of the month
  amount: string;
  notes: string | null;
}

export interface Milestone {
  id: number;
  label: string;
  target: string;
  achieved_on: string | null;
  created_at?: string;
}

export interface NetWorthSettings {
  id: number;
  ff_target_corpus: string | null;
  ff_real_return_pct: string;
  ff_monthly_savings: string | null;
  updated_at?: string;
}

/** Editable payloads (id / timestamps excluded). */
export type AssetDraft = Partial<Omit<Asset, "id" | "created_at" | "updated_at">>;
export type LiabilityDraft = Partial<Omit<Liability, "id" | "created_at" | "updated_at">>;
export type SnapshotDraft = Omit<NetWorthSnapshot, "id" | "created_at">;
export type MilestoneDraft = Partial<Omit<Milestone, "id" | "created_at">>;
export type SettingsDraft = Partial<Omit<NetWorthSettings, "id" | "updated_at">>;

// ---- Endpoints ---------------------------------------------------------------

export const networthApi = {
  assets: (includeArchived = false) =>
    send<{ assets: Asset[]; count: number }>(
      "GET", `/api/networth/assets${includeArchived ? "?include_archived=true" : ""}`),
  createAsset: (draft: AssetDraft) =>
    send<{ asset: Asset }>("POST", "/api/networth/assets", draft),
  updateAsset: (id: number, draft: AssetDraft) =>
    send<{ asset: Asset }>("PUT", `/api/networth/assets/${id}`, draft),
  deleteAsset: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/networth/assets/${id}`),

  liabilities: (includeArchived = false) =>
    send<{ liabilities: Liability[]; count: number }>(
      "GET", `/api/networth/liabilities${includeArchived ? "?include_archived=true" : ""}`),
  createLiability: (draft: LiabilityDraft) =>
    send<{ liability: Liability }>("POST", "/api/networth/liabilities", draft),
  updateLiability: (id: number, draft: LiabilityDraft) =>
    send<{ liability: Liability }>("PUT", `/api/networth/liabilities/${id}`, draft),
  deleteLiability: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/networth/liabilities/${id}`),

  snapshots: () =>
    send<{ snapshots: NetWorthSnapshot[]; count: number }>("GET", "/api/networth/snapshots"),
  /** Idempotent per month — the server replaces an existing row for that month. */
  takeSnapshot: (draft: SnapshotDraft) =>
    send<{ snapshot: NetWorthSnapshot; replaced: boolean }>(
      "POST", "/api/networth/snapshots", draft),
  deleteSnapshot: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/networth/snapshots/${id}`),

  income: () => send<{ income: IncomeRow[]; count: number }>("GET", "/api/networth/income"),
  /** Upsert by month ("YYYY-MM" or any ISO date within the month). */
  setIncome: (month: string, amount: string | number, notes?: string | null) =>
    send<{ income: IncomeRow }>("POST", "/api/networth/income", { month, amount, notes }),
  deleteIncome: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/networth/income/${id}`),

  milestones: () =>
    send<{ milestones: Milestone[]; count: number }>("GET", "/api/networth/milestones"),
  createMilestone: (draft: MilestoneDraft) =>
    send<{ milestone: Milestone }>("POST", "/api/networth/milestones", draft),
  updateMilestone: (id: number, draft: MilestoneDraft) =>
    send<{ milestone: Milestone }>("PUT", `/api/networth/milestones/${id}`, draft),
  deleteMilestone: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/networth/milestones/${id}`),

  settings: () => send<{ settings: NetWorthSettings }>("GET", "/api/networth/settings"),
  updateSettings: (draft: SettingsDraft) =>
    send<{ settings: NetWorthSettings }>("PUT", "/api/networth/settings", draft),
};
