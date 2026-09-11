// -----------------------------------------------------------------------------
// The lock in front of the tools.
//
// <RequireAuth> wraps every route except Home. Signed out, it renders the
// lock screen instead of the page — and because the API refuses the same
// requests without the token (plutus/api/auth.py), no personal row is
// fetched behind it either.
// -----------------------------------------------------------------------------
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import {
  getAuthSnapshot,
  refreshAuthRequirement,
  signIn,
  signOut,
  subscribe,
  type AuthState,
} from "../lib/auth";

/** Subscribe a component to the auth store. */
export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, getAuthSnapshot, getAuthSnapshot);
}

/**
 * True when this session may mutate data — false for a view-only session.
 *
 * Use it to hide mutating controls, not to protect data: the API refuses
 * every write verb for viewer tokens regardless of what the UI renders.
 */
export function useCanEdit(): boolean {
  return useAuth().canEdit;
}

export { signOut };

/**
 * Renders its children only for a session that may write. For the mutating
 * controls that aren't a PrimaryBtn or RowBtn — CSV imports, inline add
 * forms, the capital chip, the sync triggers.
 */
export function OwnerOnly({ children }: { children: React.ReactNode }) {
  return useCanEdit() ? <>{children}</> : null;
}

/** Shown once at the top of each tool when the session is view-only. */
export function ReadOnlyBanner() {
  const { canEdit, unlocked } = useAuth();
  if (canEdit || !unlocked) return null;
  return (
    <div className="mb-4 px-3.5 py-2.5 rounded-xl bg-brand-soft ring-1 ring-brand-border
                    text-xs text-brand-mute flex items-center gap-2">
      <span aria-hidden>👁</span>
      <span>
        <span className="font-semibold text-brand-text">View-only access.</span>{" "}
        You can browse, sort and filter everything here — adding, editing and
        deleting are turned off.
      </span>
    </div>
  );
}

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { unlocked, required } = useAuth();

  // One status probe per app load: tells us whether the gate is even on
  // (it is off on a local API with no password set).
  useEffect(() => {
    if (required === null) void refreshAuthRequirement();
  }, [required]);

  if (required === null) {
    return (
      <div className="py-16 text-center text-brand-mute text-sm">Checking access…</div>
    );
  }
  if (!unlocked) return <LockScreen />;
  return <>{children}</>;
}

function LockScreen() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      await signIn(password);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md mx-auto mt-10 sm:mt-16">
      <div className="p-6 sm:p-7 rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-teal-700 to-teal-500
                        grid place-items-center text-xl shadow-card">
          🔒
        </div>
        <h1 className="mt-3.5 font-display text-2xl font-bold tracking-tight">
          This tool is private
        </h1>
        <p className="mt-1.5 text-sm text-brand-mute">
          Your trades, expenses and net worth live behind this password. Home
          stays open to everyone — the tools do not. A view-only password
          works here too, and opens everything in read-only mode.
        </p>

        <form onSubmit={submit} className="mt-5 space-y-3">
          <div>
            <label htmlFor="plutus-password"
                   className="block text-[11px] font-semibold uppercase tracking-wider
                              text-brand-mute mb-1.5">
              Password
            </label>
            <input
              id="plutus-password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="w-full px-3 py-2.5 rounded-xl bg-brand-soft ring-1 ring-brand-border
                         text-sm text-brand-text outline-none focus:ring-2
                         focus:ring-teal-600 disabled:opacity-60"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div role="alert" className="text-sm text-brand-danger">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !password}
            className="w-full py-2.5 rounded-xl bg-teal-700 text-white text-sm font-semibold
                       shadow-card hover:bg-teal-800 transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed">
            {busy ? "Checking…" : "Unlock"}
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-brand-border text-center">
          <Link to="/" className="text-xs font-semibold text-brand-mute hover:text-brand-text">
            ← Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
