// -----------------------------------------------------------------------------
// Expanded stock row — the full story: price-action strip, per-strategy
// verdict cards (with rally entry/exit levels), and the Fundamental panel
// (score ring, metric chips, latest-Q vs ATH, the 11-check grid).
// -----------------------------------------------------------------------------
import { useState } from "react";
import type { StockRow } from "../lib/rows";
import ScoreRing from "./ScoreRing";
import StatusPill from "./StatusPill";
import StockPositions from "./StockPositions";
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
    <div className="bg-brand-soft ring-1 ring-brand-border rounded-lg px-2.5 py-1.5 text-center min-w-[70px]">
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

export default function RowDetail({ row, isHeld = false }: {
  row: StockRow;
  /** true when the journal holds an open position in this stock */
  isHeld?: boolean;
}) {
  const s = row.snapshot;
  const ordered = [...row.results].sort(
    (a, b) => STRATEGY_ORDER.indexOf(a.strategy_id) - STRATEGY_ORDER.indexOf(b.strategy_id));
  const funda = row.funda;
  const d = funda?.data ?? {};
  const notScored = funda !== null && funda.unknown >= funda.pointsMax;
  const [tab, setTab] = useState<"analysis" | "positions">("analysis");

  const tabBtn = (key: typeof tab, label: string) => (
    <button
      onClick={(e) => { e.stopPropagation(); setTab(key); }}
      className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
        tab === key
          ? "bg-teal-700 text-white shadow-card"
          : "text-brand-mute hover:text-brand-text bg-brand-panel ring-1 ring-brand-border"}`}>
      {label}
    </button>
  );

  if (tab === "positions") {
    return (
      <div className="bg-brand-soft/70 px-4 py-4 space-y-3 font-sans">
        <div className="inline-flex gap-1">
          {tabBtn("analysis", "Analysis")}
          {tabBtn("positions", isHeld ? "My positions 💼" : "My positions")}
        </div>
        <StockPositions symbol={row.symbol}
                        cmp={row.close} />
      </div>
    );
  }

  return (
    <div className="bg-brand-soft/70 px-4 py-4 space-y-4 font-sans">
      <div className="inline-flex gap-1">
        {tabBtn("analysis", "Analysis")}
        {tabBtn("positions", isHeld ? "My positions 💼" : "My positions")}
      </div>
      {/* ── Price action strip ── */}
      <div className="flex flex-wrap gap-2">
        <Chip label="O / H / L" value={`${fmtMoney(s.open)} / ${fmtMoney(s.high)} / ${fmtMoney(s.low)}`} />
        <Chip label="Adj Close" value={fmtMoney(s.adj_close)} />
        <Chip label="MCap" value={fmtCr(row.snapshot.market_cap as string)} />
        <Chip label="Dist 52W High" value={fmtPct(s.distance_from_52w_high_pct ?? null)} />
        <Chip label="Revenue TTM" value={fmtCrShort(s.revenue_ttm as string)} />
        <Chip label="Net margin" value={fmtPct(s.profit_margin_pct as string)} />
      </div>

      {/* ── Strategy verdicts ── */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute mb-2">
          Strategy verdicts
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {ordered.filter((r) => r.strategy_id !== "fundamental_screener").map((r) => (
            <div key={r.strategy_id}
                 className="rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-card px-3 py-2.5">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className="text-xs font-semibold">
                  {STRATEGY_NAMES[r.strategy_id] ?? r.strategy_id}
                </span>
                <StatusPill status={r.status} />
                <span className="text-[10px] text-brand-mute font-mono">
                  {Number(r.score) || 0} pts
                </span>
              </div>
              <ul className="text-[11px] text-brand-mute leading-relaxed">
                {(r.reasons ?? []).map((reason, i) => (
                  <li key={i}>• {String(reason)}</li>
                ))}
              </ul>
              {r.strategy_id === "rally_20_percent" && r.status === "VALID" && (
                <div className="flex flex-wrap gap-2 mt-2">
                  <span className="text-[10px] font-mono font-bold px-2 py-1 rounded-md bg-teal-50 text-teal-800 ring-1 ring-teal-200">
                    📥 Next buy ₹{row.rallyLow?.toLocaleString("en-IN", { minimumFractionDigits: 2 }) ?? "—"}
                  </span>
                  <span className="text-[10px] font-mono font-bold px-2 py-1 rounded-md bg-rose-50 text-rose-700 ring-1 ring-rose-200">
                    📤 Next sell ₹{row.rallyHigh?.toLocaleString("en-IN", { minimumFractionDigits: 2 }) ?? "—"}
                  </span>
                  {row.daysSinceRally !== null && (
                    <span className="text-[10px] font-mono px-2 py-1 rounded-md bg-sky-50 text-sky-800 ring-1 ring-sky-200">
                      🕒 {row.daysSinceRally}d ago
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Fundamental panel ── */}
      <div className="rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3">
        <div className="flex items-center gap-3 mb-2.5">
          <ScoreRing points={notScored ? null : funda?.points ?? null} size={40} />
          <div className="flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
              Fundamental details
            </div>
            {funda && !notScored ? (
              <div className="text-xs">
                <b>{funda.points}/{funda.pointsMax}</b> checks pass
                {funda.unknown > 0 && (
                  <span className="text-brand-mute"> · {funda.unknown} N/A</span>
                )}
              </div>
            ) : (
              <div className="text-xs text-brand-mute">
                Not scored — fundamentals fetch on the next daily sync
                (or use Fetch now in Play Area)
              </div>
            )}
          </div>
          {/* Screener.in deep link — the reference every number reconciles to */}
          <a
            href={`https://www.screener.in/company/${row.symbol.replace(/\.(NS|BO)$/, "")}/consolidated/`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-brand-soft ring-1 ring-brand-border text-brand-accent hover:bg-teal-50 hover:ring-teal-300 transition-colors"
          >
            View on screener.in
            <span className="text-[10px]">↗</span>
          </a>
        </div>

        {funda && (
          <>
            <div className="flex flex-wrap gap-1.5 pb-2.5 mb-2.5 border-b border-brand-border">
              <Chip label="PE" value={fmt1(d.current_pe)} />
              <Chip label="5yr Avg PE" value={fmt1(d.pe_5yr_avg)} />
              <Chip label="PB" value={fmt1(d.current_pb, 2)} />
              <Chip label="5yr Avg PB" value={fmt1(d.pb_5yr_avg, 2)} />
              <Chip label="ROCE" value={fmt1(d.roce)} unit="%" />
              <Chip label="ROE" value={fmt1(d.roe)} unit="%" />
              <Chip label="ND/Eq" value={fmt1(d.net_debt_to_equity, 2)} />
              <Chip label="Pledging" value={fmt1(d.pledging)} unit="%" />
              <Chip label="Promoter" value={fmt1(d.promoter_holding)} unit="%" />
            </div>

            <div className="flex flex-wrap gap-2 mb-2.5 text-[10px] text-brand-mute">
              <span className="bg-brand-soft ring-1 ring-brand-border rounded-md px-2 py-1">
                Latest Q Sales <b className="text-brand-text font-mono">{fmtCrShort(d.latest_sales)}</b>
                {" "}/ ATH {fmtCrShort(d.ath_sales)}
              </span>
              <span className="bg-brand-soft ring-1 ring-brand-border rounded-md px-2 py-1">
                Latest Q PBT <b className="text-brand-text font-mono">{fmtCrShort(d.latest_pbt)}</b>
                {" "}/ ATH {fmtCrShort(d.ath_pbt)}
              </span>
              <span className="bg-brand-soft ring-1 ring-brand-border rounded-md px-2 py-1">
                Latest Q Net Profit <b className="text-brand-text font-mono">{fmtCrShort(d.latest_profit)}</b>
                {" "}/ ATH {fmtCrShort(d.ath_profit)}
              </span>
              {d.yoy_profit != null && (
                <span className="bg-teal-50 ring-1 ring-teal-200 rounded-md px-2 py-1 text-teal-800">
                  Same Q last year{d.yoy_quarter ? ` (${d.yoy_quarter})` : ""}{" "}
                  <b className="font-mono">{fmtCrShort(d.yoy_profit)}</b>
                  {(() => {
                    const lq = Number(d.latest_profit);
                    const yy = Number(d.yoy_profit);
                    if (!Number.isFinite(lq) || !Number.isFinite(yy) || yy <= 0) return null;
                    const g = ((lq - yy) / yy) * 100;
                    return (
                      <b className={`ml-1 ${g >= 0 ? "text-teal-700" : "text-rose-600"}`}>
                        {g >= 0 ? "+" : ""}{g.toFixed(1)}% YoY
                      </b>
                    );
                  })()}
                </span>
              )}
            </div>

            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {funda.checks.map((chk, i) => {
                const state = chk.passed === null ? "na" : chk.passed ? "pass" : "fail";
                const cls = state === "pass"
                  ? "ring-teal-200 bg-teal-50/70"
                  : state === "fail"
                    ? "ring-rose-200 bg-rose-50/70"
                    : "ring-brand-border bg-brand-soft";
                const icon = state === "pass" ? "✓" : state === "fail" ? "✕" : "?";
                const iconCls = state === "pass" ? "bg-teal-600 text-white"
                  : state === "fail" ? "bg-rose-500 text-white"
                    : "bg-stone-300 text-stone-600";
                return (
                  <div key={chk.id ?? i}
                       className={`flex items-start gap-2 rounded-lg ring-1 px-2.5 py-1.5 ${cls}`}>
                    <span className={`mt-0.5 w-4 h-4 shrink-0 grid place-items-center rounded-full text-[9px] font-bold ${iconCls}`}>
                      {icon}
                    </span>
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
