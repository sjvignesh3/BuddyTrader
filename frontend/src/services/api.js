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

export async function getScreenerCacheInfo() {
  const res = await fetch(`${BASE_URL}/screener/cache-info`);
  if (!res.ok) throw new Error(`Failed to get cache info: ${res.statusText}`);
  return res.json();
}
