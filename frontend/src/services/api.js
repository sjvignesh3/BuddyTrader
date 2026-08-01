/**
 * API service - communicates with the FastAPI backend.
 */

const BASE_URL = '/api';

export async function triggerScan(pool = 'F40', strategies = null, symbols = null) {
  const params = new URLSearchParams({ pool });
  if (strategies) params.append('strategies', strategies);
  if (symbols) params.append('symbols', symbols);

  const res = await fetch(`${BASE_URL}/scan?${params}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Scan failed: ${res.statusText}`);
  return res.json();
}

export async function getLastScan() {
  const res = await fetch(`${BASE_URL}/scan/last`);
  if (!res.ok) throw new Error(`Failed to get last scan: ${res.statusText}`);
  return res.json();
}

export async function getCachedScan(poolCode) {
  const res = await fetch(`${BASE_URL}/scan/${poolCode}`);
  if (!res.ok) throw new Error(`Failed to get cached scan: ${res.statusText}`);
  const data = await res.json();
  if (data.message) return null; // "No cached scan" message
  return data;
}

export async function getScanStatuses() {
  const res = await fetch(`${BASE_URL}/scans/status`);
  if (!res.ok) throw new Error(`Failed to get scan statuses: ${res.statusText}`);
  return res.json();
}

export async function getPools() {
  const res = await fetch(`${BASE_URL}/pools`);
  if (!res.ok) throw new Error(`Failed to get pools: ${res.statusText}`);
  return res.json();
}

export async function getStrategies() {
  const res = await fetch(`${BASE_URL}/strategies`);
  if (!res.ok) throw new Error(`Failed to get strategies: ${res.statusText}`);
  return res.json();
}

export async function clearCache() {
  const res = await fetch(`${BASE_URL}/cache/clear`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to clear cache: ${res.statusText}`);
  return res.json();
}


// ═══════════════════════════════════════════════════════════════════════════
//  ADVANCED SCREENER API
// ═══════════════════════════════════════════════════════════════════════════

export async function getScreenerRules() {
  const res = await fetch(`${BASE_URL}/screener/rules`);
  if (!res.ok) throw new Error(`Failed to get screener rules: ${res.statusText}`);
  return res.json();
}

export async function getScreenerAuthStatus() {
  const res = await fetch(`${BASE_URL}/screener/auth-status`);
  if (!res.ok) throw new Error(`Failed to get auth status: ${res.statusText}`);
  return res.json();
}

export async function runScreener(pool = 'F40', rules = null, symbols = null, forceRefresh = false) {
  const body = { pool, force_refresh: forceRefresh };
  if (rules)   body.rules   = rules;
  if (symbols) body.symbols = symbols;

  const res = await fetch(`${BASE_URL}/screener/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Screener failed: ${res.statusText}`);
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

  const res = await fetch(`${BASE_URL}/screener/run-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Screener stream failed: ${res.statusText}`);
  if (!res.body) throw new Error('Streaming not supported in this browser');

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
  const res = await fetch(`${BASE_URL}/screener/cache-info`);
  if (!res.ok) throw new Error(`Failed to get cache info: ${res.statusText}`);
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
  const res = await fetch(`${BASE_URL}/screener/fundamentals-from-cache?${params}`);
  if (!res.ok) throw new Error(`Failed to get fundamentals from cache: ${res.statusText}`);
  return res.json();
}
