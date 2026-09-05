// -----------------------------------------------------------------------------
// Trading Journal API client — the ONE writable surface of Plutus.
// Kept separate from lib/api.ts on purpose: that wrapper's contract is
// read-only. Money fields still travel as strings (Decimal-safe).
// -----------------------------------------------------------------------------

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

export type CapBucket = "Large" | "Mid" | "Small" | "Micro";
export type ActionFilter = "Buy Now" | "GTT" | "Analyse Now" | "Later";
export type OppStatus = "ACTIVE" | "CONVERTED" | "DROPPED";
export type TradeStatus = "OPEN" | "CLOSED";

export interface JournalSettings {
  id: number;
  capital: string;
  updated_at?: string;
}

export interface Opportunity {
  id: number;
  opp_date: string | null;
  symbol: string;
  cap_bucket: CapBucket | null;
  buy_price: string | null;
  limit_price: string | null;
  qty: number | null;
  strategy: string | null;
  target_price: string | null;
  /** Stop-loss — the exit that defines the trade's risk (Position Sizer). */
  stop_price: string | null;
  action_filter: ActionFilter | null;
  notes: string | null;
  status: OppStatus;
  created_at?: string;
  updated_at?: string;
}

export interface Trade {
  id: number;
  opportunity_id: number | null;
  order_type: "GTT" | "Instant" | null;
  cap_bucket: CapBucket | null;
  symbol: string;
  buy_date: string;
  buy_price: string;
  qty: number;
  strategy: string | null;
  target_price: string | null;
  /** Stop-loss; open lots WITH a stop feed the Position Sizer's portfolio heat. */
  stop_price: string | null;
  status: TradeStatus;
  close_label: string | null;
  sell_date: string | null;
  sell_price: string | null;
  comments: string | null;
  risk_notes: string | null;
  created_at?: string;
  updated_at?: string;
}

/** One dated research note on a stock — the "my views over time" trail. */
export interface StockNote {
  id: number;
  symbol: string;
  note_date: string;
  content: string;
  created_at?: string;
  updated_at?: string;
}

export interface Position {
  symbol: string;
  qty: number;
  invested: number;
  cap_bucket: CapBucket | null;
  lots: number;
}

/** Editable payloads (id/status timestamps excluded). */
export type OpportunityDraft = Partial<Omit<Opportunity, "id" | "created_at" | "updated_at">>;
export type TradeDraft = Partial<Omit<Trade, "id" | "created_at" | "updated_at">>;
export type StockNoteDraft = Partial<Omit<StockNote, "id" | "created_at" | "updated_at">>;

// ---- Endpoints ---------------------------------------------------------------

export const journalApi = {
  settings: () => send<{ settings: JournalSettings }>("GET", "/api/journal/settings"),
  setCapital: (capital: string | number) =>
    send<{ settings: JournalSettings }>("PUT", "/api/journal/settings", { capital }),

  opportunities: (status?: string) =>
    send<{ opportunities: Opportunity[]; count: number }>(
      "GET", `/api/journal/opportunities${status ? `?status=${status}` : ""}`),
  createOpportunity: (draft: OpportunityDraft) =>
    send<{ opportunity: Opportunity }>("POST", "/api/journal/opportunities", draft),
  updateOpportunity: (id: number, draft: OpportunityDraft) =>
    send<{ opportunity: Opportunity }>("PUT", `/api/journal/opportunities/${id}`, draft),
  deleteOpportunity: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/journal/opportunities/${id}`),
  convertOpportunity: (id: number, overrides: TradeDraft) =>
    send<{ trade: Trade }>("POST", `/api/journal/opportunities/${id}/convert`, overrides),

  trades: (status?: TradeStatus) =>
    send<{ trades: Trade[]; count: number }>(
      "GET", `/api/journal/trades${status ? `?status=${status}` : ""}`),
  /** All lots (open + closed) of one stock — plain NSE symbol. */
  tradesBySymbol: (symbol: string) =>
    send<{ trades: Trade[]; count: number }>(
      "GET", `/api/journal/trades?symbol=${encodeURIComponent(symbol)}`),
  createTrade: (draft: TradeDraft) =>
    send<{ trade: Trade }>("POST", "/api/journal/trades", draft),
  updateTrade: (id: number, draft: TradeDraft) =>
    send<{ trade: Trade }>("PUT", `/api/journal/trades/${id}`, draft),
  deleteTrade: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/journal/trades/${id}`),
  closeTrade: (id: number, p: { sell_date: string; sell_price: string | number;
                                qty?: number; close_label?: string }) =>
    send<{ closed: Trade; remainder: Trade | null }>(
      "POST", `/api/journal/trades/${id}/close`, p),

  positions: () => send<{ positions: Position[]; count: number }>(
    "GET", "/api/journal/positions"),

  /** Dated stock notes — pass a plain NSE symbol to scope to one stock. */
  notes: (symbol?: string) =>
    send<{ notes: StockNote[]; count: number }>(
      "GET", `/api/journal/notes${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""}`),
  createNote: (draft: StockNoteDraft) =>
    send<{ note: StockNote }>("POST", "/api/journal/notes", draft),
  updateNote: (id: number, draft: StockNoteDraft) =>
    send<{ note: StockNote }>("PUT", `/api/journal/notes/${id}`, draft),
  deleteNote: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/journal/notes/${id}`),

  bulkImport: (payload: { opportunities?: OpportunityDraft[]; trades?: TradeDraft[] }) =>
    send<{ imported: { opportunities: number; trades: number } }>(
      "POST", "/api/journal/import", payload),
};
