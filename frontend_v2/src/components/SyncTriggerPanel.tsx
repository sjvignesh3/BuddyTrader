// -----------------------------------------------------------------------------
// On-demand sync triggers — Sync tab panel.
//
// Buttons dispatch the SAME GitHub Actions workflows the scheduler runs
// (daily price+scan, quarterly fundamentals, weekly valuation ratios),
// scoped to a pool chip. The API proxies the dispatch so the GitHub PAT
// stays server-side; the per-browser admin token only rides along as a
// header. Selecting the PlayArea pool also sends this browser's watchlist
// symbols so brand-new additions are fetched too.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SyncWorkflow, TriggerResult, WorkflowRun } from "../lib/api";
import { api } from "../lib/api";
import { loadAdminToken, saveAdminToken } from "../lib/adminToken";
import { loadPlayArea } from "../lib/playarea";

const POOL_ORDER = ["ALL", "F40", "E40", "S200", "PlayArea"];

function runChip(run: WorkflowRun | undefined) {
  if (!run) return null;
  const active = run.status !== "completed";
  const ok = run.conclusion === "success";
  const cls = active
    ? "bg-sky-50 ring-sky-200 text-sky-800"
    : ok
      ? "bg-emerald-50 ring-emerald-200 text-emerald-800"
      : "bg-rose-50 ring-rose-200 text-rose-700";
  const label = active ? run.status.replace("_", " ") : (run.conclusion ?? "done");
  return (
    <a
      href={run.html_url}
      target="_blank"
      rel="noreferrer"
      title={`Run #${run.run_number} · ${new Date(run.created_at).toLocaleString()}`}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold ring-1 ${cls}`}
    >
      {active && <span className="animate-pulse">●</span>}
      last run: {label} ↗
    </a>
  );
}

function TriggerButton({
  label,
  hint,
  workflow,
  pool,
  token,
  canRun,
  onDone,
}: {
  label: string;
  hint: string;
  workflow: SyncWorkflow;
  pool: string;
  token: string;
  canRun: boolean;
  onDone: (r: TriggerResult | Error) => void;
}) {
  const runsQ = useQuery({
    queryKey: ["workflow_runs", workflow],
    queryFn: () => api.workflowRuns(workflow, token),
    enabled: canRun,
    refetchInterval: (q) => {
      const latest = q.state.data?.runs?.[0];
      return latest && latest.status !== "completed" ? 15_000 : false;
    },
  });

  const m = useMutation({
    mutationFn: () => {
      const body: Parameters<typeof api.triggerSync>[0] = { workflow };
      if (pool !== "ALL") body.pool = pool;
      if (pool === "PlayArea") {
        const watchlist = loadPlayArea();
        if (watchlist.length) body.symbols = watchlist;
      }
      return api.triggerSync(body, token);
    },
    onSuccess: (r) => {
      onDone(r);
      // GitHub takes a few seconds to materialise the dispatched run.
      setTimeout(() => runsQ.refetch(), 4_000);
    },
    onError: (e) => onDone(e as Error),
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => m.mutate()}
        disabled={!canRun || m.isPending}
        className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-brand-accent text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {m.isPending ? "Queueing…" : label}
      </button>
      <span className="text-[11px] text-brand-mute">{hint}</span>
      {runChip(runsQ.data?.runs?.[0])}
    </div>
  );
}

export default function SyncTriggerPanel() {
  const statusQ = useQuery({
    queryKey: ["trigger_status"],
    queryFn: api.triggerStatus,
    retry: false,
    staleTime: 5 * 60_000,
  });

  // `token` is the saved/active secret (sent as a header); `draft` is the
  // input's live value — kept separate so the field doesn't unmount on the
  // first keystroke (visibility depends on the SAVED token only).
  const [token, setToken] = useState(loadAdminToken);
  const [draft, setDraft] = useState(token);
  const [editingToken, setEditingToken] = useState(false);
  const [note, setNote] = useState<{ text: string; url?: string; err?: boolean } | null>(null);
  const [pool, setPool] = useState("ALL");

  const status = statusQ.data;
  const pools = useMemo(() => {
    const fromApi = new Set(status?.pools ?? []);
    return POOL_ORDER.filter((p) => p === "ALL" || fromApi.size === 0 || fromApi.has(p));
  }, [status]);

  // Older deployed API without the trigger routes → hide the panel quietly.
  if (statusQ.isError) return null;
  if (!status) return null;

  const needsToken = status.auth_required && !token;
  const canRun = status.configured && !needsToken;
  const watchlistCount = pool === "PlayArea" ? loadPlayArea().length : 0;

  const onDone = (r: TriggerResult | Error) => {
    if (r instanceof Error) {
      setNote({ text: r.message, err: true });
    } else {
      setNote({
        text: `Queued ${r.file} (${Object.entries(r.inputs).map(([k, v]) => `${k}=${v}`).join(", ") || "all pools"}) — ${r.note}.`,
        url: r.runs_url,
      });
    }
  };

  return (
    <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3.5 space-y-3 mb-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display font-semibold text-sm">▶ On-demand sync</span>
        <span className="text-[11px] text-brand-mute">
          runs the scheduled GitHub Actions workflows now — the scheduler stays untouched
        </span>
        {status.auth_required && (
          <button
            onClick={() => setEditingToken((v) => !v)}
            className="ml-auto text-[11px] px-2.5 py-1 rounded-lg ring-1 ring-brand-border bg-brand-soft hover:text-brand-text text-brand-mute"
          >
            {token ? "Admin token ✓" : "Set admin token"}
          </button>
        )}
      </div>

      {!status.configured && (
        <div className="text-[11px] text-amber-800 bg-amber-50 ring-1 ring-amber-200 rounded-lg px-3 py-1.5">
          The API is not configured for triggering yet — set{" "}
          <code>PLUTUS_GITHUB_TOKEN</code> and <code>PLUTUS_GITHUB_REPO</code> on the
          backend service.
        </div>
      )}

      {(editingToken || needsToken) && status.auth_required && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Admin token (PLUTUS_ADMIN_TOKEN)"
            className="bg-brand-soft ring-1 ring-brand-border rounded-xl px-3.5 py-2 text-sm w-72 max-w-full focus:ring-2 focus:ring-brand-accent/40 outline-none placeholder:text-brand-mute"
          />
          <button
            onClick={() => {
              const t = draft.trim();
              saveAdminToken(t);
              setToken(t);
              setDraft(t);
              setEditingToken(false);
            }}
            className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-brand-accent text-white hover:opacity-90"
          >
            Save
          </button>
          <span className="text-[11px] text-brand-mute">
            saved in this browser only — never in the repo
          </span>
        </div>
      )}

      {/* Pool scope */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-brand-mute mr-1">Scope:</span>
        {pools.map((p) => (
          <button
            key={p}
            onClick={() => setPool(p)}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold ring-1 transition-colors ${
              pool === p
                ? "bg-teal-700 text-white ring-teal-700"
                : "bg-brand-soft ring-brand-border text-brand-mute hover:text-brand-text"
            }`}
          >
            {p === "PlayArea" ? "⚡ PlayArea" : p}
          </button>
        ))}
        {pool === "PlayArea" && (
          <span className="text-[10px] text-brand-mute">
            {watchlistCount > 0
              ? `includes the ${watchlistCount} watchlist symbol${watchlistCount === 1 ? "" : "s"} saved in this browser`
              : "no watchlist symbols in this browser — uses the DB PlayArea pool"}
          </span>
        )}
      </div>

      {/* Trigger groups */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="rounded-xl ring-1 ring-brand-border bg-brand-soft/60 px-3 py-2.5 space-y-2">
          <div className="text-xs font-bold uppercase tracking-wide text-brand-mute">
            Technical
          </div>
          <TriggerButton
            label="Run price sync + scan"
            hint="OHLCV, snapshots, then strategy scan (daily workflow)"
            workflow="daily"
            pool={pool}
            token={token}
            canRun={canRun}
            onDone={onDone}
          />
        </div>
        <div className="rounded-xl ring-1 ring-brand-border bg-brand-soft/60 px-3 py-2.5 space-y-2">
          <div className="text-xs font-bold uppercase tracking-wide text-brand-mute">
            Fundamentals
          </div>
          <TriggerButton
            label="Run quarterly fundamentals"
            hint="Screener.in results, holdings, ROCE/ROE (quarterly workflow)"
            workflow="quarterly"
            pool={pool}
            token={token}
            canRun={canRun}
            onDone={onDone}
          />
          <TriggerButton
            label="Run valuation ratios"
            hint="Screener.in PE / PB / MCap (weekly workflow)"
            workflow="ratios"
            pool={pool}
            token={token}
            canRun={canRun}
            onDone={onDone}
          />
        </div>
      </div>

      {note && (
        <div
          className={`text-[11px] rounded-lg px-3 py-1.5 ring-1 ${
            note.err
              ? "text-rose-700 bg-rose-50 ring-rose-200"
              : "text-brand-mute bg-brand-soft ring-brand-border"
          }`}
        >
          {note.text}{" "}
          {note.url && (
            <a href={note.url} target="_blank" rel="noreferrer" className="underline font-semibold">
              View on GitHub ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}
