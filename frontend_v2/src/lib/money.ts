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

/** ISO date → "15 Jan 2025". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  }).replace(/ /g, NBSP);
}

/** Colour class for a scan status pill. */
export function statusClass(status: string): string {
  switch (status) {
    case "BUY_ZONE": return "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30";
    case "OPPORTUNITY": return "bg-amber-500/15 text-amber-400 ring-amber-500/30";
    case "VALID": return "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30";
    case "INVALID": return "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20";
    case "ERROR": return "bg-red-500/15 text-red-400 ring-red-500/30";
    default: return "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20";
  }
}
