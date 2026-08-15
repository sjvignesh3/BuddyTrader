/**
 * API service - communicates with the FastAPI backend.
 */

const BASE_URL = '/api';

/**
 * Internal fetch wrapper that gives meaningful errors instead of
 * browser-generated "Not Found" / "" statusText values.
 *
 * When the Vite proxy can't reach the backend (backend not running), it
 * returns HTTP 502/500 with no body. `res.statusText` in those cases is
 * either empty or misleadingly shows "Not Found". This wrapper replaces
 * that with actionable messages.
 */
async function apiFetch(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    // fetch() itself threw — complete network failure (CORS, no connection, etc.)
    throw new Error(`Backend unreachable — is the FastAPI server running on port 8000? (${networkErr.message})`);
  }

  if (!res.ok) {
    // Try to get a useful message from the JSON body first
    let detail = '';
    try {
      const body = await res.clone().json();
      detail = body?.detail || body?.message || '';
    } catch {
      try { detail = await res.clone().text(); } catch { /* ignore */ }
    }

    // Map proxy error codes to actionable messages
    if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
      const bodyHint = detail ? `: ${detail.slice(0, 120)}` : '';
      throw new Error(
        `Backend proxy error (HTTP ${res.status}) — FastAPI is not running on port 8000, or crashed${bodyHint}`
      );
    }

    const statusLabel = detail || res.statusText || `HTTP ${res.status}`;
    throw Object.assign(new Error(statusLabel), { status: res.status, response: res });
  }

  return res;
}

export async function triggerScan(pool = 'F40', strategies = null, symbols = null) {
  const params = new URLSearchParams({ pool });
  if (strategies) params.append('strategies', strategies);
  if (symbols) params.append('symbols', symbols);

  const res = await apiFetch(`${BASE_URL}/scan?${params}`, { method: 'POST' });
  return res.json();
}

export async function getLastScan() {
  const res = await apiFetch(`${BASE_URL}/scan/last`);
  return res.json();
}

export async function getCachedScan(poolCode) {
  const res = await apiFetch(`${BASE_URL}/scan/${poolCode}`);
  const data = await res.json();
  if (data.message) return null; // "No cached scan" message
  return data;
}

export async function getScanStatuses() {
  const res = await apiFetch(`${BASE_URL}/scans/status`);
  return res.json();
}

export async function getPools() {
  const res = await apiFetch(`${BASE_URL}/pools`);
  return res.json();
}

export async function getStrategies() {
  const res = await apiFetch(`${BASE_URL}/strategies`);
  return res.json();
}

export async function clearCache() {
  const res = await apiFetch(`${BASE_URL}/cache/clear`, { method: 'POST' });
  return res.json();
}


// ═══════════════════════════════════════════════════════════════════════════
//  ADVANCED SCREENER API
// ═══════════════════════════════════════════════════════════════════════════

export async function getScreenerRules() {
  const res = await apiFetch(`${BASE_URL}/screener/rules`);
  return res.json();
}

export async function getScreenerAuthStatus() {
  const res = await apiFetch(`${BASE_URL}/screener/auth-status`);
  return res.json();
}

export async function runScreener(pool = 'F40', rules = null, symbols = null, forceRefresh = false) {
  const body = { pool, force_refresh: forceRefresh };
  if (rules)   body.rules   = rules;
  if (symbols) body.symbols = symbols;

  const res = await apiFetch(`${BASE_URL}/screener/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * Run screener with SSE streaming for live progress + throttle countdown.
 *
 * @param {string}   pool          - Pool code: F40, E40, S200, PlayArea
 * @param {Array}    rules         - Rule configs (null = defaults)
 * @param {Array}    symbols       - Custom symbols for PlayArea (null otherwise)
 * @param {boolean}  forceRefresh  - Bypass cache
 * @param {Function} onEvent       - Called for each SSE event object:
 *                                   manifest | progress | throttle_tick | complete | error
 * @returns {Promise<object>}      - Resolves with the final "complete" event payload
 */
export async function runScreenerStream(pool = 'F40', rules = null, symbols = null, forceRefresh = false, onEvent = null) {
  const body = { pool, force_refresh: forceRefresh };
  if (rules)   body.rules   = rules;
  if (symbols) body.symbols = symbols;

  const res = await apiFetch(`${BASE_URL}/screener/run-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error('Streaming not supported — try a modern browser (Chrome/Edge/Firefox)');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE lines are delimited by "\n\n"
    const parts = buffer.split('\n\n');
    buffer = parts.pop(); // keep incomplete trailing chunk

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (onEvent) onEvent(event);
        if (event.type === 'complete') finalResult = event;
        if (event.type === 'error') throw new Error(event.message || 'Screener error');
      } catch (e) {
        if (e.message.startsWith('Screener')) throw e;
        // ignore malformed lines
      }
    }
  }

  return finalResult;
}

export async function getScreenerCacheInfo() {
  const res = await apiFetch(`${BASE_URL}/screener/cache-info`);
  return res.json();
}

/**
 * Fetch fundamental data for given symbols ONLY from the persistent cache.
 * Makes NO internet calls. Returns points (out of 9) and check details.
 *
 * @param {string[]} symbols - Array of NSE symbols
 * @returns {Promise<{results: Object}>}
 */
export async function getFundamentalsFromCache(symbols) {
  if (!symbols || symbols.length === 0) return { results: {} };
  const params = new URLSearchParams({ symbols: symbols.join(',') });
  const res = await apiFetch(`${BASE_URL}/screener/fundamentals-from-cache?${params}`);
  return res.json();
}
