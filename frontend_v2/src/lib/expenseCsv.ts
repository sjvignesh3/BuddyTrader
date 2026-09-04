// -----------------------------------------------------------------------------
// Expense CSV import/export.
//
// Import understands two shapes:
//   1. The user's Google Sheet "Expense Journal" export:
//      Year,Item,Amount (₹),Day,Month,Date,Category,Notes
//   2. A Plutus export (or any CSV with name/amount/date headers).
// Category travels as a NAME — the backend resolves it against
// expense_categories (case-insensitive) and creates unknown ones, so the
// one-time migration never drops a classification.
// -----------------------------------------------------------------------------
import type { Expense } from "./expensesApi";
import type { ImportRow } from "./expensesApi";
import { parseSheetDate, toCsv } from "./journalCsv";

export { downloadCsv, parseCsv } from "./journalCsv";

const cleanAmount = (raw: string | undefined): string | null => {
  if (!raw) return null;
  const s = raw.replace(/[₹,\s"]/g, "");
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? String(n) : null;
};

const norm = (s: string): string => s.trim().toLowerCase().replace(/[^a-z]/g, "");

export interface ExpenseImportResult {
  rows: ImportRow[];
  skipped: number;
}

/** Detect the header row and map every data row to an ImportRow.
 * Returns null when no usable header is found. */
export function mapExpenseSheet(grid: string[][]): ExpenseImportResult | null {
  // Find a header row containing at least an item/name column and an amount.
  let headerIdx = -1;
  let cols: Record<string, number> = {};
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const row = grid[i] ?? [];
    const map: Record<string, number> = {};
    row.forEach((h, idx) => { map[norm(h)] = idx; });
    const nameIdx = map.item ?? map.name ?? map.expense ?? map.description;
    const amtIdx = map.amount ?? map.amountr ?? map.amt;
    if (nameIdx !== undefined && amtIdx !== undefined) {
      headerIdx = i;
      cols = map;
      break;
    }
  }
  if (headerIdx < 0) return null;

  const idx = (...keys: string[]): number | undefined => {
    for (const k of keys) if (cols[k] !== undefined) return cols[k];
    return undefined;
  };
  const cName = idx("item", "name", "expense", "description")!;
  const cAmount = idx("amount", "amountr", "amt")!;
  const cDate = idx("date", "expensedate");
  const cCategory = idx("category");
  const cNotes = idx("notes", "note", "comments");
  const cIntent = idx("intent", "needwant");
  const cPayment = idx("paymentmethod", "payment", "mode");
  const cMerchant = idx("merchant", "vendor");

  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const r of grid.slice(headerIdx + 1)) {
    const name = (r[cName] ?? "").trim();
    const amount = cleanAmount(r[cAmount]);
    const date = cDate !== undefined ? parseSheetDate(r[cDate]) : null;
    // Blank template rows (the sheet has hundreds) are ignored silently;
    // rows with an item but a broken amount/date are counted as skipped.
    if (!name && amount === null) continue;
    if (!name || amount === null || !date) { skipped += 1; continue; }
    const category = (cCategory !== undefined ? (r[cCategory] ?? "").trim() : "");
    const intentRaw = cIntent !== undefined ? norm(r[cIntent] ?? "") : "";
    rows.push({
      name,
      amount,
      expense_date: date,
      category: category && category !== "#N/A" ? category : undefined,
      notes: cNotes !== undefined ? (r[cNotes] ?? "").trim() || null : null,
      intent: intentRaw === "need" ? "need" : intentRaw === "want" ? "want" : null,
      payment_method: cPayment !== undefined ? (r[cPayment] ?? "").trim() || null : null,
      merchant: cMerchant !== undefined ? (r[cMerchant] ?? "").trim() || null : null,
    });
  }
  return { rows, skipped };
}

/** Export expenses (already filtered by the caller) to a re-importable CSV. */
export function exportExpenses(
  rows: Expense[], categoryLabel: (id: number | null) => string,
): string {
  return toCsv(
    ["Date", "Item", "Amount", "Category", "Intent", "Payment Method",
      "Merchant", "Notes", "Tags"],
    rows.map((e) => [
      e.expense_date, e.name, e.amount, categoryLabel(e.category_id),
      e.intent, e.payment_method, e.merchant, e.notes,
      e.tags?.join("; ") ?? null,
    ]),
  );
}
