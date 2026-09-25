// -----------------------------------------------------------------------------
// Stock detail — the full story of one stock on its own page (replaces the
// old in-table accordion; mobile-first). Layout, top to bottom:
//   header (symbol · name · sector · cap · held badge · screener link)
//   hero (price + week trend + signal + funda score + key chips)
//   price chart (embedded TradingView widget + key ₹ levels line)
//   technical read (DMA envelope · 52-week range · ATH · rally) as cards
//   strategy verdicts (each engine's reasons)
//   fundamental panel (11 checks, ratios, latest-Q vs ATH)
//   my positions (Trading Journal lots for this stock)
// Works for any symbol with a snapshot — reachable from every pool table row.
// -----------------------------------------------------------------------------
import { useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ScanResult, Stock } from "../lib/api";
import {
  useScanResultsForSymbols,
  useSnapshotsBySymbols,
  useStock,
} from "../hooks/usePlutus";
import { journalApi } from "../lib/journalApi";
import {
  athFallThreshold,
  buildRows,
  num,
  passesAthRule,
  isLenderGroup,
  type StockRow,
} from "../lib/rows";
import LoadError from "../components/LoadError";
import ScoreRing from "../components/ScoreRing";
import SignalBadge from "../components/SignalBadge";
import StatusPill from "../components/StatusPill";
import StockNotes from "../components/StockNotes";
import StockOpportunities from "../components/StockOpportunities";
import StockPositions from "../components/StockPositions";
import TradingViewChart from "../components/TradingViewChart";
import { fmtCr, fmtDate, fmtMoney, fmtPct } from "../lib/money";

const STRATEGY_ORDER = [
  "envelope_200dma", "week52_high_low", "rally_20_percent", "fundamental_screener",
];
const STRATEGY_NAMES: Record<string, string> = {
  envelope_200dma: "Envelope (200 DMA)",
  week52_high_low: "52-Week High/Low",
  rally_20_percent: "20% Rally",
  fundamental_screener: "Fundamental Score",
};

const CAP_STYLE: Record<string, string> = {
  Large: "bg-sky-50 text-sky-800 ring-1 ring-sky-200",
  Mid: "bg-violet-50 text-violet-800 ring-1 ring-violet-200",
  Small: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
  Micro: "bg-stone-100 text-stone-600 ring-1 ring-stone-200",
};

// ---- small building blocks --------------------------------------------------

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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute mb-2">
      {children}
    </div>
  );
}

function TechCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-card px-3.5 py-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs py-0.5">
      <span className="text-brand-mute">{k}</span>
      <span className="font-mono tabular-nums font-semibold text-right">{v}</span>
    </div>
  );
}

/** 52-week low→high band with a marker at the current close. */
function RangeBar({ low, high, close }: {
  low: number | null; high: number | null; close: number | null;
}) {
  if (low === null || high === null || close === null || high <= low) return null;
  const frac = Math.max(0, Math.min(1, (close - low) / (high - low)));
  return (
    <div className="mt-2">
      <div className="relative h-2 rounded-full bg-gradient-to-r from-teal-200 via-amber-200 to-rose-200">
        <span
          className="absolute -top-[3px] w-3.5 h-3.5 rounded-full bg-white ring-2 ring-teal-700 shadow"
          style={{ left: `calc(${(frac * 100).toFixed(1)}% - 7px)` }}
          title={`Close ₹${fmtMoney(close)}`}
        />
      </div>
      <div className="flex justify-between text-[10px] text-brand-mute font-mono tabular-nums mt-1.5">
        <span>₹{fmtMoney(low)}</span>
        <span>₹{fmtMoney(high)}</span>
      </div>
    </div>
  );
}

/**
 * 200 DMA envelope gauge — WHERE the price sits on the discount spectrum:
 *   premium (above DMA) · shallow (0–9% below) · opportunity (9–14%) ·
 *   buy zone (14%+). The marker is today's % below DMA; the ladder under it
 *   turns the zones into actual ₹ entry levels with distance from CMP.
 */
function DmaEnvelope({ row }: { row: StockRow }) {
  const dma = row.dma200;
  const below = row.belowDmaPct;
  const close = row.close;
  if (dma === null || below === null || close === null) {
    return <div className="text-xs text-brand-mute">No 200 DMA yet — needs more price history.</div>;
  }
  const MIN = -20, MAX = 25; // gauge domain in "% below DMA"
  const x = (v: number) =>
    ((Math.max(MIN, Math.min(MAX, v)) - MIN) / (MAX - MIN)) * 100;
  const oppLevel = dma * (1 - 0.09);
  const buyLevel = dma * (1 - 0.14);
  const away = (level: number) => ((level - close) / close) * 100;

  const verdict = below >= 14
    ? { txt: "in the BUY ZONE", cls: "text-teal-700" }
    : below >= 9
      ? { txt: "in the opportunity band", cls: "text-amber-700" }
      : below > 0
        ? { txt: "not deep enough yet", cls: "text-brand-text" }
        : { txt: "trading at a premium", cls: "text-rose-600" };

  return (
    <div>
      <div className="text-xs">
        Price is{" "}
        <b className="font-mono">{Math.abs(below).toFixed(1)}% {below >= 0 ? "below" : "above"}</b>{" "}
        the 200 DMA — <b className={verdict.cls}>{verdict.txt}</b>
      </div>

      {/* zone spectrum with today's marker */}
      <div className="relative mt-3 mb-4">
        <div className="flex h-2.5 rounded-full overflow-hidden">
          <div className="bg-rose-200/80" style={{ width: `${x(0)}%` }} />
          <div className="bg-stone-200" style={{ width: `${x(9) - x(0)}%` }} />
          <div className="bg-amber-300/90" style={{ width: `${x(14) - x(9)}%` }} />
          <div className="bg-teal-500" style={{ width: `${100 - x(14)}%` }} />
        </div>
        <span className="absolute -top-[4px] w-4 h-4 rounded-full bg-white ring-2 ring-brand-text shadow"
              style={{ left: `clamp(0px, calc(${x(below).toFixed(1)}% - 8px), calc(100% - 16px))` }}
              title={`Today: ${below.toFixed(1)}% below DMA`} />
        {/* zone ticks */}
        {[{ v: 0, l: "DMA" }, { v: 9, l: "9%" }, { v: 14, l: "14%" }].map((t) => (
          <span key={t.v}
                className="absolute top-3 text-[8px] text-brand-mute -translate-x-1/2"
                style={{ left: `${x(t.v)}%` }}>
            {t.l}
          </span>
        ))}
      </div>

      {/* ₹ entry ladder */}
      <KV k="200 DMA" v={`₹${fmtMoney(dma)}`} />
      <KV k="Opportunity ≤ ₹" v={
        <span className={below >= 9 ? "text-amber-700" : ""}>
          {fmtMoney(oppLevel)}
          <span className="text-[9px] text-brand-mute font-sans"> ({away(oppLevel) >= 0 ? "+" : ""}{away(oppLevel).toFixed(1)}%)</span>
        </span>} />
      <KV k="Buy zone ≤ ₹" v={
        <span className={below >= 14 ? "text-teal-700" : ""}>
          {fmtMoney(buyLevel)}
          <span className="text-[9px] text-brand-mute font-sans"> ({away(buyLevel) >= 0 ? "+" : ""}{away(buyLevel).toFixed(1)}%)</span>
        </span>} />
    </div>
  );
}

// ---- page -------------------------------------------------------------------

export default function StockDetailPage() {
  const { symbol = "" } = useParams();
  const navigate = useNavigate();
  const plain = symbol.replace(/\.(NS|BO)$/i, "");

  useEffect(() => {
    document.title = `${plain} · BuddyTrader`;
    return () => { document.title = "BuddyTrader"; };
  }, [plain]);

  const snapsQ = useSnapshotsBySymbols(symbol ? [symbol] : []);
  const resultsQ = useScanResultsForSymbols(symbol ? [symbol] : []);
  const stockQ = useStock(symbol);

  const positionsQ = useQuery({
    queryKey: ["journal", "positions"],
    queryFn: journalApi.positions,
    staleTime: 60_000,
    retry: 1, // journal may be absent in prod builds — degrade silently
  });
  const isHeld = (positionsQ.data?.positions ?? []).some((p) => p.symbol === plain);

  const row: StockRow | null = useMemo(() => {
    const snapshots = snapsQ.data?.snapshots ?? [];
    if (!snapshots.length) return null;
    const stockMap = new Map<string, Stock>();
    if (stockQ.data?.stock) stockMap.set(stockQ.data.stock.symbol, stockQ.data.stock);
    const resultMap = new Map<string, ScanResult[]>();
    for (const r of resultsQ.data?.results ?? []) {
      (resultMap.get(r.symbol) ?? resultMap.set(r.symbol, []).get(r.symbol)!).push(r);
    }
    return buildRows(snapshots, stockMap, resultMap)[0] ?? null;
  }, [snapsQ.data, stockQ.data, resultsQ.data]);

  const loading = snapsQ.isLoading || resultsQ.isLoading;
  if (loading || snapsQ.error || !row) {
    return (
      <div className="space-y-4">
        <BackButton onClick={() => backNav(navigate)} />
        <LoadError
          loading={loading}
          error={snapsQ.error}
          empty={!loading && !snapsQ.error && !row}
          emptyLabel={`No snapshot for ${plain} yet — run a sync, or check the symbol.`}
        />
      </div>
    );
  }

  const s = row.snapshot;
  const stock = stockQ.data?.stock;
  const ordered = [...row.results].sort(
    (a, b) => STRATEGY_ORDER.indexOf(a.strategy_id) - STRATEGY_ORDER.indexOf(b.strategy_id));
  const funda = row.funda;
  const d = funda?.data ?? {};
  const notScored = funda !== null && funda.unknown >= funda.pointsMax;
  // Banks / NBFC are scored on ROA + NPAs, not Net D/E / ROCE / Sales.
  const lender = isLenderGroup(funda?.group);

  // Full-site links use NSE; the EMBED uses BSE because NSE licensing blocks
  // its data inside third-party TradingView widgets ("only available on
  // TradingView"), while BSE quotes render fine and tickers share codes.
  const tvSymbol = `${/\.BO$/i.test(row.symbol) ? "BSE" : "NSE"}:${plain}`;
  const tvEmbedSymbol = `BSE:${plain}`;
  const fromHigh = num(s.distance_from_52w_high_pct);

  return (
    <div className="space-y-5 pb-16">
      {/* ── Header ── */}
      <div>
        <BackButton onClick={() => backNav(navigate)} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
          <h1 className="font-display text-3xl font-bold tracking-tight">{plain}</h1>
          {row.cap && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${CAP_STYLE[row.cap] ?? "bg-stone-100 text-stone-600"}`}>
              {row.cap} cap
            </span>
          )}
          {isHeld && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-teal-50 text-teal-800 ring-1 ring-teal-200"
                  title="Open position in your Trading Journal">
              💼 Holding
            </span>
          )}
          <a
            href={`https://www.screener.in/company/${plain}/consolidated/`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-brand-panel ring-1 ring-brand-border text-brand-accent hover:bg-teal-50 hover:ring-teal-300 transition-colors"
          >
            screener.in <span className="text-[10px]">↗</span>
          </a>
        </div>
        <div className="text-[11px] text-brand-mute mt-0.5">
          {stock?.name ?? "—"} · {row.sector ?? "—"}
          {stock?.pools?.length ? <> · pools: {stock.pools.join(", ")}</> : null}
          {" "}· snapshot {fmtDate(s.snapshot_date)}
        </div>
      </div>

      {/* ── Hero ── */}
      <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-brand-mute">Close</div>
            <div className="font-mono tabular-nums text-3xl font-bold">
              ₹{fmtMoney(row.close)}
            </div>
            {row.trendPct !== null && (
              <div className={`text-xs font-semibold mt-0.5 ${
                row.trendPct > 0 ? "text-teal-700" : row.trendPct < 0 ? "text-rose-600" : "text-brand-mute"}`}>
                {row.trendPct > 0 ? "▲" : row.trendPct < 0 ? "▼" : "▶"}{" "}
                {row.trendPct > 0 ? "+" : ""}{row.trendPct.toFixed(2)}% this week
              </div>
            )}
          </div>
          <div className="flex items-center gap-6 ml-auto pr-2">
            <div className="text-center">
              <SignalBadge status={row.bestStatus} />
              <div className="text-[9px] uppercase tracking-wider text-brand-mute mt-1.5">Signal</div>
            </div>
            <div className="text-center">
              <ScoreRing points={notScored ? null : row.score} size={44} />
              <div className="text-[9px] uppercase tracking-wider text-brand-mute mt-1">Funda /11</div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-3.5 pt-3.5 border-t border-brand-border/60">
          <Chip label="Open" value={fmtMoney(s.open)} />
          <Chip label="High" value={fmtMoney(s.high)} />
          <Chip label="Low" value={fmtMoney(s.low)} />
          <Chip label="MCap" value={fmtCr(s.market_cap as string)} />
          <Chip label="PE" value={row.pe?.toFixed(1) ?? "—"} />
          <Chip label="PB" value={row.pb?.toFixed(2) ?? "—"} />
        </div>
      </div>

      {/* ── Chart (TradingView embed — full history lives there) ── */}
      <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <SectionTitle>Price chart</SectionTitle>
          <a
            href={`https://in.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto -mt-1.5 inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-md bg-brand-soft ring-1 ring-brand-border text-brand-accent hover:bg-teal-50 hover:ring-teal-300 transition-colors"
            title="Open the full chart on TradingView"
          >
            📊 Open on TradingView <span className="text-[9px]">↗</span>
          </a>
        </div>
        <TradingViewChart tvSymbol={tvEmbedSymbol} />
        {row.dma200 !== null && (
          <div className="mt-2 text-[10px] text-brand-mute">
            Key levels — 200 DMA <b className="font-mono text-brand-text">₹{fmtMoney(row.dma200)}</b>
            {" "}· DMA buy zone <b className="font-mono text-sky-800">≤ ₹{fmtMoney(row.dma200 * (1 - 0.14))}</b>
            {row.hasRally && row.rallyLow !== null && (
              <> · rally re-entry <b className="font-mono text-teal-800">₹{fmtMoney(row.rallyLow)}</b></>
            )}
            {row.hasRally && row.rallyHigh !== null && (
              <> · rally exit <b className="font-mono text-rose-700">₹{fmtMoney(row.rallyHigh)}</b></>
            )}
          </div>
        )}
      </div>

      {/* ── Technical read ── */}
      <div>
        <SectionTitle>Technical read</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TechCard title="200 DMA envelope">
            <DmaEnvelope row={row} />
          </TechCard>

          <TechCard title="52-week range">
            <KV k="From low" v={
              <span className={row.fromLowPct !== null && row.fromLowPct <= 5
                ? "text-teal-700" : ""}>{fmtPct(row.fromLowPct, 1)}</span>} />
            <KV k="From high" v={fmtPct(fromHigh, 1)} />
            <RangeBar low={row.low52w} high={row.high52w} close={row.close} />
          </TechCard>

          <TechCard title="All-time high">
            {(() => {
              const t = athFallThreshold(row.cap);
              const pass = passesAthRule(row);
              const v = row.downFromAthPct;
              return (
                <>
                  <KV k="ATH (adjusted)" v={`₹${fmtMoney(row.ath)}`} />
                  <KV k="Down from ATH" v={
                    <span className={pass ? "text-teal-700"
                      : v !== null && v >= t - 10 ? "text-amber-700" : ""}>
                      {fmtPct(v, 1)}
                    </span>} />
                  <KV k={`Rule (${row.cap ?? "Mid"} cap)`} v={`> ${t}%`} />
                  {pass !== null && (
                    <div className={`mt-2 text-[10px] font-bold px-2 py-1 rounded-md ring-1 inline-block ${
                      pass
                        ? "bg-teal-50 text-teal-800 ring-teal-200"
                        : "bg-brand-soft text-brand-mute ring-brand-border"}`}>
                      {pass
                        ? "✓ Deep-value zone — clears its cap's fall rule"
                        : `${(t - (v ?? 0)).toFixed(1)}% more fall to clear the rule`}
                    </div>
                  )}
                  <div className="text-[10px] text-brand-mute mt-2">
                    Fall-from-ATH rule: Large &gt;20% · Mid &gt;30% · Small/Micro &gt;40%
                  </div>
                </>
              );
            })()}
          </TechCard>

          <TechCard title="20% rally streak">
            {row.hasRally ? (
              <>
                <KV k="Last streak" v={row.rallyPct !== null && row.rallyPct > 0
                  ? <span className="text-sky-700">{row.rallyPct.toFixed(1)}%</span> : "—"} />
                <KV k="Ended" v={row.daysSinceRally !== null ? `${row.daysSinceRally}d ago` : "—"} />
                <KV k="To next buy" v={row.pctToNextBuy !== null
                  ? <span className={row.pctToNextBuy <= 0 ? "text-teal-700"
                      : row.pctToNextBuy <= 10 ? "text-amber-700" : ""}>
                      {row.pctToNextBuy > 0 ? "+" : ""}{row.pctToNextBuy.toFixed(1)}%
                    </span> : "—"} />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <span className="text-[10px] font-mono font-bold px-2 py-1 rounded-md bg-teal-50 text-teal-800 ring-1 ring-teal-200">
                    📥 Buy ₹{fmtMoney(row.rallyLow)}
                  </span>
                  <span className="text-[10px] font-mono font-bold px-2 py-1 rounded-md bg-rose-50 text-rose-700 ring-1 ring-rose-200">
                    📤 Sell ₹{fmtMoney(row.rallyHigh)}
                  </span>
                </div>
              </>
            ) : (
              <div className="text-xs text-brand-mute">
                No qualifying 20%+ green streak in the lookback window.
              </div>
            )}
          </TechCard>
        </div>
      </div>

      {/* ── Strategy verdicts ── */}
      <div>
        <SectionTitle>Strategy verdicts</SectionTitle>
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
            </div>
          ))}
          {ordered.filter((r) => r.strategy_id !== "fundamental_screener").length === 0 && (
            <div className="text-xs text-brand-mute">
              No scan results yet — verdicts appear after the next pool scan.
            </div>
          )}
        </div>
      </div>

      {/* ── Fundamental panel ── */}
      <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3.5">
        <div className="flex items-center gap-3 mb-2.5">
          <ScoreRing points={notScored ? null : funda?.points ?? null} size={40} />
          <div className="flex-1">
            <SectionTitle>
              Fundamental details{lender ? ` · ${funda?.group} list` : ""}
            </SectionTitle>
            {funda && !notScored ? (
              <div className="text-xs -mt-1">
                <b>{funda.points}/{funda.pointsMax}</b> checks pass
                {funda.unknown > 0 && (
                  <span className="text-brand-mute"> · {funda.unknown} N/A</span>
                )}
              </div>
            ) : (
              <div className="text-xs text-brand-mute -mt-1">
                Not scored — fundamentals fetch on the next daily sync
                (or use Fetch now in Play Area)
              </div>
            )}
          </div>
        </div>

        {funda && (
          <>
            <div className="flex flex-wrap gap-1.5 pb-2.5 mb-2.5 border-b border-brand-border">
              <Chip label="PE" value={fmt1(d.current_pe)} />
              <Chip label="5yr Avg PE" value={fmt1(d.pe_5yr_avg)} />
              <Chip label="PB" value={fmt1(d.current_pb, 2)} />
              <Chip label="5yr Avg PB" value={fmt1(d.pb_5yr_avg, 2)} />
              {lender ? (
                <>
                  <Chip label="ROE" value={fmt1(d.roe)} unit="%" />
                  <Chip label="ROA" value={fmt1(d.roa, 2)} unit="%" />
                  <Chip label="Gross NPA" value={fmt1(d.gross_npa, 2)} unit="%" />
                  <Chip label="Net NPA" value={fmt1(d.net_npa, 2)} unit="%" />
                </>
              ) : (
                <>
                  <Chip label="ROCE" value={fmt1(d.roce)} unit="%" />
                  <Chip label="ROE" value={fmt1(d.roe)} unit="%" />
                  <Chip label="ND/Eq" value={fmt1(d.net_debt_to_equity, 2)} />
                </>
              )}
              <Chip label="Pledging" value={fmt1(d.pledging)} unit="%" />
              <Chip label="Promoter" value={fmt1(d.promoter_holding)} unit="%" />
            </div>

            <div className="flex flex-wrap gap-2 mb-2.5 text-[10px] text-brand-mute">
              <span className="bg-brand-soft ring-1 ring-brand-border rounded-md px-2 py-1">
                Latest Q {lender ? "Revenue" : "Sales"} <b className="text-brand-text font-mono">{fmtCrShort(d.latest_sales)}</b>
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
              {lender && d.ttm_profit != null && (
                <span className="bg-brand-soft ring-1 ring-brand-border rounded-md px-2 py-1">
                  TTM Net Profit <b className="text-brand-text font-mono">{fmtCrShort(d.ttm_profit)}</b>
                </span>
              )}
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

      {/* ── My notes (dated views — quarters/months/years) ── */}
      <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3.5">
        <StockNotes symbol={plain} />
      </div>

      {/* ── My opportunities (Trading Journal plans for this stock) ── */}
      <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3.5">
        <StockOpportunities symbol={plain} row={row} />
      </div>

      {/* ── My positions ── */}
      <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3.5">
        <SectionTitle>My positions {isHeld ? "💼" : ""}</SectionTitle>
        <StockPositions symbol={row.symbol} cmp={row.close} snapshot={row.snapshot} />
      </div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-brand-panel ring-1 ring-brand-border text-brand-mute hover:text-brand-text shadow-card transition-colors">
      ← Back
    </button>
  );
}

function backNav(navigate: ReturnType<typeof useNavigate>) {
  // Direct links (shared URL, refresh) have no in-app history — go to pools.
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  if (idx > 0) navigate(-1);
  else navigate("/pools");
}
