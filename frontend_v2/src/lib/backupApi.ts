// -----------------------------------------------------------------------------
// One-click personal-data backup (owner only) — GET /api/backup/export.
//
// The API answers with a single ZIP: csv/<table>.csv for reading, plus
// restore/<table>.json + manifest.json for `restore_personal`. We save it
// through a temporary object URL because the request needs the auth header,
// which a plain <a href> download cannot send.
// -----------------------------------------------------------------------------
import { authHeaders, handleUnauthorized } from "./auth";

const BASE = import.meta.env.VITE_PLUTUS_API_URL ?? "";

export interface BackupResult {
  filename: string;
  tables: number;
  rows: number;
  /** Tables the API could not read — the ZIP is incomplete when non-empty. */
  failed: string[];
  bytes: number;
}

function filenameFrom(disposition: string | null): string {
  const m = /filename="?([^";]+)"?/i.exec(disposition ?? "");
  return m?.[1] ?? `plutus-backup-${new Date().toISOString().slice(0, 10)}.zip`;
}

export async function downloadBackup(): Promise<BackupResult> {
  const res = await fetch(`${BASE}/api/backup/export`, {
    headers: { Accept: "application/zip", ...authHeaders() },
  });
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized();
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error ?? j.detail ?? msg;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Backup failed (${res.status}): ${msg}`);
  }
  const blob = await res.blob();
  const filename = filenameFrom(res.headers.get("Content-Disposition"));

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);

  return {
    filename,
    tables: Number(res.headers.get("X-Plutus-Backup-Tables") ?? 0),
    rows: Number(res.headers.get("X-Plutus-Backup-Rows") ?? 0),
    failed: (res.headers.get("X-Plutus-Backup-Errors") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean),
    bytes: blob.size,
  };
}
