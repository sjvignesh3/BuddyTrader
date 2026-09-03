import { Link } from "react-router-dom";
import { usePools } from "../hooks/usePlutus";
import LoadError from "../components/LoadError";

const ICONS: Record<string, string> = {
  F40: "🏛️", E40: "🌱", S200: "📈", PlayArea: "⚡",
};

export default function PoolsPage() {
  const { data, isLoading, error } = usePools();

  if (isLoading || error || !data) {
    return <LoadError loading={isLoading} error={error} />;
  }

  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight mb-1">Pools</h1>
      <p className="text-sm text-brand-mute mb-5">
        Pick a universe — signals, fundamental scores and comparisons live inside.
      </p>
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
