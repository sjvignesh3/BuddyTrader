// -----------------------------------------------------------------------------
// PlayArea watchlist — per-browser convenience list, persisted in
// localStorage (the v1 API is read-only, so PlayArea membership lives
// client-side; every symbol still comes from the synced universe).
// All reads/writes are wrapped — a blocked storage never breaks the page.
// -----------------------------------------------------------------------------

const KEY = "plutus.playarea.v1";

export function loadPlayArea(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function savePlayArea(symbols: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Array.from(new Set(symbols))));
  } catch {
    /* storage blocked — the in-memory list still works for this session */
  }
}
