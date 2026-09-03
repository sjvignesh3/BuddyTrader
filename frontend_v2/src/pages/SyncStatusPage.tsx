import { useSyncJobs } from "../hooks/usePlutus";
import { useSyncJobsRealtime } from "../hooks/useSyncJobsRealtime";
import LoadError from "../components/LoadError";
import StatusPill from "../components/StatusPill";
import SyncTriggerPanel from "../components/SyncTriggerPanel";
import { fmtDate } from "../lib/money";

export default function SyncStatusPage() {
  const rt = useSyncJobsRealtime();
  const { data, isLoading, error } = useSyncJobs(undefined, { realtime: rt });

  return (
    <div>
      <SyncTriggerPanel />
      <h1 className="text-lg font-semibold mb-4">Sync jobs</h1>
      <LoadError
        loading={isLoading}
        error={error}
        empty={!isLoading && (data?.count ?? 0) === 0}
      />
      {data && data.jobs.length > 0 && (
        <div className="overflow-auto rounded-xl ring-1 ring-brand-border">
          <table className="w-full text-sm">
            <thead className="bg-brand-panel text-brand-mute text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Job</th>
                <th className="text-left px-3 py-2">Started</th>
                <th className="text-left px-3 py-2">Finished</th>
                <th className="text-left px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((j) => (
                <tr key={j.id} className="border-t border-brand-border/50">
                  <td className="px-3 py-2">{j.job_type}</td>
                  <td className="px-3 py-2">{fmtDate(j.started_at)}</td>
                  <td className="px-3 py-2">{fmtDate(j.finished_at ?? null)}</td>
                  <td className="px-3 py-2"><StatusPill status={j.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
