/**
 * Plutus Companion — service worker (Manifest V3).
 *
 * The ONLY place that talks to the Plutus API. Content scripts and the popup
 * send messages here; this worker adds the auth header, caches the universe
 * bootstrap per snapshot date, falls back to local storage for custom
 * watchlists when no token is configured, and re-injects content scripts
 * into tabs that were already open when the extension (re)loaded.
 *
 * Message protocol:  chrome.runtime.sendMessage({type, ...payload})
 *   -> {ok: true, data}  |  {ok: false, error, status}
 */
importScripts('shared/symbols.js', 'shared/settings.js');

const CACHE_BOOTSTRAP = 'plutus_cache_bootstrap';
const CACHE_STOCK = 'plutus_cache_stock';
const LOCAL_WATCHLISTS = 'plutus_local_watchlists';
const STOCK_TTL_MS = 10 * 60 * 1000;
const POSITIONS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCAL_LISTS = ['S1', 'S2', 'S3', 'S4'];

const TV_MATCH = ['https://*.tradingview.com/chart*', 'https://tradingview.com/chart*'];
const SCR_MATCH = ['https://*.screener.in/*', 'https://screener.in/*'];

let bootstrapInflight = null;
let positionsCache = { at: 0, data: null };

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------
function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (d) => resolve(d || {})));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status || 0; }
}

async function apiFetch(path, opts = {}) {
  const settings = await PlutusSettings.get();
  const base = String(settings.apiUrl || '').replace(/\/+$/, '');
  if (!base) throw new ApiError('Plutus API URL is not configured (open the extension popup)', 0);
  const headers = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (settings.token) headers['X-Plutus-Auth'] = settings.token;
  if (opts.admin && settings.adminToken) headers['X-Plutus-Admin-Token'] = settings.adminToken;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 60000);
  let res;
  try {
    res = await fetch(base + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new ApiError(e.name === 'AbortError' ? 'Plutus API timed out (cold start?) — try again' : 'Plutus API unreachable: ' + e.message, 0);
  }
  clearTimeout(timer);
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok) {
    let msg = (body && (body.error || body.detail)) || res.statusText || ('HTTP ' + res.status);
    // A 404 on the extension routes means the API process predates them (or the
    // URL points at the read-only Edge Function): say so instead of "Not Found".
    if (res.status === 404 && /^\/api\/(extension|watchlists|strategy_configs)/.test(path) && !(body && (body.error || body.detail))) {
      msg = 'This Plutus API has no ' + path.split('/').slice(0, 3).join('/') + ' route — restart the FastAPI server from the current code (or point the extension at it, not the Edge Function)';
    }
    throw new ApiError(msg, res.status);
  }
  return body;
}

// ---------------------------------------------------------------------------
// bootstrap cache (universe + snapshots + signals)
// ---------------------------------------------------------------------------
async function getBootstrap({ force = false } = {}) {
  const settings = await PlutusSettings.get();
  const ttl = Math.max(1, Number(settings.cacheTtlMinutes) || 720) * 60 * 1000;
  if (!force) {
    const { [CACHE_BOOTSTRAP]: cached } = await storageGet([CACHE_BOOTSTRAP]);
    if (cached && cached.data && cached.apiUrl === settings.apiUrl && (Date.now() - cached.fetchedAt) < ttl) {
      return Object.assign({ _cached: true, _fetchedAt: cached.fetchedAt }, cached.data);
    }
  }
  if (bootstrapInflight) return bootstrapInflight;
  bootstrapInflight = (async () => {
    try {
      const data = await apiFetch('/api/extension/bootstrap', { timeoutMs: 90000 });
      const fetchedAt = Date.now();
      await storageSet({ [CACHE_BOOTSTRAP]: { fetchedAt, apiUrl: settings.apiUrl, data } });
      broadcast({ type: 'plutus:bootstrap-updated', snapshot_date: data.snapshot_date, fetchedAt });
      return Object.assign({ _cached: false, _fetchedAt: fetchedAt }, data);
    } catch (e) {
      // Serve a stale copy rather than nothing when the API is asleep.
      const { [CACHE_BOOTSTRAP]: cached } = await storageGet([CACHE_BOOTSTRAP]);
      if (cached && cached.data) {
        return Object.assign({ _cached: true, _stale: true, _error: e.message, _fetchedAt: cached.fetchedAt }, cached.data);
      }
      throw e;
    } finally {
      bootstrapInflight = null;
    }
  })();
  return bootstrapInflight;
}

async function getStock(symbol, { force = false } = {}) {
  const sym = PlutusSymbols.toPlutus(symbol);
  if (!sym) throw new ApiError('not a ticker: ' + symbol, 400);
  const { [CACHE_STOCK]: cache = {} } = await storageGet([CACHE_STOCK]);
  const hit = cache[sym];
  if (!force && hit && (Date.now() - hit.at) < STOCK_TTL_MS) return Object.assign({ _cached: true }, hit.data);
  const data = await apiFetch('/api/extension/stock/' + encodeURIComponent(sym));
  cache[sym] = { at: Date.now(), data };
  // Trim to the 60 most recent entries.
  const keys = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at);
  keys.slice(60).forEach((k) => delete cache[k]);
  await storageSet({ [CACHE_STOCK]: cache });
  return data;
}

// ---------------------------------------------------------------------------
// watchlists — API when a token is configured, local storage otherwise
// ---------------------------------------------------------------------------
async function hasToken() {
  const s = await PlutusSettings.get();
  return !!(s.token && s.token.trim());
}

async function localLists() {
  const { [LOCAL_WATCHLISTS]: lists } = await storageGet([LOCAL_WATCHLISTS]);
  if (Array.isArray(lists) && lists.length) return lists;
  const seeded = DEFAULT_LOCAL_LISTS.map((name, i) => ({ id: 'local-' + (i + 1), name, symbols: [], display_order: (i + 1) * 10 }));
  await storageSet({ [LOCAL_WATCHLISTS]: seeded });
  return seeded;
}
async function saveLocalLists(lists) {
  await storageSet({ [LOCAL_WATCHLISTS]: lists });
  return lists;
}

async function getWatchlists() {
  if (await hasToken()) {
    try {
      const res = await apiFetch('/api/watchlists');
      return { source: 'api', watchlists: res.watchlists || [] };
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e;
      // token rejected -> fall through to local so the panel keeps working
    }
  }
  return { source: 'local', watchlists: await localLists() };
}

async function watchlistCreate(name, symbols) {
  const syms = PlutusSymbols.parseList((symbols || []).join(' '));
  if (await hasToken()) {
    const res = await apiFetch('/api/watchlists', { method: 'POST', body: { name, symbols: syms } });
    return res.watchlist;
  }
  const lists = await localLists();
  if (lists.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw new ApiError('a watchlist named ' + name + ' exists', 409);
  const row = { id: 'local-' + Date.now(), name, symbols: syms, display_order: (Math.max(0, ...lists.map((l) => l.display_order || 0)) + 10) };
  lists.push(row);
  await saveLocalLists(lists);
  return row;
}

async function watchlistUpdate(id, patch) {
  if (await hasToken() && !String(id).startsWith('local-')) {
    const res = await apiFetch('/api/watchlists/' + encodeURIComponent(id), { method: 'PUT', body: patch });
    return res.watchlist;
  }
  const lists = await localLists();
  const row = lists.find((l) => String(l.id) === String(id));
  if (!row) throw new ApiError('watchlist not found', 404);
  if (patch.name) {
    if (lists.some((l) => l !== row && l.name.toLowerCase() === patch.name.toLowerCase())) throw new ApiError('a watchlist named ' + patch.name + ' exists', 409);
    row.name = patch.name;
  }
  if (Array.isArray(patch.symbols)) row.symbols = PlutusSymbols.parseList(patch.symbols.join(' '));
  await saveLocalLists(lists);
  return row;
}

async function watchlistDelete(id) {
  if (await hasToken() && !String(id).startsWith('local-')) {
    await apiFetch('/api/watchlists/' + encodeURIComponent(id), { method: 'DELETE' });
    return { deleted: id };
  }
  const lists = await localLists();
  await saveLocalLists(lists.filter((l) => String(l.id) !== String(id)));
  return { deleted: id };
}

async function watchlistAddSymbols(id, symbols) {
  const syms = PlutusSymbols.parseList((symbols || []).join(' '));
  if (!syms.length) throw new ApiError('no valid symbols', 400);
  if (await hasToken() && !String(id).startsWith('local-')) {
    const res = await apiFetch('/api/watchlists/' + encodeURIComponent(id) + '/symbols', { method: 'POST', body: { symbols: syms } });
    return res;
  }
  const lists = await localLists();
  const row = lists.find((l) => String(l.id) === String(id));
  if (!row) throw new ApiError('watchlist not found', 404);
  const added = syms.filter((s) => !row.symbols.includes(s));
  row.symbols = row.symbols.concat(added);
  await saveLocalLists(lists);
  return { watchlist: row, added };
}

async function watchlistRemoveSymbol(id, symbol) {
  const sym = PlutusSymbols.toPlutus(symbol);
  if (await hasToken() && !String(id).startsWith('local-')) {
    return apiFetch('/api/watchlists/' + encodeURIComponent(id) + '/symbols/' + encodeURIComponent(sym), { method: 'DELETE' });
  }
  const lists = await localLists();
  const row = lists.find((l) => String(l.id) === String(id));
  if (!row) throw new ApiError('watchlist not found', 404);
  row.symbols = row.symbols.filter((s) => s !== sym);
  await saveLocalLists(lists);
  return { watchlist: row, removed: sym };
}

// ---------------------------------------------------------------------------
// journal / universe (token required)
// ---------------------------------------------------------------------------
async function requireToken() {
  if (!(await hasToken())) throw new ApiError('Sign in required: paste your Plutus token in the extension popup', 401);
}

async function getPositions({ force = false } = {}) {
  if (!(await hasToken())) return { positions: [], count: 0, _noToken: true };
  if (!force && positionsCache.data && (Date.now() - positionsCache.at) < POSITIONS_TTL_MS) return positionsCache.data;
  const data = await apiFetch('/api/journal/positions');
  positionsCache = { at: Date.now(), data };
  return data;
}

async function noteCreate({ symbol, content, note_date }) {
  await requireToken();
  const plain = PlutusSymbols.toPlain(symbol);
  if (!plain) throw new ApiError('not a ticker: ' + symbol, 400);
  return apiFetch('/api/journal/notes', { method: 'POST', body: { symbol: plain, content, note_date } });
}

async function notesList(symbol, limit = 20) {
  await requireToken();
  const plain = PlutusSymbols.toPlain(symbol);
  return apiFetch('/api/journal/notes?symbol=' + encodeURIComponent(plain) + '&limit=' + limit);
}

async function opportunityCreate(body) {
  await requireToken();
  const plain = PlutusSymbols.toPlain(body.symbol);
  if (!plain) throw new ApiError('not a ticker: ' + body.symbol, 400);
  return apiFetch('/api/journal/opportunities', { method: 'POST', body: Object.assign({}, body, { symbol: plain }) });
}

async function playAreaAdd(symbol) {
  await requireToken();
  const sym = PlutusSymbols.toPlutus(symbol);
  const res = await apiFetch('/api/universe/pools/PlayArea/members', { method: 'POST', body: { symbol: sym } });
  // Universe changed -> bootstrap must refresh on next read.
  await storageSet({ [CACHE_BOOTSTRAP]: null });
  return res;
}

async function playAreaRemove(symbol) {
  await requireToken();
  const sym = PlutusSymbols.toPlutus(symbol);
  const res = await apiFetch('/api/universe/pools/PlayArea/members/' + encodeURIComponent(sym), { method: 'DELETE' });
  await storageSet({ [CACHE_BOOTSTRAP]: null });
  return res;
}

async function triggerSync(symbols) {
  await requireToken();
  return apiFetch('/api/admin/trigger', { method: 'POST', admin: true, body: { workflow: 'daily', symbols } });
}

async function ping() {
  const started = Date.now();
  const health = await apiFetch('/api/health', { timeoutMs: 90000 });
  let auth = null;
  try { auth = await apiFetch('/api/auth/status'); } catch (e) { auth = { error: e.message }; }
  return { health, auth, latencyMs: Date.now() - started };
}

async function clearCache() {
  await storageSet({ [CACHE_BOOTSTRAP]: null, [CACHE_STOCK]: {} });
  positionsCache = { at: 0, data: null };
  return { cleared: true };
}

// ---------------------------------------------------------------------------
// message router
// ---------------------------------------------------------------------------
const HANDLERS = {
  'ping': () => ping(),
  'bootstrap': (m) => getBootstrap({ force: !!m.force }),
  'stock': (m) => getStock(m.symbol, { force: !!m.force }),
  'watchlists': () => getWatchlists(),
  'watchlist.create': (m) => watchlistCreate(m.name, m.symbols),
  'watchlist.update': (m) => watchlistUpdate(m.id, m.patch || {}),
  'watchlist.delete': (m) => watchlistDelete(m.id),
  'watchlist.add': (m) => watchlistAddSymbols(m.id, m.symbols),
  'watchlist.remove': (m) => watchlistRemoveSymbol(m.id, m.symbol),
  'positions': (m) => getPositions({ force: !!m.force }),
  'notes.list': (m) => notesList(m.symbol, m.limit),
  'notes.create': (m) => noteCreate(m),
  'opportunity.create': (m) => opportunityCreate(m.body || {}),
  'playarea.add': (m) => playAreaAdd(m.symbol),
  'playarea.remove': (m) => playAreaRemove(m.symbol),
  'sync.trigger': (m) => triggerSync(m.symbols || []),
  'cache.clear': () => clearCache(),
  'settings': () => PlutusSettings.get(),
  'api': (m) => apiFetch(m.path, { method: m.method, body: m.body, admin: !!m.admin }),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && HANDLERS[message.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e), status: (e && e.status) || 0 }));
  return true; // async response
});

function broadcast(message) {
  chrome.tabs.query({ url: TV_MATCH.concat(SCR_MATCH) }, (tabs) => {
    (tabs || []).forEach((t) => { if (t.id) chrome.tabs.sendMessage(t.id, message).catch(() => {}); });
  });
}

// Settings changes (API URL / token) invalidate caches keyed on them.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[PlutusSettings.KEY]) return;
  const before = (changes[PlutusSettings.KEY].oldValue || {});
  const after = (changes[PlutusSettings.KEY].newValue || {});
  if (before.apiUrl !== after.apiUrl || before.token !== after.token) {
    positionsCache = { at: 0, data: null };
    storageSet({ [CACHE_STOCK]: {} });
  }
});

// ---------------------------------------------------------------------------
// inject into tabs already open at install / browser start
// ---------------------------------------------------------------------------
async function injectIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: TV_MATCH.concat(SCR_MATCH) }); } catch (e) { return; }
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    const isTv = tab.url.includes('tradingview.com');
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: [isTv ? 'tv/tv.css' : 'screener/screener.css'] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: isTv
          ? ['shared/symbols.js', 'shared/settings.js', 'shared/ui.js', 'tv/tv_content.js']
          : ['shared/symbols.js', 'shared/settings.js', 'shared/ui.js', 'vendor/chart.min.js', 'screener/screener_content.js'],
      });
    } catch (e) { /* restricted tab or already injected */ }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  injectIntoOpenTabs();
  chrome.alarms.create('plutus-prewarm', { periodInMinutes: 25 });
});
chrome.runtime.onStartup.addListener(() => {
  injectIntoOpenTabs();
  chrome.alarms.create('plutus-prewarm', { periodInMinutes: 25 });
});

// Keep a free-tier API host warm while a chart or Screener tab is open, so
// the first panel action after a pause is not a 40 s cold start.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'plutus-prewarm') return;
  chrome.tabs.query({ url: TV_MATCH.concat(SCR_MATCH) }, (tabs) => {
    if (!tabs || !tabs.length) return;
    apiFetch('/api/health', { timeoutMs: 90000 }).catch(() => {});
  });
});
