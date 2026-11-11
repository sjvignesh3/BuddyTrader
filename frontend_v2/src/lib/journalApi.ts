// -----------------------------------------------------------------------------
// Trading Journal API client — the ONE writable surface of Plutus.
// Kept separate from lib/api.ts on purpose: that wrapper's contract is
// read-only. Money fields still travel as strings (Decimal-safe).
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
    // Token stale, revoked, or the password was rotated — drop it and
    // let the route gate re-lock the UI.
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

// ---- IPO journal ---------------------------------------------------------------

export type IpoStatus = "APPLIED" | "ALLOTTED" | "NOT_ALLOTTED";

/** One sell of allotted IPO shares; partial exits are several of these. */
export interface IpoSell {
  id: number;
  ipo_id: number;
  sell_date: string;
  sell_price: string;
  qty: number;
  notes: string | null;
}

/** One IPO application (per account), with its sells. */
export interface Ipo {
  id: number;
  account: string;
  ipo_name: string;
  /** Plain NSE symbol — known from listing day. */
  symbol: string | null;
  apply_date: string;
  issue_price: string;
  lot_size: number;
  lots_applied: number;
  status: IpoStatus;
  /** Day shares were credited / money refunded. */
  allotment_date: string | null;
  shares_allotted: number | null;
  listing_date: string | null;
  listing_open: string | null;
  listing_close: string | null;
  notes: string | null;
  sells: IpoSell[];
  created_at?: string;
  updated_at?: string;
}

export type IpoDraft = Partial<{
  account: string; ipo_name: string; symbol: string | null; apply_date: string;
  issue_price: string; lot_size: number; lots_applied: number; status: IpoStatus;
  allotment_date: string | null; shares_allotted: number | null;
  listing_date: string | null; listing_open: string | null; listing_close: string | null;
  notes: string | null;
}>;
export type IpoSellDraft = Partial<Pick<IpoSell, "sell_date" | "sell_price" | "qty" | "notes">>;

/** Listing-day prices looked up from market data (not saved until you save). */
export interface IpoListing {
  symbol: string;
  listing_date: string;
  listing_open: string;
  /** Null while the listing day is still trading. */
  listing_close: string | null;
  ltp: string;
  ltp_date: string;
}

// ---- Notes page (migration 025) — one flat list, `kind` separates the items ----
export type NotebookKind = "TASK" | "TARGET" | "WATCH" | "NOTE" | "PLUTUS";
export type NotebookMarket = "IN" | "US";

export interface NotebookItem {
  id: number;
  kind: NotebookKind;
  title: string;
  body: string | null;
  market: NotebookMarket | null;
  /** Plain NSE symbol for IN, a US ticker for US. Free text — never priced. */
  symbol: string | null;
  due_date: string | null;
  done: boolean;
  pinned: boolean;
  created_at?: string;
  updated_at?: string;
}
/** '' clears an optional field on the server. */
export type NotebookDraft = Partial<{
  kind: NotebookKind; title: string; body: string | null;
  market: NotebookMarket | "" | null; symbol: string | null;
  due_date: string | null; done: boolean; pinned: boolean;
}>;

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

  notebook: () =>
    send<{ items: NotebookItem[]; count: number }>("GET", "/api/journal/notebook"),
  createNotebookItem: (draft: NotebookDraft) =>
    send<{ item: NotebookItem }>("POST", "/api/journal/notebook", draft),
  updateNotebookItem: (id: number, draft: NotebookDraft) =>
    send<{ item: NotebookItem }>("PUT", `/api/journal/notebook/${id}`, draft),
  deleteNotebookItem: (id: number) =>
    send<{ deleted: number }>("DELETE", `/api/journal/notebook/${id}`),

  ipos: () => send<{ ipos: Ipo[]; count: number }>("GET", "/api/journal/ipos"),
  createIpo: (draft: IpoDraft) => send<{ ipo: Ipo }>("POST", "/api/journal/ipos", draft),
  updateIpo: (id: number, draft: IpoDraft) =>
    send<{ ipo: Ipo }>("PUT", `/api/journal/ipos/${id}`, draft),
  deleteIpo: (id: number) => send<{ deleted: number }>("DELETE", `/api/journal/ipos/${id}`),
  addIpoSell: (ipoId: number, draft: IpoSellDraft) =>
    send<{ ipo: Ipo }>("POST", `/api/journal/ipos/${ipoId}/sells`, draft),
  updateIpoSell: (sellId: number, draft: IpoSellDraft) =>
    send<{ ipo: Ipo }>("PUT", `/api/journal/ipos/sells/${sellId}`, draft),
  deleteIpoSell: (sellId: number) =>
    send<{ ipo: Ipo }>("DELETE", `/api/journal/ipos/sells/${sellId}`),
  /** Listing-day prices from market data; `applyDate` guards a wrong symbol. */
  ipoListing: (symbol: string, applyDate?: string) =>
    send<IpoListing>("GET", `/api/journal/ipos/listing?symbol=${encodeURIComponent(symbol)}${
      applyDate ? `&apply_date=${applyDate}` : ""}`),
  ipoQuotes: (symbols: string[]) =>
    send<{ quotes: Record<string, { ltp: string; date: string }>; errors: Record<string, string> }>(
      "GET", `/api/journal/ipos/quotes?symbols=${encodeURIComponent(symbols.join(","))}`),

  bulkImport: (payload: { opportunities?: OpportunityDraft[]; trades?: TradeDraft[] }) =>
    send<{ imported: { opportunities: number; trades: number } }>(
      "POST", "/api/journal/import", payload),
};
