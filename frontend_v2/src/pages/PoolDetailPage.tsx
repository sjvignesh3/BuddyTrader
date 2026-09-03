// -----------------------------------------------------------------------------
// Pool workspace — decision-first layout:
//   tabs → stat strip → Opportunity Radar (ranked best setups) →
//   filter toolbar → the full data table → comparison tray.
// PlayArea adds the watchlist manager with on-demand fetch: a new symbol
// shows as "no data" until /api/admin/sync (local FastAPI) pulls its
// prices + fundamentals; the page polls until the row appears.
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { ScanResult, Stock } from "../lib/api";
import {
  useLatestScan,
  useScanResults,
  useScanResultsForSymbols,
  useSnapshots,
  useSnapshotsBySymbols,
  useStocks,
  useSyncJobs,
} from "../hooks/usePlutus";
import { useQuery } from "@tanstack/react-query";
import { journalApi } from "../lib/journalApi";
import { buildRows, type StockRow } from "../lib/rows";
import { loadPlayArea, savePlayArea } from "../lib/playarea";
import CompareDrawer from "../components/CompareDrawer";
import Dropdown from "../components/Dropdown";
import LoadError from "../components/LoadError";
import OpportunityRadar from "../components/OpportunityRadar";
import PlayAreaManager from "../components/PlayAreaManager";
import PoolTabs from "../components/PoolTabs";
import StockTable, { RALLY_POOLS } from "../components/StockTable";
import { fmtDate } from "../lib/money";

const CAP_BUCKETS = ["Large", "Mid", "Small", "Micro"] as const;
const POOL_TITLES: Record<string, string> = {
  F40: "Flagship 40", E40: "Emerging 40", S200: "Smartpick 200",
  PlayArea: "Play Area",
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-brand-mute">{label}</div>
      <div className={`text-xl font-bold font-mono tabular-nums mt-0.5 ${tone ?? ""}`}>
        {value}
      </div>
    </div>
  );
}

export default function PoolDetailPage() {
  const { code = "F40" } = useParams();
  const isPlayArea = code === "PlayArea";
  const qc = useQueryClient();
  const navigate = useNavigate();

  // ---- PlayArea watchlist -------------------------------------------------
  const [watchlist, setWatchlist] = useState<string[]>(() => loadPlayArea());
  const [fetchingSymbols, setFetchingSymbols] = useState<string[]>([]);
  const updateWatchlist = (symbols: string[]) => {
    setWatchlist(symbols);
    savePlayArea(symbols);
  };

  // ---- Data -----------------------------------------------------------------
  const stocksQ = useStocks(isPlayArea ? undefined : code);
  const jobs = useSyncJobs("daily_sync");
  const poolSnaps = useSnapshots(isPlayArea ? "" : code);
  const watchSnaps = useSnapshotsBySymbols(isPlayArea ? watchlist : []);
  const snapsQ = isPlayArea ? watchSnaps : poolSnaps;
  const scan = useLatestScan(isPlayArea ? "" : code);
  const scanId = scan.data?.scan?.id;
  const poolResults = useScanResults(isPlayArea ? undefined : scanId);
  const watchResults = useScanResultsForSymbols(isPlayArea ? watchlist : []);
  const resultsQ = isPlayArea ? watchResults : poolResults;

  const rows: StockRow[] = useMemo(() => {
    const snapshots = snapsQ.data?.snapshots ?? [];
    const stockMap = new Map<string, Stock>(
      (stocksQ.data?.stocks ?? []).map((s) => [s.symbol, s]));
    const resultMap = new Map<string, ScanResult[]>();
    for (const r of resultsQ.data?.results ?? []) {
      (resultMap.get(r.symbol) ?? resultMap.set(r.symbol, []).get(r.symbol)!).push(r);
    }
    return buildRows(snapshots, stockMap, resultMap);
  }, [snapsQ.data, stocksQ.data, resultsQ.data]);

  // ---- PlayArea: symbols with no data yet + polling while fetching -----------
  const haveData = useMemo(() => new Set(rows.map((r) => r.symbol)), [rows]);
  const pendingSymbols = isPlayArea
    ? watchlist.filter((s) => !haveData.has(s))
    : [];
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    // While an on-demand fetch runs, refresh queries every 5s until every
    // fetching symbol has a row (or 3 minutes pass).
    const stillMissing = fetchingSymbols.filter((s) => !haveData.has(s));
    if (stillMissing.length === 0) {
      if (fetchingSymbols.length) setFetchingSymbols([]);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;
    const startedAt = Date.now();
    pollRef.current = window.setInterval(() => {
      qc.invalidateQueries({ queryKey: ["snapshots_by_symbols"] });
      qc.invalidateQueries({ queryKey: ["scan_results_for_symbols"] });
      if (Date.now() - startedAt > 180_000) {
        setFetchingSymbols([]);
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }
    }, 5000);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [fetchingSymbols, haveData, qc]);

  // ---- Journal positions (💼 indicator + holding filter) -------------------------
  const positionsQ = useQuery({
    queryKey: ["journal", "positions"],
    queryFn: journalApi.positions,
    staleTime: 60_000,
    retry: 1, // journal may be absent in prod builds — degrade silently
  });
  const heldSymbols = useMemo(
    () => new Set((positionsQ.data?.positions ?? []).map((p) => p.symbol)),
    [positionsQ.data]);
  const isHeld = (r: StockRow) =>
    heldSymbols.has(r.symbol.replace(/\.(NS|BO)$/i, ""));

  // ---- Filters ----------------------------------------------------------------
  const [search, setSearch] = useState("");
  const [capFilter, setCapFilter] = useState("");
  const [sectorFilter, setSectorFilter] = useState("");
  const [signalFilter, setSignalFilter] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [holdFilter, setHoldFilter] = useState(""); // "" | "held" | "unheld"

  const sectors = useMemo(
    () => Array.from(new Set(rows.map((r) => r.sector).filter(Boolean) as string[])).sort(),
    [rows]);

  // The holding filter also applies to the Opportunity Radar, so hiding
  // held stocks surfaces fresh opportunities there too.
  const radarRows = useMemo(() => rows.filter((r) => {
    if (holdFilter === "held") return isHeld(r);
    if (holdFilter === "unheld") return !isHeld(r);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [rows, holdFilter, heldSymbols]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return radarRows.filter((r) => {
      if (q && !r.symbol.toUpperCase().includes(q)) return false;
      if (capFilter && r.cap !== capFilter) return false;
      if (sectorFilter && r.sector !== sectorFilter) return false;
      if (signalFilter && r.bestStatus !== signalFilter) return false;
      if (minScore > 0 && (r.score ?? -1) < minScore) return false;
      return true;
    });
  }, [radarRows, search, capFilter, sectorFilter, signalFilter, minScore]);

  // ---- Compare tray ---------------------------------------------------------------
  const [compared, setCompared] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const toggleCompare = (symbol: string) =>
    setCompared((prev) => prev.includes(symbol)
      ? prev.filter((s) => s !== symbol)
      : prev.length >= 4 ? prev : [...prev, symbol]);
  const comparedRows = useMemo(
    () => compared.map((s) => rows.find((r) => r.symbol === s)).filter(Boolean) as StockRow[],
    [compared, rows]);

  // ---- Stats -------------------------------------------------------------------
  const buyCount = rows.filter((r) => r.bestStatus === "BUY_ZONE").length;
  const oppCount = rows.filter((r) => r.bestStatus === "OPPORTUNITY").length;
  const scored = rows.filter((r) => r.score !== null);
  const avgScore = scored.length
    ? (scored.reduce((a, r) => a + (r.score ?? 0), 0) / scored.length).toFixed(1)
    : "—";
  const lastSync = jobs.data?.jobs?.[0];
  const isLoading = snapsQ.isLoading || stocksQ.isLoading;

  return (
    <div className="space-y-5 pb-24">
      {/* ── Title row ── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">
            {POOL_TITLES[code] ?? code}
          </h1>
          <div className="text-[11px] text-brand-mute mt-0.5">
            Snapshot {fmtDate(snapsQ.data?.snapshot_date ?? null)} · Last sync{" "}
            {lastSync ? `${fmtDate(lastSync.finished_at ?? lastSync.started_at)} (${lastSync.status})` : "—"}
          </div>
        </div>
        <PoolTabs active={code} />
      </div>

      {/* ── PlayArea manager ── */}
      {isPlayArea && (
        <PlayAreaManager
          universe={stocksQ.data?.stocks ?? []}
          watchlist={watchlist}
          pendingSymbols={pendingSymbols.filter((s) => !fetchingSymbols.includes(s))}
          fetchingSymbols={fetchingSymbols}
          onChange={updateWatchlist}
          onFetchStarted={(started) =>
            setFetchingSymbols((prev) => Array.from(new Set([...prev, ...started])))}
        />
      )}

      {/* ── Stat strip ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label={isPlayArea ? "Watchlist" : "Stocks"} value={String(rows.length)} />
        <Stat label="Buy zone" value={String(buyCount)}
              tone={buyCount > 0 ? "text-teal-700" : "text-brand-mute"} />
        <Stat label="Opportunities" value={String(oppCount)}
              tone={oppCount > 0 ? "text-amber-700" : "text-brand-mute"} />
        <Stat label="Avg funda score" value={avgScore === "—" ? "—" : `${avgScore}/11`}
              tone={Number(avgScore) >= 8 ? "text-teal-700"
                : Number(avgScore) >= 6 ? "text-amber-700" : ""} />
      </div>

      {/* ── Opportunity radar ── */}
      <OpportunityRadar
        rows={radarRows}
        heldSymbols={heldSymbols}
        compared={compared}
        onToggleCompare={toggleCompare}
        onOpen={(symbol) => navigate(`/stocks/${encodeURIComponent(symbol)}`)}
      />

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search symbol…"
          className="bg-brand-panel ring-1 ring-brand-border rounded-xl px-3.5 py-2 w-44 shadow-card focus:ring-2 focus:ring-brand-accent/40 outline-none placeholder:text-brand-mute"
        />
        <Dropdown value={capFilter} onChange={setCapFilter} placeholder="All caps"
                  options={[{ value: "", label: "All caps" },
                    ...CAP_BUCKETS.map((c) => ({ value: c, label: `${c} cap` }))]} />
        <Dropdown value={sectorFilter} onChange={setSectorFilter} placeholder="All sectors"
                  options={[{ value: "", label: "All sectors" },
                    ...sectors.map((s) => ({ value: s, label: s }))]} />
        <Dropdown value={signalFilter} onChange={setSignalFilter} placeholder="All signals"
                  options={[{ value: "", label: "All signals" },
                    { value: "BUY_ZONE", label: "🟢 Buy zone" },
                    { value: "OPPORTUNITY", label: "🟡 Opportunity" },
                    { value: "VALID", label: "🔵 Valid" }]} />
        <Dropdown value={holdFilter} onChange={setHoldFilter} placeholder="Held + not held"
                  title="Filter by your Trading Journal's open positions — applies to the radar too"
                  options={[
                    { value: "", label: "Held + not held" },
                    { value: "unheld", label: "🔍 Not holding",
                      hint: "hide stocks you already hold" },
                    { value: "held", label: "💼 Holding",
                      hint: "only your open positions" }]} />
        <label className="flex items-center gap-2 text-[11px] text-brand-mute pl-1">
          Min score
          <input type="range" min={0} max={11} value={minScore}
                 onChange={(e) => setMinScore(Number(e.target.value))}
                 className="w-24 accent-teal-700" />
          <span className="font-mono w-8 font-semibold text-brand-text">
            {minScore > 0 ? `${minScore}+` : "any"}
          </span>
        </label>
        {(search || capFilter || sectorFilter || signalFilter || holdFilter || minScore > 0) && (
          <button
            onClick={() => { setSearch(""); setCapFilter(""); setSectorFilter(""); setSignalFilter(""); setHoldFilter(""); setMinScore(0); }}
            className="text-[11px] text-brand-mute hover:text-brand-text underline underline-offset-2">
            Clear ({filtered.length}/{rows.length})
          </button>
        )}
        {compared.length > 0 && (
          <button
            onClick={() => setShowCompare(true)}
            className="ml-auto text-[11px] font-bold px-3.5 py-2 rounded-xl bg-brand-accent text-white shadow-card hover:opacity-90 transition-opacity">
            ⇄ Compare {compared.length}
          </button>
        )}
      </div>

      <LoadError
        loading={isLoading}
        error={snapsQ.error ?? stocksQ.error}
        empty={!isLoading && rows.length === 0 && !isPlayArea}
        emptyLabel="No snapshots for this pool yet — run the daily sync."
      />

      <div id="pool-table" className="scroll-mt-20">
        {(rows.length > 0 || (isPlayArea && watchlist.length > 0)) && (
          <StockTable
            rows={filtered}
            pool={code}
            heldSymbols={heldSymbols}
            compared={compared}
            onToggleCompare={toggleCompare}
          />
        )}
      </div>

      {RALLY_POOLS.has(code) && rows.length > 0 && (
        <div className="text-[10px] text-brand-mute px-1">
          Rally view — sorted by <b className="text-sky-700">Days Since Streak</b>{" "}
          by default: the most recently completed 20%+ streaks float to the top.
        </div>
      )}

      {showCompare && (
        <CompareDrawer
          rows={comparedRows}
          onRemove={(s) => {
            const next = compared.filter((x) => x !== s);
            setCompared(next);
            if (next.length === 0) setShowCompare(false);
          }}
          onClose={() => setShowCompare(false)}
        />
      )}
    </div>
  );
}
