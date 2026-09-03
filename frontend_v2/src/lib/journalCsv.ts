// -----------------------------------------------------------------------------
// CSV import/export for the Trading Journal.
//
// Import understands the user's Google-Sheets exports:
//   * a junk summary row above the real header (auto-detected),
//   * derived columns (LTP, Gain, % Alloc…) — ignored, we recompute them,
//   * "2-Jul" (day-month, year assumed current) and "8/27/2026" (M/D/YYYY),
//   * numbers with commas / quotes / % signs.
// Export writes only the MANUAL columns so files round-trip through import.
// -----------------------------------------------------------------------------

import type { OpportunityDraft, TradeDraft } from "./journalApi";
import { normalizeCap } from "./journal";

// ---- Low-level CSV --------------------------------------------------------------

/** RFC-4180-ish parser: quoted fields, embedded commas/newlines/"" escapes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

// ---- Value coercion --------------------------------------------------------------

function cleanNum(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[",%\s₹]/g, "").replace(/,/g, "");
  if (s === "" || s === "-") return null;
  return Number.isFinite(Number(s)) ? s : null;
}

function cleanInt(raw: string | undefined): number | null {
  const s = cleanNum(raw);
  if (s === null) return null;
  const n = Math.round(Number(s));
  return n > 0 ? n : null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "8/27/2026" | "2-Jul" | "2 Jul 2026" | ISO → "YYYY-MM-DD" (or null). */
export function parseSheetDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mdY = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // M/D/YYYY (sheets export)
  if (mdY) {
    const [, mm = "", dd = "", yy = ""] = mdY;
    return `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const dMon = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})\.?(?:[-\s](\d{2,4}))?$/); // 2-Jul[-2026]
  if (dMon) {
    const [, dd = "", mon = "", yRaw] = dMon;
    const mo = MONTHS[mon.slice(0, 3).toLowerCase()];
    if (!mo) return null;
    let year = yRaw ? Number(yRaw) : new Date().getFullYear();
    if (year < 100) year += 2000;
    return `${year}-${String(mo).padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const ACTION_MAP: Record<string, string> = {
  "buy now": "Buy Now", gtt: "GTT", "anlayse now": "Analyse Now",
  "analyse now": "Analyse Now", "analyze now": "Analyse Now", later: "Later",
};

// ---- Sheet detection --------------------------------------------------------------

export type SheetKind = "opportunities" | "open" | "closed";

interface Located { kind: SheetKind; headerIdx: number; headers: string[] }

/** Find the real header row (may not be row 0) and classify the sheet. */
export function locateSheet(rows: string[][]): Located | null {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const h = (rows[i] ?? []).map((c) => c.trim().toLowerCase());
    const has = (name: string) => h.some((c) => c === name || c.startsWith(name));
    if (has("sell date") && has("sell price")) {
      return { kind: "closed", headerIdx: i, headers: h };
    }
    if ((has("gtt/instant") || has("gtt/istant")) && has("buy date")) {
      return { kind: "open", headerIdx: i, headers: h };
    }
    if (has("script") && (has("action filter") || has("limit price"))) {
      return { kind: "opportunities", headerIdx: i, headers: h };
    }
  }
  return null;
}

function indexer(headers: string[]) {
  return (...names: string[]): number => {
    for (const n of names) {
      const i = headers.findIndex((h) => h === n || h.startsWith(n));
      if (i >= 0) return i;
    }
    return -1;
  };
}

// ---- Row mapping -------------------------------------------------------------------

export interface ImportResult {
  kind: SheetKind;
  opportunities: OpportunityDraft[];
  trades: TradeDraft[];
  skipped: number;
}

export function mapSheet(rows: string[][], loc: Located): ImportResult {
  const body = rows.slice(loc.headerIdx + 1);
  const col = indexer(loc.headers);
  const out: ImportResult = { kind: loc.kind, opportunities: [], trades: [], skipped: 0 };
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");

  if (loc.kind === "opportunities") {
    const c = {
      date: col("date"), symbol: col("script", "stock", "symbol"), cap: col("cap"),
      buy: col("buy price"), limit: col("limit price"), qty: col("qty"),
      strategy: col("strategy name", "strategy"), target: col("target"),
      action: col("action filter"), notes: col("analysis notes", "notes"),
    };
    for (const r of body) {
      const symbol = cell(r, c.symbol).toUpperCase();
      if (!symbol) { out.skipped++; continue; }
      out.opportunities.push({
        opp_date: parseSheetDate(cell(r, c.date)),
        symbol,
        cap_bucket: normalizeCap(cell(r, c.cap)),
        buy_price: cleanNum(cell(r, c.buy)),
        limit_price: cleanNum(cell(r, c.limit)),
        qty: cleanInt(cell(r, c.qty)),
        strategy: cell(r, c.strategy) || null,
        target_price: cleanNum(cell(r, c.target)),
        action_filter: (ACTION_MAP[cell(r, c.action).toLowerCase()] ?? null) as
          OpportunityDraft["action_filter"],
        notes: cell(r, c.notes) || null,
      });
    }
    return out;
  }

  if (loc.kind === "open") {
    const c = {
      type: col("gtt/instant", "gtt/istant"), cap: col("cap"),
      date: col("buy date"), symbol: col("stock", "script", "symbol"),
      buy: col("buy price", "buy rate"), qty: col("qty"),
      strategy: col("strategy name", "strategy"), target: col("target price", "target"),
      comments: col("comments"),
    };
    // The sheet's trailing unnamed column carries risk notes.
    const riskIdx = loc.headers.length - 1 > c.comments ? loc.headers.length - 1 : -1;
    for (const r of body) {
      const symbol = cell(r, c.symbol).toUpperCase();
      const buy_date = parseSheetDate(cell(r, c.date));
      const buy_price = cleanNum(cell(r, c.buy));
      const qty = cleanInt(cell(r, c.qty));
      if (!symbol || !buy_date || !buy_price || !qty) { out.skipped++; continue; }
      const t = cell(r, c.type);
      out.trades.push({
        status: "OPEN",
        order_type: /inst/i.test(t) ? "Instant" : t ? "GTT" : null,
        cap_bucket: normalizeCap(cell(r, c.cap)),
        symbol, buy_date, buy_price, qty,
        strategy: cell(r, c.strategy) || null,
        target_price: cleanNum(cell(r, c.target)),
        comments: cell(r, c.comments) || null,
        risk_notes: riskIdx >= 0 ? cell(r, riskIdx) || null : null,
      });
    }
    return out;
  }

  // closed
  const c = {
    status: col("status"), type: col("gtt/istant", "gtt/instant"),
    date: col("buy date"), symbol: col("stock", "script", "symbol"),
    buy: col("buy rate", "buy price"), qty: col("qty"),
    strategy: col("strategy"), target: col("target"),
    sellDate: col("sell date"), sellPrice: col("sell price"),
  };
  for (const r of body) {
    const symbol = cell(r, c.symbol).toUpperCase();
    const buy_date = parseSheetDate(cell(r, c.date));
    const buy_price = cleanNum(cell(r, c.buy));
    const qty = cleanInt(cell(r, c.qty));
    const sell_date = parseSheetDate(cell(r, c.sellDate));
    const sell_price = cleanNum(cell(r, c.sellPrice));
    if (!symbol || !buy_date || !buy_price || !qty || !sell_date || !sell_price) {
      out.skipped++; continue;
    }
    const t = cell(r, c.type);
    out.trades.push({
      status: "CLOSED",
      close_label: cell(r, c.status) || "Fully Booked",
      order_type: /inst/i.test(t) ? "Instant" : t ? "GTT" : null,
      symbol, buy_date, buy_price, qty,
      strategy: cell(r, c.strategy) || null,
      target_price: cleanNum(cell(r, c.target)),
      sell_date, sell_price,
    });
  }
  return out;
}

// ---- Export builders ----------------------------------------------------------------

import type { Opportunity, Trade } from "./journalApi";

export function exportOpportunities(rows: Opportunity[]): string {
  return toCsv(
    ["Date", "Script", "CAP", "Buy Price", "Limit Price", "Qty",
     "Strategy Name", "Target", "Action Filter", "Analysis Notes", "Status"],
    rows.map((o) => [o.opp_date, o.symbol, o.cap_bucket ? `${o.cap_bucket} Cap` : "",
      o.buy_price, o.limit_price, o.qty, o.strategy, o.target_price,
      o.action_filter, o.notes, o.status]),
  );
}

export function exportOpenTrades(rows: Trade[]): string {
  return toCsv(
    ["GTT/Instant", "CAP", "Buy Date", "Stock", "Buy Price", "Qty",
     "Strategy Name", "Target Price", "Comments", "Risk Notes"],
    rows.map((t) => [t.order_type, t.cap_bucket ? `${t.cap_bucket} Cap` : "",
      t.buy_date, t.symbol, t.buy_price, t.qty, t.strategy, t.target_price,
      t.comments, t.risk_notes]),
  );
}

export function exportClosedTrades(rows: Trade[]): string {
  return toCsv(
    ["Status", "GTT/Instant", "Buy Date", "Stock", "Buy Rate", "Qty",
     "Strategy", "Target", "Sell Date", "Sell Price"],
    rows.map((t) => [t.close_label ?? "Fully Booked", t.order_type,
      t.buy_date, t.symbol, t.buy_price, t.qty, t.strategy, t.target_price,
      t.sell_date, t.sell_price]),
  );
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
