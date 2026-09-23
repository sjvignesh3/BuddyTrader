import { NavLink } from "react-router-dom";

const POOLS = [
  { code: "F40", name: "Flagship 40" },
  { code: "E40", name: "Emerging 40" },
  { code: "S200", name: "Smartpick 200" },
  { code: "PlayArea", name: "Play Area" },
];

export default function PoolTabs({ active }: { active: string }) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-card p-1 gap-0.5">
      {POOLS.map((p) => (
        <NavLink
          key={p.code}
          to={`/pools/${p.code}`}
          className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold whitespace-nowrap transition-colors ${
            active === p.code
              ? "bg-teal-700 text-white shadow-card"
              : "text-brand-mute hover:text-brand-text hover:bg-brand-soft"
          }`}
        >
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
  );
}
