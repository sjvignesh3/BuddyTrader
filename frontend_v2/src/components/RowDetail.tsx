// -----------------------------------------------------------------------------
// Expanded stock row — BuddyTrader layout: Strategy Details cards + the
// Fundamental Details panel (score pts, metric chips, latest-Q vs ATH,
// and the 11-check pass/fail grid), plus a slim price-action strip.
// -----------------------------------------------------------------------------
import type { StockRow } from "../lib/rows";
import StatusPill from "./StatusPill";
import { fmtCr, fmtMoney, fmtPct } from "../lib/money";

const STRATEGY_ORDER = [
  "envelope_200dma", "week52_high_low", "rally_20_percent", "fundamental_screener",
];
const STRATEGY_NAMES: Record<string, string> = {
  envelope_200dma: "Envelope (200 DMA)",
  week52_high_low: "52-Week High/Low",
  rally_20_percent: "20% Rally",
  fundamental_screener: "Fundamental Score",
};

function Chip({ label, value, unit = "" }: { label: string; value: string; unit?: string }) {
  return (
    <div className="bg-brand-bg/60 ring-1 ring-brand-border rounded-md px-2.5 py-1.5 text-center min-w-[68px]">
      <div className="text-[9px] uppercase tracking-wider text-brand-mute">{label}</div>
      <div className="text-xs font-bold font-mono tabular-nums mt-0.5">
        {value}{value !== "—" ? unit : ""}
      </div>
    </div>
  );
}

function fmt1(v: string | null | undefined, nd = 1): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(nd) : "—";
}

function fmtCrShort(v: string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `₹${Math.round(n / 1e7).toLocaleString("en-IN")} Cr` : "—";
}

export default function RowDetail({ row }: { row: StockRow }) {
  const s = row.snapshot;
  const ordered = [...row.results].sort(
    (a, b) => STRATEGY_ORDER.indexOf(a.strategy_id) - STRATEGY_ORDER.indexOf(b.strategy_id));
  const funda = row.funda;
  const d = funda?.data ?? {};
  // Legacy NOT-IN-CACHE: every check unknown = never scored.
  const notScored = funda !== null && funda.unknown >= funda.pointsMax;

  return (
    <div className="bg-brand-bg/40 px-4 py-4 space-y-4">
      {/* ── Price action strip ── */}
      <div className="flex flex-wrap gap-2">
        <Chip label="O / H / L" value={`${fmtMoney(s.open)} / ${fmtMoney(s.high)} / ${fmtMoney(s.low)}`} />
        <Chip label="Adj Close" value={fmtMoney(s.adj_close)} />
        <Chip label="MCap" value={fmtCr(row.snapshot.market_cap as string)} />
        <Chip label="Dist 52W High" value={fmtPct(s.distance_from_52w_high_pct ?? null)} />
        <Chip label="Revenue TTM" value={fmtCrShort(s.revenue_ttm as string)} />
        <Chip label="Net margin" value={fmtPct(s.profit_margin_pct as string)} />
      </div>

      {/* ── Strategy details ── */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute mb-2">
          Strategy details
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {ordered.filter((r) => r.strategy_id !== "fundamental_screener").map((r) => (
            <div key={r.strategy_id}
                 className="rounded-lg ring-1 ring-brand-border bg-brand-panel/60 px-3 py-2.5">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-semibold">
                  {STRATEGY_NAMES[r.strategy_id] ?? r.strategy_id}
                </span>
                <StatusPill status={r.status} />
                <span className="text-[10px] text-brand-mute font-mono">
                  score {Number(r.score) || 0}
                </span>
              </div>
              <ul className="text-[11px] text-brand-mute leading-relaxed">
                {(r.reasons ?? []).map((reason, i) => (
                  <li key={i}>• {String(reason)}</li>
                ))}
              </ul>
              {r.strategy_id === "rally_20_percent" && r.status === "VALID" && (
                <div className="flex flex-wrap gap-2 mt-2">
                  <span className="text-[10px] font-mono font-semibold px-2 py-1 rounded bg-emerald-500/15 text-emerald-400">
                    📥 Next Buy ₹{row.rallyLow?.toLocaleString("en-IN", { minimumFractionDigits: 2 }) ?? "—"}
                  </span>
                  <span className="text-[10px] font-mono font-semibold px-2 py-1 rounded bg-red-500/15 text-red-400">
                    📤 Next Sell ₹{row.rallyHigh?.toLocaleString("en-IN", { minimumFractionDigits: 2 }) ?? "—"}
                  </span>
                  {row.daysSinceRally !== null && (
                    <span className="text-[10px] font-mono px-2 py-1 rounded bg-sky-500/15 text-sky-400">
                      🕒 {row.daysSinceRally}d ago
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Fundamental details (the 11 checks) ── */}
      <div className="rounded-lg ring-1 ring-brand-border bg-brand-panel/60 px-3 py-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
            📊 Fundamental details
          </span>
          {funda && !notScored ? (
            <span className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded ${
              funda.points >= 8 ? "bg-emerald-500/15 text-emerald-400"
                : funda.points >= 6 ? "bg-amber-500/15 text-amber-400"
                  : "bg-red-500/15 text-red-400"}`}>
              {funda.points}<span className="font-normal opacity-70">/{funda.pointsMax}</span> pts
            </span>
          ) : (
            <span className="text-[10px] px-2 py-0.5 rounded bg-brand-bg text-brand-mute font-semibold">
              NOT SCORED — fundamentals fetch on the next daily sync
            </span>
          )}
          {funda && !notScored && funda.unknown > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand-bg text-brand-mute">
              {funda.unknown} N/A
            </span>
          )}
        </div>

        {funda && (
          <>
            {/* Metric chips (legacy summary row) */}
            <div className="flex flex-wrap gap-1.5 pb-2.5 mb-2.5 border-b border-brand-border/60">
              <Chip label="PE" value={fmt1(d.current_pe)} />
              <Chip label="5yr Avg PE" value={fmt1(d.pe_5yr_avg)} />
              <Chip label="PB" value={fmt1(d.current_pb, 2)} />
              <Chip label="5yr Avg PB" value={fmt1(d.pb_5yr_avg, 2)} />
              <Chip label="ROCE" value={fmt1(d.roce)} unit="%" />
              <Chip label="ROE" value={fmt1(d.roe)} unit="%" />
              <Chip label="ND/Eq" value={fmt1(d.net_debt_to_equity, 2)} />
              <Chip label="Pledging" value={fmt1(d.pledging)} unit="%" />
              <Chip label="OPM" value={fmt1(d.latest_opm)} unit="%" />
              <Chip label="Promoter" value={fmt1(d.promoter_holding)} unit="%" />
            </div>

            {/* Latest quarter vs ATH quarter */}
            <div className="flex flex-wrap gap-2 mb-2.5 text-[10px] text-brand-mute">
              <span className="bg-brand-bg/60 rounded px-2 py-1">
                Latest Q Sales <b className="text-brand-text font-mono">{fmtCrShort(d.latest_sales)}</b>
                {" "}/ ATH {fmtCrShort(d.ath_sales)}
              </span>
              <span className="bg-brand-bg/60 rounded px-2 py-1">
                Latest Q PBT <b className="text-brand-text font-mono">{fmtCrShort(d.latest_pbt)}</b>
                {" "}/ ATH {fmtCrShort(d.ath_pbt)}
              </span>
              <span className="bg-brand-bg/60 rounded px-2 py-1">
                Latest Q Net Profit <b className="text-brand-text font-mono">{fmtCrShort(d.latest_profit)}</b>
                {" "}/ ATH {fmtCrShort(d.ath_profit)}
              </span>
            </div>

            {/* The 11-check grid */}
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {funda.checks.map((chk, i) => {
                const state = chk.passed === null ? "na" : chk.passed ? "pass" : "fail";
                const cls = state === "pass"
                  ? "ring-emerald-500/25 bg-emerald-500/[0.06]"
                  : state === "fail"
                    ? "ring-red-500/25 bg-red-500/[0.06]"
                    : "ring-brand-border bg-brand-bg/40";
                const icon = state === "pass" ? "✅" : state === "fail" ? "❌" : "❓";
                return (
                  <div key={chk.id ?? i}
                       className={`flex items-start gap-2 rounded-md ring-1 px-2.5 py-1.5 ${cls}`}>
                    <span className="text-[11px] mt-0.5">{icon}</span>
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold truncate">
                        {i + 1}. {chk.label}
                      </div>
                      <div className="text-[10px] text-brand-mute">{chk.detail}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
