import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  useSnapshots,
  useLatestScan,
  useScanResults,
} from "../hooks/usePlutus";
import type { ScanResult } from "../lib/api";
import LoadError from "../components/LoadError";
import StatusPill from "../components/StatusPill";
import { fmtDate, fmtMoney, fmtPct } from "../lib/money";

export default function PoolDetailPage() {
  const { code = "" } = useParams();
  const scan = useLatestScan(code);
  const snaps = useSnapshots(code);
  const [strategy, setStrategy] = useState<string | undefined>(undefined);
  const scanId = scan.data?.scan?.id;
  const results = useScanResults(scanId, strategy);

  const bySymbol = useMemo(() => {
    const m = new Map<string, ScanResult>();
    for (const r of results.data?.results ?? []) m.set(r.symbol, r);
    return m;
  }, [results.data]);

  const rows = snaps.data?.snapshots ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <Link to="/pools" className="text-brand-mute text-xs hover:text-brand-text">
            ← Pools
          </Link>
          <h1 className="text-lg font-semibold mt-1">Pool {code}</h1>
          <div className="text-xs text-brand-mute mt-0.5">
            Snapshot: {fmtDate(snaps.data?.snapshot_date ?? null)} ·
            Scan: {scan.data?.scan ? fmtDate(scan.data.scan.snapshot_date) : "—"}
          </div>
        </div>
        <select
          value={strategy ?? ""}
          onChange={(e) => setStrategy(e.target.value || undefined)}
          className="bg-brand-panel ring-1 ring-brand-border rounded-md px-2 py-1 text-sm"
        >
          <option value="">All strategies</option>
          <option value="envelope">Envelope</option>
          <option value="week52">52W High/Low</option>
          <option value="rally_20_percent">20% Rally</option>
          <option value="fundamental_screener">Fundamentals</option>
        </select>
      </div>

      <LoadError
        loading={snaps.isLoading || scan.isLoading}
        error={snaps.error ?? scan.error}
        empty={!snaps.isLoading && rows.length === 0}
        emptyLabel="No snapshots for this pool yet — run the daily sync."
      />

      {rows.length > 0 && (
        <div className="overflow-auto rounded-xl ring-1 ring-brand-border">
          <table className="w-full text-sm">
            <thead className="bg-brand-panel text-brand-mute text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Symbol</th>
                <th className="text-right px-3 py-2">Close</th>
                <th className="text-right px-3 py-2">200-DMA</th>
                <th className="text-right px-3 py-2">Below 200-DMA</th>
                <th className="text-right px-3 py-2">Dist 52W Low</th>
                <th className="text-left px-3 py-2">Signal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const r = bySymbol.get(s.symbol);
                return (
                  <tr key={s.symbol} className="border-t border-brand-border/50">
                    <td className="px-3 py-2 font-medium">{s.symbol}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(s.close)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-brand-mute">
                      {fmtMoney(s.dma_200 ?? null)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtPct(s.below_200dma_pct ?? null)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtPct(s.distance_from_52w_low_pct ?? null)}
                    </td>
                    <td className="px-3 py-2">
                      {r ? <StatusPill status={r.status} /> : <span className="text-brand-mute">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
