import { NavLink, useNavigate } from "react-router-dom";
import { usePools } from "../hooks/usePlutus";
import { poolMarket, type Market } from "../lib/market";

// The Indian pools, in their fixed order. Also the fallback while /api/pools
// is loading, so the strip never flickers empty.
const IN_POOLS = [
  { code: "F40", name: "Flagship 40" },
  { code: "E40", name: "Emerging 40" },
  { code: "S200", name: "Smartpick 200" },
  { code: "PlayArea", name: "Play Area" },
];

/**
 * Pool strip for the Market Analysis workspace. When the database holds US
 * pools an IN / US switch appears in front of it and the strip shows the
 * active market's pools; with no US pool it looks exactly as it always did.
 */
export default function PoolTabs({ active }: { active: string }) {
  const navigate = useNavigate();
  const all = usePools().data?.pools ?? [];
  const usPools = all.filter((p) => poolMarket(p) === "US")
    .map((p) => ({ code: p.code, name: p.name }));
  const market: Market = usPools.some((p) => p.code === active) ? "US" : "IN";
  const pools = market === "US" ? usPools : IN_POOLS;

  const tab = (isActive: boolean) =>
    `px-3.5 py-1.5 rounded-lg text-sm font-semibold whitespace-nowrap transition-colors ${
      isActive
        ? "bg-teal-700 text-white shadow-card"
        : "text-brand-mute hover:text-brand-text hover:bg-brand-soft"}`;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 max-w-full">
      {usPools.length > 0 && (
        <div role="radiogroup" aria-label="Market"
             className="inline-flex rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-card p-1 gap-0.5">
          {(["IN", "US"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={market === m}
                    title={m === "IN" ? "Indian pools (NSE / BSE)" : "US pools (NASDAQ / NYSE)"}
                    onClick={() => {
                      if (m !== market) navigate(`/pools/${m === "US" ? usPools[0]!.code : "F40"}`);
                    }}
                    className={tab(market === m)}>
              {m}
            </button>
          ))}
        </div>
      )}
      <div className="inline-flex max-w-full overflow-x-auto rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-card p-1 gap-0.5">
        {pools.map((p) => (
          <NavLink key={p.code} to={`/pools/${p.code}`} className={tab(active === p.code)}>
            {p.code === "PlayArea" ? "⚡ Play Area" : p.code}
            <span className={`hidden lg:inline text-[10px] font-normal ml-1.5 ${
              active === p.code ? "text-teal-100" : "text-brand-mute"}`}>
              {p.code !== "PlayArea" ? p.name : ""}
            </span>
          </NavLink>
        ))}
        <NavLink to="/universe" title="Manage the stocks in each pool"
                 className="px-3.5 py-1.5 rounded-lg text-sm font-semibold whitespace-nowrap text-brand-mute
                            hover:text-brand-text hover:bg-brand-soft border-l border-brand-border ml-0.5">
          🗂️ Universe
        </NavLink>
      </div>
    </div>
  );
}
