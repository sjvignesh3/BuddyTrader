import { useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth, signOut } from "./AuthGate";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/pools", label: "Market Analysis" },
  { to: "/journal", label: "Journal" },
  { to: "/expenses", label: "Expenses" },
  { to: "/position-sizer", label: "Sizer" },
  { to: "/net-worth", label: "Net Worth" },
  { to: "/status", label: "Sync" },
  // Access control — nothing a view-only session can act on.
  { to: "/console", label: "Console", ownerOnly: true },
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

/**
 * Lock / sign-in control. The nav links stay visible while locked — they
 * lead to the lock screen, same as the Home cards — so this only has to
 * show the current state and offer the one action that changes it.
 */
function LockControl({ onNavigate }: { onNavigate?: () => void }) {
  const { unlocked, required, role } = useAuth();
  const navigate = useNavigate();

  if (required === false) return null;   // gate not configured (local dev)

  const cls =
    "px-2.5 py-1.5 rounded-lg text-xs font-semibold ring-1 ring-brand-border " +
    "bg-brand-panel shadow-card text-brand-mute hover:text-brand-text transition-colors";

  if (!unlocked) {
    return (
      <Link to="/unlock" className={cls} onClick={onNavigate}>
        🔒 Sign in
      </Link>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {role === "viewer" && (
        <span title="Read-only session"
              className="px-2 py-1 rounded-lg text-[10px] font-bold uppercase
                         tracking-wider bg-brand-soft text-brand-mute
                         ring-1 ring-brand-border">
          👁 View only
        </span>
      )}
      <button
        type="button"
        className={cls}
        onClick={() => {
          signOut();
          onNavigate?.();
          navigate("/");
        }}>
        Lock
      </button>
    </span>
  );
}

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { canEdit } = useAuth();
  const nav = NAV.filter((n) => !n.ownerOnly || canEdit);

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
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={linkCls}>
              {n.label}
            </NavLink>
          ))}
          <span className="ml-2">
            <LockControl />
          </span>
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
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={mobileLinkCls}
                     onClick={() => setMenuOpen(false)}>
              {n.label}
            </NavLink>
          ))}
          <div className="pt-2">
            <LockControl onNavigate={() => setMenuOpen(false)} />
          </div>
        </nav>
      )}
    </header>
  );
}
