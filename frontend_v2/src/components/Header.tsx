import { useState } from "react";
import { Link, NavLink } from "react-router-dom";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/pools", label: "Market Analysis" },
  { to: "/journal", label: "Journal" },
  { to: "/expenses", label: "Expenses" },
  { to: "/position-sizer", label: "Sizer" },
  { to: "/net-worth", label: "Net Worth" },
  { to: "/status", label: "Sync" },
];

const linkCls = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
    isActive
      ? "bg-brand-panel text-brand-text ring-1 ring-brand-border shadow-card"
      : "text-brand-mute hover:text-brand-text"
  }`;

const mobileLinkCls = ({ isActive }: { isActive: boolean }) =>
  `block px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
    isActive
      ? "bg-teal-700 text-white shadow-card"
      : "text-brand-text hover:bg-brand-soft"
  }`;

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 border-b border-brand-border bg-brand-bg/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5" onClick={() => setMenuOpen(false)}>
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-teal-700 to-teal-500 grid place-items-center text-white font-display font-bold text-sm shadow-card">
            P
          </div>
          <span className="font-display font-semibold text-lg tracking-tight">Plutus</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden sm:flex items-center gap-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={linkCls}>
              {n.label}
            </NavLink>
          ))}
        </nav>

        {/* Mobile hamburger */}
        <button
          onClick={() => setMenuOpen((o) => !o)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          className="sm:hidden w-9 h-9 grid place-items-center rounded-lg ring-1
                     ring-brand-border bg-brand-panel shadow-card text-brand-text">
          {menuOpen ? (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>

      {/* Mobile menu panel */}
      {menuOpen && (
        <nav className="sm:hidden border-t border-brand-border bg-brand-bg/95 backdrop-blur-md
                        px-3 py-3 space-y-1 shadow-pop">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={mobileLinkCls}
                     onClick={() => setMenuOpen(false)}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      )}
    </header>
  );
}
