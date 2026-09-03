// -----------------------------------------------------------------------------
// Admin token for the on-demand sync trigger — kept per-browser in
// localStorage (same pattern as the PlayArea watchlist). The token is a
// shared secret with the API's PLUTUS_ADMIN_TOKEN env var; the GitHub PAT
// itself never leaves the server. Wrapped reads/writes: blocked storage
// never breaks the page.
// -----------------------------------------------------------------------------

const KEY = "plutus.admin_token.v1";

export function loadAdminToken(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveAdminToken(token: string): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked — the in-memory value still works for this session */
  }
}
