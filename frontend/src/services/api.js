/**
 * API service - communicates with the FastAPI backend.
 */

const BASE_URL = '/api';

export async function triggerScan(pool = 'F40', strategies = null) {
  const params = new URLSearchParams({ pool });
  if (strategies) params.append('strategies', strategies);

  const res = await fetch(`${BASE_URL}/scan?${params}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Scan failed: ${res.statusText}`);
  return res.json();
}

export async function getLastScan() {
  const res = await fetch(`${BASE_URL}/scan/last`);
  if (!res.ok) throw new Error(`Failed to get last scan: ${res.statusText}`);
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
