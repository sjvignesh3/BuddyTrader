// -----------------------------------------------------------------------------
// Console — access control for the toolbench. Owner only.
//
// The owner password is an env var on the API host and is deliberately not
// touchable from here. This page manages the OTHER credential: the view-only
// password you hand to someone else.
//
// Rotate mints a new one and shows it exactly once, because the API stores
// only its hash. That is the safer trade: losing the plaintext costs one
// click, whereas keeping it in the database would leave a live shared
// credential sitting in readable storage.
// -----------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { viewerApi } from "../lib/auth";
import { useAuth } from "../components/AuthGate";
import LoadError from "../components/LoadError";
import { ConfirmDialog, GhostBtn } from "../components/journal/ui";

const QK = ["auth", "viewer"] as const;

export default function ConsolePage() {
  const { canEdit, unlocked } = useAuth();
  const qc = useQueryClient();
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [error, setError] = useState("");

  const stateQ = useQuery({
    queryKey: QK,
    queryFn: viewerApi.state,
    enabled: canEdit,
    staleTime: 0,
  });

  const onErr = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  const mRotate = useMutation({
    mutationFn: viewerApi.rotate,
    onSuccess: (r) => {
      setError("");
      setFresh(r.password);
      setCopied(false);
      setConfirmRotate(false);
      qc.invalidateQueries({ queryKey: QK });
    },
    onError: onErr,
  });

  const mDisable = useMutation({
    mutationFn: viewerApi.disable,
    onSuccess: () => {
      setError("");
      setFresh(null);
      setConfirmDisable(false);
      qc.invalidateQueries({ queryKey: QK });
    },
    onError: onErr,
  });

  // The one-time password must not linger on screen after you leave.
  useEffect(() => () => setFresh(null), []);

  async function copy() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Clipboard blocked — select the password and copy it manually.");
    }
  }

  if (!unlocked) return null;          // RequireAuth is already showing the lock
  if (!canEdit) {
    return (
      <div className="max-w-lg mx-auto mt-10 p-6 rounded-2xl bg-brand-panel
                      ring-1 ring-brand-border shadow-card text-center">
        <div className="text-2xl" aria-hidden>🔒</div>
        <h1 className="mt-2 font-display text-xl font-bold">Owner only</h1>
        <p className="mt-1.5 text-sm text-brand-mute">
          Access control is managed by the account owner.
        </p>
      </div>
    );
  }

  const state = stateQ.data;

  return (
    <div className="max-w-2xl">
      <div className="mt-1 mb-5">
        <h1 className="font-display text-2xl font-bold tracking-tight">Console</h1>
        <p className="text-sm text-brand-mute">
          Who can get into your tools, and what they can do once they are in.
        </p>
      </div>

      {error && (
        <div role="alert" className="mb-4 px-3.5 py-2.5 rounded-xl text-sm
                                     text-brand-danger bg-rose-50 ring-1 ring-rose-200">
          {error}
        </div>
      )}

      {/* ---- View-only access ---------------------------------------------- */}
      <section className="p-5 sm:p-6 rounded-2xl bg-brand-panel ring-1 ring-brand-border
                          shadow-card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-semibold">View-only access</h2>
            <p className="mt-1 text-sm text-brand-mute max-w-md">
              A separate password you can share. It opens every tool and can
              sort, filter and export — but it cannot add, edit or delete
              anything.
            </p>
          </div>
          <StatusChip enabled={state?.enabled} loading={stateQ.isLoading} />
        </div>

        {stateQ.error ? (
          <LoadError loading={false} error={stateQ.error} />
        ) : (
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div className="p-3 rounded-xl bg-brand-soft ring-1 ring-brand-border">
              <dt className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
                Live password
              </dt>
              <dd className="mt-0.5 font-mono tabular-nums">
                {state?.enabled ? `${state.hint}…` : "—"}
              </dd>
            </div>
            <div className="p-3 rounded-xl bg-brand-soft ring-1 ring-brand-border">
              <dt className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
                Last rotated
              </dt>
              <dd className="mt-0.5">
                {state?.rotated_at
                  ? new Date(state.rotated_at).toLocaleString()
                  : "Never"}
              </dd>
            </div>
          </dl>
        )}

        {/* The freshly minted password — shown once, never retrievable. */}
        {fresh && (
          <div className="mt-4 p-4 rounded-xl bg-teal-50 ring-1 ring-teal-200">
            <div className="text-[11px] font-bold uppercase tracking-wider text-teal-900">
              New view-only password — copy it now
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="flex-1 min-w-[12rem] px-3 py-2.5 rounded-lg bg-white
                               ring-1 ring-teal-200 font-mono text-base tracking-wider
                               select-all break-all">
                {fresh}
              </code>
              <button
                type="button"
                onClick={copy}
                className="px-3.5 py-2.5 rounded-lg bg-teal-700 text-white text-sm
                           font-semibold hover:bg-teal-800 shadow-card">
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>
            <p className="mt-2 text-xs text-teal-900/80">
              This is the only time it is shown — Plutus stores only a hash of
              it. If you lose it, rotate again.
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={mRotate.isPending}
            onClick={() => (state?.enabled ? setConfirmRotate(true) : mRotate.mutate())}
            className="px-4 py-2 rounded-xl bg-teal-700 text-white text-sm font-semibold
                       hover:bg-teal-800 shadow-card disabled:opacity-50">
            {mRotate.isPending
              ? "Generating…"
              : state?.enabled
                ? "🔄 Rotate password"
                : "＋ Create view-only password"}
          </button>
          {state?.enabled && (
            <GhostBtn onClick={() => setConfirmDisable(true)}
                      disabled={mDisable.isPending}>
              Turn off view-only access
            </GhostBtn>
          )}
        </div>

        <p className="mt-3 text-xs text-brand-mute">
          Rotating or turning this off signs out everyone using the old
          password immediately.
        </p>
      </section>

      {/* ---- Owner credential ----------------------------------------------- */}
      <section className="mt-4 p-5 sm:p-6 rounded-2xl bg-brand-soft ring-1 ring-brand-border">
        <h2 className="font-display text-lg font-semibold">Your own password</h2>
        <p className="mt-1 text-sm text-brand-mute max-w-lg">
          The owner password lives in the{" "}
          <code className="font-mono text-xs px-1 py-0.5 rounded bg-brand-panel
                           ring-1 ring-brand-border">PLUTUS_APP_PASSWORD</code>{" "}
          environment variable on the API host — deliberately not editable
          from the browser, so nothing reachable from the internet can change
          the key to everything. Change it there and every session, yours
          included, signs out.
        </p>
      </section>

      {confirmRotate && (
        <ConfirmDialog
          title="Rotate the view-only password?"
          message={"Anyone currently using the old password will be signed out "
                   + "immediately and will need the new one.\n\nThe new password "
                   + "is shown only once."}
          confirmLabel="Rotate"
          onConfirm={() => mRotate.mutate()}
          onCancel={() => setConfirmRotate(false)}
        />
      )}
      {confirmDisable && (
        <ConfirmDialog
          title="Turn off view-only access?"
          message={"The shared password stops working right away and everyone "
                   + "using it is signed out. You can create a new one at any time."}
          confirmLabel="Turn off"
          danger
          onConfirm={() => mDisable.mutate()}
          onCancel={() => setConfirmDisable(false)}
        />
      )}
    </div>
  );
}

function StatusChip({ enabled, loading }: { enabled?: boolean; loading: boolean }) {
  if (loading) {
    return <span className="text-xs text-brand-mute">Checking…</span>;
  }
  return (
    <span className={`shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold
                      uppercase tracking-wider ring-1 ${
      enabled
        ? "bg-teal-50 text-teal-800 ring-teal-200"
        : "bg-brand-soft text-brand-mute ring-brand-border"}`}>
      {enabled ? "On" : "Off"}
    </span>
  );
}
