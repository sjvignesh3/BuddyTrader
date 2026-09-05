// -----------------------------------------------------------------------------
// Position Sizer API client — saved pre-trade plans. Same wire contract as the
// journal / expenses clients: money fields travel as strings (Decimal-safe).
// A plan stores INPUTS only; every derived number (₹ risk, R multiples,
// allocation %, room left) is recomputed in lib/sizing.ts from these inputs
// plus the live journal, so a capital change never leaves stale numbers.
// -----------------------------------------------------------------------------
import type { CapBucket } from "./journalApi";

const BASE = import.meta.env.VITE_PLUTUS_API_URL ?? "";

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
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

export interface PlanTarget { price: string }
export interface PlanTranche { trigger: string; qty: number }

export interface SizingPlan {
  id: number;
  symbol: string;
  cap_bucket: CapBucket | null;
  capital: string;      // capital at the time of sizing
  risk_pct: string;
  entry: string;
  stop: string;
  qty: number;
  targets: PlanTarget[];
  ladder: PlanTranche[];
  notes: string | null;
  opportunity_id: number | null;
  created_at?: string;
  updated_at?: string;
}

export type SizingPlanDraft = Partial<
  Omit<SizingPlan, "id" | "created_at" | "updated_at" | "opportunity_id">
>;
export type SizingPlanPatch = Partial<
  Pick<SizingPlan, "notes" | "opportunity_id" | "targets" | "ladder">
>;

// ---- Endpoints ---------------------------------------------------------------

export const sizingApi = {
  plans: (symbol?: string) =>
    send<{ plans: SizingPlan[]; count: number }>(
      "GET", `/api/sizing/plans${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""}`),
  createPlan: (draft: SizingPlanDraft) =>
    send<{ plan: SizingPlan }>("POST", "/api/sizing/plans", draft),
  updatePlan: (id: number, patch: SizingPlanPatch) =>
    send<{ plan: SizingPlan }>("PUT", `/api/sizing/plans/${id}`, patch),
  deletePlan: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/sizing/plans/${id}`),
};
