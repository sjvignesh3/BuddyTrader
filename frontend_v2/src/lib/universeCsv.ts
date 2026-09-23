// -----------------------------------------------------------------------------
// CSV import / export for the Universe page.
//
// Import accepts three shapes, detected from the header row:
//   * a plain list:  Symbol[, Name][, Sector][, Cap][, Group]
//   * the master template ("List, Sector, Short Form, Category, For TV,
//     Market Cap, …" with three side-by-side tables) — the LEFT table only,
//     filtered to the pool being imported via its "Short Form" column;
//   * a one-column file of symbols with no header at all.
// Values are passed through raw; the API normalises cap types and sector
// groups ("Large Cap" → "Large", "Banks" → group Banks) and rejects junk.
// Export writes the same columns so a file round-trips through import.
// -----------------------------------------------------------------------------
import { parseCsv, toCsv } from "./journalCsv";
import type { ImportRow, UniverseStock } from "./universeApi";
import { plainSymbol } from "./universeApi";

export interface ParsedImport {
  rows: ImportRow[];
  /** which header layout was recognised */
  layout: "plain" | "master-template" | "symbols-only";
  /** rows skipped because they belonged to another pool (master template) */
  skippedOtherPool: number;
  /** header names we mapped, for the preview */
  columns: string[];
}

const SYMBOL_HEADERS = ["symbol", "list", "ticker", "script", "scrip", "stock", "nse symbol"];
const NAME_HEADERS = ["name", "company", "company name"];
const SECTOR_HEADERS = ["sector", "industry"];
const CAP_HEADERS = ["cap", "cap type", "market cap", "cap_type", "cap bucket", "mcap"];
const GROUP_HEADERS = ["group", "sector group", "sector_group", "criteria", "class"];
const POOL_HEADERS = ["short form", "pool", "pool code"];

function findCol(headers: string[], names: string[]): number {
  for (const n of names) {
    const i = headers.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

const looksLikeSymbol = (s: string) => /^[A-Za-z0-9&-]{1,20}(\.(NS|BO))?$/i.test(s.trim());

/**
 * Parse CSV text into import rows for `pool`. Throws with a readable message
 * when nothing usable is found.
 */
export function parseUniverseCsv(text: string, pool: string): ParsedImport {
  const grid = parseCsv(text);
  if (!grid.length) throw new Error("The file is empty.");

  const header = (grid[0] ?? []).map((c) => c.trim().toLowerCase());
  const symbolIdx = findCol(header, SYMBOL_HEADERS);

  // No recognisable header → treat the first column as symbols.
  if (symbolIdx < 0) {
    const rows = grid
      .map((r) => (r[0] ?? "").trim())
      .filter((s) => s && looksLikeSymbol(s))
      .map((symbol) => ({ symbol }));
    if (!rows.length) {
      throw new Error("No symbol column found. Use a header like Symbol, Sector, Cap, Group "
        + "— or a one-column list of symbols.");
    }
    return { rows, layout: "symbols-only", skippedOtherPool: 0, columns: ["symbol"] };
  }

  const nameIdx = findCol(header, NAME_HEADERS);
  const sectorIdx = findCol(header, SECTOR_HEADERS);
  const capIdx = findCol(header, CAP_HEADERS);
  const groupIdx = findCol(header, GROUP_HEADERS);
  const poolIdx = findCol(header, POOL_HEADERS);
  const isMaster = header[0] === "list" && poolIdx >= 0;

  const rows: ImportRow[] = [];
  let skippedOtherPool = 0;
  for (const r of grid.slice(1)) {
    const symbol = (r[symbolIdx] ?? "").trim();
    if (!symbol) continue;
    if (isMaster) {
      const rowPool = (r[poolIdx] ?? "").trim();
      if (!rowPool) continue;                    // filler rows of the other tables
      if (rowPool.toUpperCase() !== pool.toUpperCase()) { skippedOtherPool++; continue; }
    }
    const row: ImportRow = { symbol };
    const put = (k: keyof ImportRow, idx: number) => {
      if (idx < 0) return;
      const v = (r[idx] ?? "").trim();
      if (v && v !== "#N/A") row[k] = v;
    };
    put("name", nameIdx);
    put("sector", sectorIdx);
    put("cap_type", capIdx);
    put("sector_group", groupIdx);
    rows.push(row);
  }
  if (!rows.length) {
    throw new Error(isMaster
      ? `No rows tagged "${pool}" in the Short Form column.`
      : "No rows with a symbol found under the header.");
  }
  const columns = ["symbol",
    ...(nameIdx >= 0 ? ["name"] : []),
    ...(sectorIdx >= 0 ? ["sector"] : []),
    ...(capIdx >= 0 ? ["cap_type"] : []),
    ...(groupIdx >= 0 ? ["sector_group"] : [])];
  return { rows, layout: isMaster ? "master-template" : "plain", skippedOtherPool, columns };
}

/** Export rows for one pool (or all when `pool` is null). */
export function universeToCsv(stocks: UniverseStock[], pool: string | null): string {
  const headers = ["Symbol", "Name", "Sector", "Cap", "Group", "Pools", "Active"];
  const rows = stocks
    .filter((s) => pool === null || (s.pools ?? []).includes(pool))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((s) => [
      plainSymbol(s.symbol), s.name ?? "", s.sector ?? "", s.cap_type_manual ?? "",
      s.sector_group ?? "", (s.pools ?? []).join(" "), s.active ? "yes" : "no",
    ]);
  return toCsv(headers, rows);
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
