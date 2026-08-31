// -----------------------------------------------------------------------------
// Realtime subscription on `sync_jobs` — Stage 8 hardening.
//
// Replaces the 60 s polling loop in `useSyncJobs`. Behaviour:
//   * If the Supabase client is not configured → returns `enabled: false`
//     so the caller can keep its polling refetchInterval.
//   * Otherwise subscribes to INSERT + UPDATE on `sync_jobs` and calls
//     `queryClient.invalidateQueries(qk.syncJobs())` on every event.
//   * Auto-unsubscribes on unmount.
//   * Errors are logged but never thrown — a broken channel MUST NOT
//     take down the header pill; the fallback polling still runs.
// -----------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase, realtimeEnabled } from "../lib/supabase";
import { qk } from "./usePlutus";

export interface RealtimeStatus {
  enabled: boolean;      // client configured
  connected: boolean;    // channel subscribed OK
  error: string | null;  // last channel error, if any
}

export function useSyncJobsRealtime(): RealtimeStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>({
    enabled: realtimeEnabled,
    connected: false,
    error: null,
  });

  useEffect(() => {
    if (!supabase) return;

    const channel = supabase
      .channel("sync-jobs-pill")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sync_jobs" },
        () => {
          // Invalidate every sync-jobs query variant.
          qc.invalidateQueries({ queryKey: qk.syncJobs() });
        }
      )
      .subscribe((state, err) => {
        if (state === "SUBSCRIBED") {
          setStatus((s) => ({ ...s, connected: true, error: null }));
        } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          setStatus((s) => ({
            ...s,
            connected: false,
            error: err?.message ?? state,
          }));
        } else if (state === "CLOSED") {
          setStatus((s) => ({ ...s, connected: false }));
        }
      });

    return () => {
      supabase.removeChannel(channel).catch(() => {
        /* swallow — teardown must be silent */
      });
    };
  }, [qc]);

  return status;
}
