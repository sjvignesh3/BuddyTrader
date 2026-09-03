// -----------------------------------------------------------------------------
// Sync status — the on-demand trigger panel plus a card-per-run history of
// sync_jobs. Each card shows WHEN it ran (start time + duration), WHAT scope
// (pool / explicit symbols), WHO triggered it (cron / Sync tab / on-demand /
// CLI — and, for fetch-on-miss children, which parent sync spawned them),
// and the symbol counts. Cards, not a table → no sideways scrolling on mobile.
// -----------------------------------------------------------------------------
import { useState } from "react";
import type { SyncJob } from "../lib/api";
import { useSyncJobs } from "../hooks/usePlutus";
import { useSyncJobsRealtime } from "../hooks/useSyncJobsRealtime";
import LoadError from "../components/LoadError";
import StatusPill from "../components/StatusPill";
import SyncTriggerPanel from "../components/SyncTriggerPanel";
import { fmtDateTime, fmtDuration } from "../lib/money";

const JOB_META: Record<string, { name: string; icon: string; what: string }> = {
  daily_sync: {
    name: "Price sync", icon: "📈",
    what: "OHLCV + snapshots (technical)",
  },
  quarterly_sync: {
    name: "Quarterly fundamentals", icon: "🧾",
    what: "Screener.in results & holdings (fundamental)",
  },
  weekly_ratios: {
    name: "Valuation ratios", icon: "⚖️",
    what: "Screener.in PE / PB / MCap",
  },
};

const TRIGGER_META: Record<string, { label: string; cls: string }> = {
  "cron": {
    label: "⏰ Scheduled",
    cls: "bg-sky-50 text-sky-800 ring-sky-200" },
  "manual-dispatch": {
    label: "🖱️ Manual (Sync tab)",
    cls: "bg-violet-50 text-violet-800 ring-violet-200" },
  "on-demand": {
    label: "⚡ On-demand",
    cls: "bg-amber-50 text-amber-800 ring-amber-200" },
  "cli": {
    label: "💻 Local CLI",
    cls: "bg-stone-100 text-stone-600 ring-stone-200" },
};

interface JobContext {
  trigger?: string;
  via?: string;
  pool?: string;
  symbols?: string[];
  symbols_requested?: number;
}

function contextOf(j: SyncJob): JobContext {
  const ctx = j.payload_json?.context;
  return ctx && typeof ctx === "object" ? (ctx as JobContext) : {};
}

function MetaChip({ children, title, cls }: {
  children: React.ReactNode; title?: string; cls?: string;
}) {
  return (
    <span title={title}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold ring-1 ${
            cls ?? "bg-brand-soft text-brand-mute ring-brand-border"}`}>
      {children}
    </span>
  );
}

function Count({ label, value, tone }: {
  label: string; value: number | null | undefined; tone?: string;
}) {
  return (
    <div className="text-center px-2">
      <div className={`text-sm font-bold font-mono tabular-nums ${tone ?? ""}`}>
        {value ?? "—"}
      </div>
      <div className="text-[9px] uppercase tracking-wider text-brand-mute">{label}</div>
    </div>
  );
}

function JobCard({ job }: { job: SyncJob }) {
  const [showFails, setShowFails] = useState(false);
  const meta = JOB_META[job.job_type] ?? {
    name: job.job_type, icon: "🔄", what: "" };
  const ctx = contextOf(job);
  const trigger = ctx.trigger ? (TRIGGER_META[ctx.trigger] ?? {
    label: ctx.trigger, cls: "bg-stone-100 text-stone-600 ring-stone-200" }) : null;
  const failedMap = (job.payload_json?.failed_symbols ?? {}) as Record<string, string>;
  const failedEntries = Object.entries(failedMap);
  const symbolScope = ctx.symbols?.length
    ? ctx.symbols.map((s) => s.replace(/\.(NS|BO)$/i, "")).join(", ")
    : null;

  return (
    <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3">
      {/* Row 1 — what job + status */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base leading-none">{meta.icon}</span>
        <span className="font-display font-semibold text-sm">{meta.name}</span>
        <span className="hidden sm:inline text-[10px] text-brand-mute">{meta.what}</span>
        <span className="ml-auto"><StatusPill status={job.status} /></span>
      </div>

      {/* Row 2 — when + who + scope */}
      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        <MetaChip title={`Started ${fmtDateTime(job.started_at)} · finished ${fmtDateTime(job.finished_at ?? null)}`}>
          🕒 {fmtDateTime(job.started_at)}
          <b className="text-brand-text">· {fmtDuration(job.started_at, job.finished_at ?? null)}</b>
        </MetaChip>
        {ctx.pool && (
          <MetaChip cls="bg-teal-50 text-teal-800 ring-teal-200"
                    title="Pool scope of this run">
            📦 {ctx.pool === "ALL" ? "All pools" : ctx.pool}
          </MetaChip>
        )}
        {trigger && <MetaChip cls={trigger.cls} title="What started this run">{trigger.label}</MetaChip>}
        {ctx.via && (
          <MetaChip cls="bg-indigo-50 text-indigo-800 ring-indigo-200"
                    title="This run was spawned automatically by another sync">
            ↳ via {ctx.via}
          </MetaChip>
        )}
      </div>

      {/* Explicit symbol scope (on-demand / PlayArea fetches) */}
      {symbolScope && (
        <div className="mt-1.5 text-[10px] text-brand-mute break-words">
          <b className="text-brand-text">{ctx.symbols_requested} symbol{ctx.symbols_requested === 1 ? "" : "s"}:</b>{" "}
          <span className="font-mono">{symbolScope}</span>
          {(ctx.symbols_requested ?? 0) > (ctx.symbols?.length ?? 0) && " …"}
        </div>
      )}

      {/* Row 3 — counts */}
      <div className="flex items-center divide-x divide-brand-border/70 mt-2.5 pt-2.5 border-t border-brand-border/60">
        <Count label="Symbols" value={job.symbols_total} />
        <Count label="OK" value={job.symbols_ok}
               tone={job.symbols_ok ? "text-teal-700" : ""} />
        <Count label="Failed" value={job.symbols_failed}
               tone={job.symbols_failed ? "text-rose-600" : "text-brand-mute"} />
        <Count label={job.job_type === "daily_sync" ? "Snapshots" : "Rows"}
               value={job.snapshots_written} />
        {failedEntries.length > 0 && (
          <button
            onClick={() => setShowFails((v) => !v)}
            className="ml-auto pl-3 text-[10px] font-semibold text-rose-600 hover:underline">
            {showFails ? "Hide failures ▲" : `Failures (${failedEntries.length}) ▼`}
          </button>
        )}
      </div>

      {/* Failed symbols detail */}
      {showFails && failedEntries.length > 0 && (
        <ul className="mt-2 space-y-1 text-[10px] bg-rose-50/60 ring-1 ring-rose-200 rounded-lg px-3 py-2">
          {failedEntries.map(([sym, err]) => (
            <li key={sym} className="break-words">
              <b className="font-mono text-rose-700">{sym}</b>
              <span className="text-brand-mute"> — {String(err)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SyncStatusPage() {
  const rt = useSyncJobsRealtime();
  const { data, isLoading, error } = useSyncJobs(undefined, { realtime: rt });

  return (
    <div>
      <SyncTriggerPanel />
      <div className="flex items-baseline gap-2 mb-3">
        <h1 className="font-display text-lg font-semibold">Sync jobs</h1>
        <span className="text-[11px] text-brand-mute">
          latest first · one row per job type per day
        </span>
      </div>
      <LoadError
        loading={isLoading}
        error={error}
        empty={!isLoading && (data?.count ?? 0) === 0}
      />
      {data && data.jobs.length > 0 && (
        <div className="space-y-3">
          {data.jobs.map((j) => <JobCard key={j.id} job={j} />)}
        </div>
      )}
    </div>
  );
}
