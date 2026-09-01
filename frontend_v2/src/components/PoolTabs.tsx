import { NavLink } from "react-router-dom";

const POOLS = [
  { code: "F40", name: "Flagship 40" },
  { code: "E40", name: "Emerging 40" },
  { code: "S200", name: "Smartpick 200" },
  { code: "PlayArea", name: "Play Area" },
];

export default function PoolTabs({ active }: { active: string }) {
  return (
    <div className="inline-flex rounded-lg ring-1 ring-brand-border bg-brand-panel/60 p-1 gap-1">
      {POOLS.map((p) => (
        <NavLink
          key={p.code}
          to={`/pools/${p.code}`}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            active === p.code
              ? "bg-brand-accent/15 text-brand-accent ring-1 ring-brand-accent/30"
              : "text-brand-mute hover:text-brand-text"
          }`}
        >
          {p.code === "PlayArea" ? "⚡ Play Area" : p.code}
          <span className="hidden lg:inline text-[10px] text-brand-mute ml-1.5">
            {p.code !== "PlayArea" ? p.name : ""}
          </span>
        </NavLink>
      ))}
    </div>
  );
}
