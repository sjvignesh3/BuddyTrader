import { NavLink } from "react-router-dom";

const linkCls = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition ${
    isActive
      ? "bg-brand-panel text-brand-text ring-1 ring-brand-border"
      : "text-brand-mute hover:text-brand-text"
  }`;

export default function Header() {
  return (
    <header className="border-b border-brand-border bg-brand-panel/40 backdrop-blur">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-brand-accent" />
          <span className="font-semibold tracking-tight">Plutus</span>
          <span className="text-brand-mute text-xs ml-1">v0.7 · read-only</span>
        </div>
        <nav className="flex items-center gap-1">
          <NavLink to="/pools" className={linkCls}>Pools</NavLink>
          <NavLink to="/status" className={linkCls}>Sync</NavLink>
        </nav>
      </div>
    </header>
  );
}
