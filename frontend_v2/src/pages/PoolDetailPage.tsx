// -----------------------------------------------------------------------------
// Pool workspace — tabs (F40 / E40 / S200 / PlayArea), summary tiles,
// filter toolbar, and the full BuddyTrader column table with the 11-point
// fundamental score. PlayArea is the client-side watchlist: same table,
// symbols chosen by the user, data from the synced universe.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
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
import { buildRows, type StockRow } from "../lib/rows";
import { loadPlayArea, savePlayArea } from "../lib/playarea";
import LoadError from "../components/LoadError";
import PlayAreaManager from "../components/PlayAreaManager";
import PoolTabs from "../components/PoolTabs";
import StockTable, { RALLY_POOLS } from "../components/StockTable";
import { fmtDate } from "../lib/money";

const SIGNAL_FILTERS = ["BUY_ZONE", "OPPORTUNITY", "VALID"] as const;
const CAP_BUCKETS = ["Large", "Mid", "Small", "Micro"] as const;

function Tile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl ring-1 ring-brand-border bg-brand-panel/40 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-brand-mute">{label}</div>
      <div className={`text-xl font-bold font-mono tabular-nums mt-0.5 ${accent ?? ""}`}>
        {value}
      </div>
    </div>
  );
}

export default function PoolDetailPage() {
  const { code = "F40" } = useParams();
  const isPlayArea = code === "PlayArea";

  // ---- PlayArea watchlist (localStorage) --------------------------------
  const [watchlist, setWatchlist] = useState<string[]>(() => loadPlayArea());
  const updateWatchlist = (symbols: string[]) => {
    setWatchlist(symbols);
    savePlayArea(symbols);
  };

  // ---- Data --------------------------------------------------------------
  // Universe (sector map everywhere; suggestion source for PlayArea).
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

  // ---- Row model ----------------------------------------------------------
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

  // ---- Filters -------------------------------------------------------------
  const [search, setSearch] = useState("");
  const [capFilter, setCapFilter] = useState("");
  const [sectorFilter, setSectorFilter] = useState("");
  const [signalFilter, setSignalFilter] = useState("");
  const [minScore, setMinScore] = useState(0);

  const sectors = useMemo(
    () => Array.from(new Set(rows.map((r) => r.sector).filter(Boolean) as string[])).sort(),
    [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return rows.filter((r) => {
      if (q && !r.symbol.toUpperCase().includes(q)) return false;
      if (capFilter && r.cap !== capFilter) return false;
      if (sectorFilter && r.sector !== sectorFilter) return false;
      if (signalFilter && r.bestStatus !== signalFilter) return false;
      if (minScore > 0 && (r.score ?? -1) < minScore) return false;
      return true;
    });
  }, [rows, search, capFilter, sectorFilter, signalFilter, minScore]);

  // ---- Summary tiles --------------------------------------------------------
  const buyCount = rows.filter((r) => r.bestStatus === "BUY_ZONE").length;
  const oppCount = rows.filter((r) => r.bestStatus === "OPPORTUNITY").length;
  const scored = rows.filter((r) => r.score !== null);
  const avgScore = scored.length
    ? (scored.reduce((a, r) => a + (r.score ?? 0), 0) / scored.length).toFixed(1)
    : "—";
  const lastSync = jobs.data?.jobs?.[0];

  const isLoading = snapsQ.isLoading || stocksQ.isLoading;

  return (
    <div className="space-y-4">
      {/* ── Tabs + status line ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PoolTabs active={code} />
        <div className="text-[11px] text-brand-mute">
          Snapshot {fmtDate(snapsQ.data?.snapshot_date ?? null)} · Last sync{" "}
          {lastSync ? `${fmtDate(lastSync.finished_at ?? lastSync.started_at)} (${lastSync.status})` : "—"}
        </div>
      </div>

      {/* ── PlayArea manager ── */}
      {isPlayArea && (
        <PlayAreaManager
          universe={stocksQ.data?.stocks ?? []}
          watchlist={watchlist}
          onChange={updateWatchlist}
        />
      )}

      {/* ── Summary tiles ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label={isPlayArea ? "Watchlist" : "Stocks"} value={String(rows.length)} />
        <Tile label="Buy zone" value={String(buyCount)}
              accent={buyCount > 0 ? "text-emerald-400" : ""} />
        <Tile label="Opportunities" value={String(oppCount)}
              accent={oppCount > 0 ? "text-amber-400" : ""} />
        <Tile label="Avg funda score" value={avgScore === "—" ? "—" : `${avgScore}/11`}
              accent={Number(avgScore) >= 8 ? "text-emerald-400"
                : Number(avgScore) >= 6 ? "text-amber-400" : ""} />
      </div>

      {/* ── Filter toolbar ── */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search symbol…"
          className="bg-brand-panel ring-1 ring-brand-border rounded-md px-3 py-1.5 w-40 focus:ring-brand-accent/50 outline-none"
        />
        <select value={capFilter} onChange={(e) => setCapFilter(e.target.value)}
                className="bg-brand-panel ring-1 ring-brand-border rounded-md px-2 py-1.5">
          <option value="">All caps</option>
          {CAP_BUCKETS.map((c) => <option key={c} value={c}>{c} cap</option>)}
        </select>
        <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}
                className="bg-brand-panel ring-1 ring-brand-border rounded-md px-2 py-1.5 max-w-[170px]">
          <option value="">All sectors</option>
          {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={signalFilter} onChange={(e) => setSignalFilter(e.target.value)}
                className="bg-brand-panel ring-1 ring-brand-border rounded-md px-2 py-1.5">
          <option value="">All signals</option>
          {SIGNAL_FILTERS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="flex items-center gap-2 text-[11px] text-brand-mute pl-1">
          Min score
          <input type="range" min={0} max={11} value={minScore}
                 onChange={(e) => setMinScore(Number(e.target.value))}
                 className="w-24 accent-emerald-500" />
          <span className="font-mono w-8">{minScore > 0 ? `${minScore}+` : "any"}</span>
        </label>
        {(search || capFilter || sectorFilter || signalFilter || minScore > 0) && (
          <button
            onClick={() => { setSearch(""); setCapFilter(""); setSectorFilter(""); setSignalFilter(""); setMinScore(0); }}
            className="text-[11px] text-brand-mute hover:text-brand-text underline underline-offset-2">
            Clear ({filtered.length}/{rows.length})
          </button>
        )}
      </div>

      <LoadError
        loading={isLoading}
        error={snapsQ.error ?? stocksQ.error}
        empty={!isLoading && rows.length === 0 && !isPlayArea}
        emptyLabel="No snapshots for this pool yet — run the daily sync."
      />

      {(rows.length > 0 || (!isLoading && isPlayArea && watchlist.length > 0)) && (
        <StockTable rows={filtered} pool={code} />
      )}
      {RALLY_POOLS.has(code) && rows.length > 0 && (
        <div className="text-[10px] text-brand-mute px-1">
          Rally view — sorted by <b className="text-sky-400">Days Since Streak</b>{" "}
          by default: the most recently completed 20%+ streaks float to the top.
        </div>
      )}
    </div>
  );
}
