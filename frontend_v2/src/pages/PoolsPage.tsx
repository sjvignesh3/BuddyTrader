import { Link } from "react-router-dom";
import { usePools } from "../hooks/usePlutus";
import LoadError from "../components/LoadError";

export default function PoolsPage() {
  const { data, isLoading, error } = usePools();

  if (isLoading || error || !data) {
    return <LoadError loading={isLoading} error={error} />;
  }

  return (
    <div>
      <h1 className="text-lg font-semibold mb-4">Pools</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.pools.map((p) => (
          <Link
            key={p.code}
            to={`/pools/${p.code}`}
            className="block p-4 rounded-xl bg-brand-panel ring-1 ring-brand-border hover:ring-brand-accent/60 transition"
          >
            <div className="text-xs uppercase tracking-wider text-brand-mute">
              {p.code}
            </div>
            <div className="mt-1 font-semibold">{p.name}</div>
            <p className="mt-2 text-sm text-brand-mute line-clamp-3">
              {p.description || "—"}
            </p>
            <div className="mt-3 flex flex-wrap gap-1">
              {p.strategies?.map((s) => (
                <span
                  key={s}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-brand-bg text-brand-mute ring-1 ring-brand-border"
                >
                  {s}
                </span>
              ))}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
