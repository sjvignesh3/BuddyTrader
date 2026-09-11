// -----------------------------------------------------------------------------
// Two-role credential gate for the personal tools.
//
// Plutus is deployed on a public URL, so Home is the only page anyone may
// open. Beyond it there are two ways in:
//
//   owner  — full CRUD. Password = PLUTUS_APP_PASSWORD on the API host.
//   viewer — read-only. Password is generated from the Console, shared, and
//            rotatable at any time; rotating kills every viewer session.
//
// One password field handles both: the API decides which role you get. The
// browser stores only the signed token (`<role>.<exp>.<sig>`) — never a
// password.
//
// `canEdit` here hides mutating controls so a viewer isn't clicking buttons
// that would only fail. It is NOT the security boundary: the API refuses
// every write verb for viewer tokens (plutus/api/auth.py), which is what
// actually protects the data.
//
// Exposed as an external store so React can subscribe via useSyncExternalStore
// without a provider having to own the token.
// -----------------------------------------------------------------------------

const BASE = import.meta.env.VITE_PLUTUS_API_URL ?? "";
const KEY = "plutus.auth.v1";

export const AUTH_HEADER = "X-Plutus-Auth";

export type Role = "owner" | "viewer";

export interface AuthState {
  /** The signed session token, or null when signed out. */
  token: string | null;
  /** Role this session proves. null when signed out. */
  role: Role | null;
  /** null while we are still asking the API whether the gate is switched on. */
  required: boolean | null;
  /** True when the tools may be opened (gate off, or a live token in hand). */
  unlocked: boolean;
  /** True when this session may mutate data. Viewers: false. */
  canEdit: boolean;
}

export interface ViewerState {
  enabled: boolean;
  /** First 4 characters of the live password — never the password itself. */
  hint: string | null;
  rotated_at: string | null;
}

// ---- storage (wrapped: blocked storage must never break the page) ----------

function loadToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked — the in-memory token still works for this session */
  }
}

/** Tokens are `<role>.<unixExpiry>.<hmac>`. Reading the role and expiry
 *  locally lets us shape the UI and drop a stale token before making a
 *  doomed request. The signature is still the real check — only the API can
 *  validate that, and it does so on every gated call. */
function parseToken(token: string): { role: Role; exp: number } | null {
  const [role, rawExp] = token.split(".");
  if (role !== "owner" && role !== "viewer") return null;
  const exp = Number(rawExp);
  if (!Number.isFinite(exp)) return null;
  return { role, exp };
}

function isLive(token: string): boolean {
  const parsed = parseToken(token);
  return parsed !== null && parsed.exp * 1000 > Date.now();
}

// ---- store -----------------------------------------------------------------

const listeners = new Set<() => void>();

let token = loadToken();
if (token && !isLive(token)) {
  token = null;
  storeToken(null);
}
let required: boolean | null = null;
let snapshot: AuthState = buildSnapshot();

function buildSnapshot(): AuthState {
  const parsed = token ? parseToken(token) : null;
  const live = token !== null && parsed !== null && parsed.exp * 1000 > Date.now();
  // Gate switched off (local API with no password) = full owner rights.
  const gateOff = required === false;
  const role: Role | null = gateOff ? "owner" : live ? parsed!.role : null;
  return {
    token,
    role,
    required,
    unlocked: gateOff || live,
    canEdit: role === "owner",
  };
}

function emit(): void {
  snapshot = buildSnapshot();
  listeners.forEach((fn) => fn());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAuthSnapshot(): AuthState {
  return snapshot;
}

// ---- request helpers -------------------------------------------------------

/** Header bag for every request to a gated route. Empty when signed out. */
export function authHeaders(): Record<string, string> {
  return token ? { [AUTH_HEADER]: token } : {};
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error ?? j.detail ?? msg;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg || `${method} ${path} failed`);
  }
  return res.json() as Promise<T>;
}

// ---- session ---------------------------------------------------------------

/**
 * Called by the API clients when the server answers 401: the token is stale,
 * revoked, or a password was rotated. Drop it and re-lock the UI.
 *
 * A 403 is deliberately NOT handled here — that means "you are signed in as a
 * viewer and tried to write", which must not sign anyone out.
 */
export function handleUnauthorized(): void {
  if (token === null) return;
  token = null;
  storeToken(null);
  emit();
}

export function signOut(): void {
  token = null;
  storeToken(null);
  emit();
}

/** Exchange a password for a token. The API decides which role it grants. */
export async function signIn(password: string): Promise<Role> {
  const body = await send<{ token?: string; role?: Role }>(
    "POST", "/api/auth/login", { password });
  if (!body.token) throw new Error("API returned no token");
  token = body.token;
  required = true;
  storeToken(token);
  emit();
  return body.role ?? "viewer";
}

/**
 * Ask the API whether the gate is configured at all.
 *
 * Fails CLOSED: if the API is unreachable we assume the lock is on rather
 * than flashing the tools open. An API with no PLUTUS_APP_PASSWORD (local
 * dev) reports `required: false`, which keeps `npm run dev` password-free.
 */
export async function refreshAuthRequirement(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/auth/status`, {
      headers: { Accept: "application/json", ...authHeaders() },
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as {
      required?: boolean;
      authenticated?: boolean;
    };
    required = body.required !== false;
    // The server is the authority on our token: if it says we are not
    // authenticated while the gate is on, whatever we hold is worthless.
    if (required && token && body.authenticated === false) {
      token = null;
      storeToken(null);
    }
  } catch {
    required = true;
  }
  emit();
}

// ---- view-only credential (owner only) -------------------------------------

export const viewerApi = {
  state: () => send<ViewerState>("GET", "/api/auth/viewer"),

  /** Mints a new shared password and returns it. This is the ONLY time the
   *  plaintext exists outside the sharer's hands — the API stores a hash. */
  rotate: () =>
    send<{ password: string; hint: string; rotated_at: string }>(
      "POST", "/api/auth/viewer/rotate", {}),

  disable: () => send<{ enabled: boolean }>("DELETE", "/api/auth/viewer"),
};
