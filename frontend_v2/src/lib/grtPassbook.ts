// -----------------------------------------------------------------------------
// GRT Insta Gold passbook PDF → transactions. Pure: takes the positioned text
// that lib/pdfText.ts pulls out of the PDF, so it is unit-testable without one.
//
// The passbook is a table whose cells wrap onto two lines (date + AM/PM, the
// rate "13150.0" + "0", the long transaction number). Each row is anchored on
// its serial number in the Sno column; every other piece of text joins the
// nearest anchor and lands in a column by its x position. The diagonal
// "GRT INSTA GOLD" watermark is dropped by its rotation.
// -----------------------------------------------------------------------------
import type { PdfPageText, PdfTextItem } from "./pdfText";

export interface PassbookTxn {
  sno: number;
  /** Local date-time, "2026-11-06T16:48". */
  when: string;
  /** "2026-11-06". */
  day: string;
  amountPaise: number;
  ratePaise: number;
  mode: string;
  tranNo: string;
  status: string;
  weightMg: number;
  benefitMg: number;
  totalMg: number;
}

export interface PassbookTotals {
  amountPaise: number;
  weightMg: number;
  benefitMg: number;
  totalMg: number;
}

export interface ParsedPassbook {
  membershipNo: string | null;
  planName: string | null;
  txns: PassbookTxn[];
  /** The passbook's own Total row, when present. */
  totals: PassbookTotals | null;
  /** Rows that could not be read, by serial number or raw text. */
  problems: string[];
}

type Col = "sno" | "date" | "amount" | "rate" | "mode" | "tranNo" | "status" | "weight" | "benefit" | "total";

const HEADERS: [Col, RegExp][] = [
  ["sno", /^Sno\.?$/i], ["date", /^Tran\.?\s*Date/i], ["amount", /^Amount/i], ["rate", /^Rate/i],
  ["mode", /^Pay\.?/i], ["tranNo", /^Tran\.?\s*No/i], ["status", /^Status/i], ["weight", /^Weight/i],
  ["benefit", /^Benefit/i], ["total", /^Total/i],
];

/** Column left edges seen in GRT passbooks (Nov 2026) — used when a page has no header. */
const DEFAULT_COLS: Record<Col, number> = {
  sno: 23, date: 53.4, amount: 133, rate: 186.1, mode: 228.7, tranNo: 276.1,
  status: 389.8, weight: 440.9, benefit: 488.3, total: 535.7,
};

const SPACE_JOINED: ReadonlySet<Col> = new Set(["date", "mode"]);
const ROW_REACH = 12;          // pt: wrapped cell lines sit ~4.7pt above/below the anchor
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function findColumns(items: PdfTextItem[]): Record<Col, number> | null {
  const sno = items.find((i) => HEADERS[0]![1].test(i.str.trim()));
  if (!sno) return null;
  const cols = { ...DEFAULT_COLS };
  for (const it of items) {
    if (Math.abs(it.y - sno.y) > 8) continue;
    const hit = HEADERS.find(([, re]) => re.test(it.str.trim()));
    if (hit) cols[hit[0]] = it.x;
  }
  return cols;
}

function colOf(x: number, cols: Record<Col, number>): Col {
  let best: Col = "sno";
  let bestX = -Infinity;
  for (const [c, cx] of Object.entries(cols) as [Col, number][]) {
    if (cx <= x + 3 && cx > bestX) { best = c; bestX = cx; }
  }
  return best;
}

const toPaise = (s: string): number | null => {
  const m = s.replace(/Rs\.?|₹|,|\s/gi, "").match(/^\d+(\.\d+)?$/);
  return m ? Math.round(Number(m[0]) * 100) : null;
};

const toMg = (s: string): number | null => {
  const m = s.match(/(\d+(?:\.\d+)?)\s*g/i);
  return m ? Math.round(Number(m[1]) * 1000) : null;
};

/** "06-Nov-2026 04:48 PM" → "2026-11-06T16:48". */
export function parseGrtDate(s: string): string | null {
  const m = s.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  const month = MONTHS[m[2]!.toLowerCase()];
  if (!month) return null;
  let h = Number(m[4]);
  const ap = m[6]?.toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return `${m[3]}-${month}-${m[1]!.padStart(2, "0")}T${String(h).padStart(2, "0")}:${m[5]}`;
}

function labelValue(items: PdfTextItem[], label: RegExp): string | null {
  const l = items.find((i) => label.test(i.str));
  if (!l) return null;
  const inline = l.str.replace(label, "").trim();
  if (inline) return inline;
  const next = items
    .filter((i) => Math.abs(i.y - l.y) < 2 && i.x > l.x)
    .sort((a, b) => a.x - b.x)[0];
  return next?.str.trim() ?? null;
}

export function parseGrtPassbook(pages: PdfPageText[]): ParsedPassbook {
  const all = pages.flat();
  const out: ParsedPassbook = {
    membershipNo: labelValue(all, /^Membership No\.?:?/i),
    planName: labelValue(all, /^Plan Name:?/i),
    txns: [], totals: null, problems: [],
  };
  let cols: Record<Col, number> | null = null;

  for (const raw of pages) {
    const items = raw.filter((i) => i.rot === 0);
    cols = findColumns(items) ?? cols;
    const c = cols ?? DEFAULT_COLS;
    const header = items.find((i) => HEADERS[0]![1].test(i.str.trim()));

    const anchors = items.filter((i) =>
      colOf(i.x, c) === "sno" && (/^\d+$/.test(i.str.trim()) || /^Total$/i.test(i.str.trim())) &&
      (!header || i.y < header.y - 4));
    if (!anchors.length) continue;

    const cells = anchors.map(() => new Map<Col, PdfTextItem[]>());
    for (const it of items) {
      if (anchors.includes(it)) continue;
      let k = -1;
      let dy = ROW_REACH;
      anchors.forEach((a, idx) => {
        const d = Math.abs(a.y - it.y);
        if (d <= dy) { dy = d; k = idx; }
      });
      if (k < 0) continue;
      const col = colOf(it.x, c);
      const m = cells[k]!;
      m.set(col, [...(m.get(col) ?? []), it]);
    }

    anchors.forEach((a, idx) => {
      const get = (col: Col) =>
        (cells[idx]!.get(col) ?? [])
          .sort((p, q) => q.y - p.y || p.x - q.x)
          .map((i) => i.str.trim())
          .join(SPACE_JOINED.has(col) ? " " : "");
      const label = a.str.trim();

      if (/^Total$/i.test(label)) {
        const amountPaise = toPaise(get("amount"));
        const w = toMg(get("weight")), b = toMg(get("benefit")), t = toMg(get("total"));
        if (amountPaise !== null && w !== null && b !== null && t !== null) {
          out.totals = { amountPaise, weightMg: w, benefitMg: b, totalMg: t };
        }
        return;
      }

      const when = parseGrtDate(get("date"));
      const amountPaise = toPaise(get("amount"));
      const ratePaise = toPaise(get("rate"));
      const w = toMg(get("weight")), b = toMg(get("benefit")), t = toMg(get("total"));
      if (!when || amountPaise === null || !ratePaise || w === null || b === null || t === null) {
        out.problems.push(`Row ${label}`);
        return;
      }
      out.txns.push({
        sno: Number(label), when, day: when.slice(0, 10), amountPaise, ratePaise,
        mode: get("mode"), tranNo: get("tranNo"), status: get("status"),
        weightMg: w, benefitMg: b, totalMg: t,
      });
    });
  }
  out.txns.sort((p, q) => p.when.localeCompare(q.when) || p.sno - q.sno);
  return out;
}

export interface TotalsCheck {
  ok: boolean;
  /** Field-by-field: what the rows add up to vs. the passbook's Total row. */
  diffs: { field: keyof PassbookTotals; rows: number; passbook: number }[];
}

/** Compare the parsed rows with the passbook's own Total row. */
export function checkTotals(p: ParsedPassbook): TotalsCheck | null {
  if (!p.totals) return null;
  const sum = p.txns.reduce((s, t) => ({
    amountPaise: s.amountPaise + t.amountPaise, weightMg: s.weightMg + t.weightMg,
    benefitMg: s.benefitMg + t.benefitMg, totalMg: s.totalMg + t.totalMg,
  }), { amountPaise: 0, weightMg: 0, benefitMg: 0, totalMg: 0 });
  const diffs = (Object.keys(sum) as (keyof PassbookTotals)[])
    .filter((f) => sum[f] !== p.totals![f])
    .map((f) => ({ field: f, rows: sum[f], passbook: p.totals![f] }));
  return { ok: diffs.length === 0, diffs };
}

/** Merge several passbooks, dropping a transaction seen twice (by transaction number). */
export function mergeTxns(books: ParsedPassbook[]): { txns: PassbookTxn[]; duplicates: number } {
  const seen = new Map<string, PassbookTxn>();
  let duplicates = 0;
  for (const b of books) {
    for (const t of b.txns) {
      const key = t.tranNo || `${t.when}|${t.amountPaise}|${t.sno}`;
      if (seen.has(key)) duplicates++;
      else seen.set(key, t);
    }
  }
  const txns = [...seen.values()].sort((p, q) => p.when.localeCompare(q.when) || p.sno - q.sno);
  return { txns, duplicates };
}
