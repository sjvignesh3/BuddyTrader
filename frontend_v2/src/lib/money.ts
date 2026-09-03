// -----------------------------------------------------------------------------
// Money / ratio display formatting.
//
// Contract:
//   * Input is ALWAYS a string (as sent by the API — Decimal preserved).
//   * We convert to Number ONLY for locale display, never for computation.
//   * Any downstream arithmetic MUST use the raw string with a big-decimal lib.
// -----------------------------------------------------------------------------

const NBSP = "\u00A0";

/** Format an Indian-style money string, e.g. "3,500.50". Never NaN. */
export function fmtMoney(value: string | number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Percent formatter — expects the raw pct value, e.g. "14.2" → "14.20%". */
export function fmtPct(value: string | number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

/** Raw-₹ value → "₹ 17,25,340 Cr" (divide by 1e7). Plan §4.1: market_cap is
 * stored in absolute rupees; the frontend converts to crores for display. */
export function fmtCr(value: string | number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return `₹${(n / 1e7).toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}${NBSP}Cr`;
}

/** ISO date → "15 Jan 2025". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  }).replace(/ /g, NBSP);
}

/** Colour class for a scan / sync-job status pill (light theme). */
export function statusClass(status: string): string {
  switch (status) {
    // Scan-result statuses
    case "BUY_ZONE": return "bg-teal-50 text-teal-800 ring-teal-300";
    case "OPPORTUNITY": return "bg-amber-50 text-amber-800 ring-amber-300";
    case "VALID": return "bg-sky-50 text-sky-800 ring-sky-300";
    case "INVALID": return "bg-stone-100 text-stone-500 ring-stone-200";
    case "ERROR": return "bg-rose-50 text-rose-700 ring-rose-300";
    case "NO_SIGNAL": return "bg-stone-100 text-stone-500 ring-stone-200";
    case "PASS": return "bg-teal-50 text-teal-800 ring-teal-300";
    case "FAIL": return "bg-rose-50 text-rose-700 ring-rose-300";
    // Sync-job statuses
    case "ok": return "bg-teal-50 text-teal-800 ring-teal-300";
    case "running": return "bg-sky-50 text-sky-800 ring-sky-300";
    case "partial": return "bg-amber-50 text-amber-800 ring-amber-300";
    case "failed": return "bg-rose-50 text-rose-700 ring-rose-300";
    default: return "bg-stone-100 text-stone-500 ring-stone-200";
  }
}
