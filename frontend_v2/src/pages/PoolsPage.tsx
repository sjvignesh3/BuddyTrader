import { Link } from "react-router-dom";
import { usePools, useStocks } from "../hooks/usePlutus";
import LoadError from "../components/LoadError";

const ICONS: Record<string, string> = {
  F40: "🏛️", E40: "🌱", S200: "📈", PlayArea: "⚡",
};

export default function PoolsPage() {
  const { data, isLoading, error } = usePools();
  const stocksQ = useStocks();

  if (isLoading || error || !data) {
    return <LoadError loading={isLoading} error={error} />;
  }
  const counts = new Map<string, number>();
  for (const s of stocksQ.data?.stocks ?? []) {
    for (const p of s.pools ?? []) counts.set(p, (counts.get(p) ?? 0) + 1);
  }

  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight mb-1">Pools</h1>
      <p className="text-sm text-brand-mute mb-5">
        Pick a universe — signals, fundamental scores and comparisons live inside.
      </p>
      {/* The universe card — the list every pool below is drawn from. */}
      <Link to="/universe"
            className="group block mb-4 p-5 rounded-2xl bg-gradient-to-br from-teal-800 to-teal-600
                       text-white shadow-card hover:shadow-pop transition-shadow">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl">🗂️</span>
          <div className="max-w-xl">
            <div className="font-display font-semibold text-lg">Universe</div>
            <p className="text-sm text-teal-100">
              The single source of truth — the stocks in each pool. Add, edit, import or export
              F40 / E40 / S200 members here; every pool view, scan and journal lookup reads this list.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2 text-[11px] font-semibold">
            {["F40", "E40", "S200"].map((code) => (
              <span key={code} className="px-2 py-1 rounded-lg bg-white/15 ring-1 ring-white/25">
                {code} <span className="font-mono">{counts.get(code) ?? "…"}</span>
              </span>
            ))}
            <span className="opacity-0 group-hover:opacity-100 transition-opacity">Manage →</span>
          </div>
        </div>
      </Link>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {data.pools.map((p) => (
          <Link
            key={p.code}
            to={`/pools/${p.code}`}
            className="group block p-5 rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card hover:shadow-pop transition-shadow"
          >
            <div className="flex items-center justify-between">
              <span className="text-2xl">{ICONS[p.code] ?? "◆"}</span>
              <span className="text-[10px] uppercase tracking-widest text-brand-mute font-semibold">
                {p.code}
                {counts.has(p.code) && (
                  <span className="ml-1.5 font-mono normal-case tracking-normal">· {counts.get(p.code)}</span>
                )}
              </span>
            </div>
            <div className="mt-2.5 font-display font-semibold text-lg">{p.name}</div>
            <p className="mt-1 text-sm text-brand-mute line-clamp-2">
              {p.description || "—"}
            </p>
            <div className="mt-3 text-[11px] font-semibold text-brand-accent opacity-0 group-hover:opacity-100 transition-opacity">
              Open workspace →
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
