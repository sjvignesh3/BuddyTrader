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
importScripts('shared/symbols.js', 'shared/settings.js', 'shared/tvscan.js');

const CACHE_BOOTSTRAP = 'plutus_cache_bootstrap';
const CACHE_STOCK = 'plutus_cache_stock';
const LOCAL_WATCHLISTS = 'plutus_local_watchlists';
const STOCK_TTL_MS = 10 * 60 * 1000;
const POSITIONS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCAL_LISTS = ['S1', 'S2', 'S3', 'S4'];

const TV_MATCH = ['https://*.tradingview.com/chart*', 'https://tradingview.com/chart*'];
const SCR_MATCH = ['https://*.screener.in/*', 'https://screener.in/*'];
// US research sites (us/us_sites.js); kept in step with manifest.json content_scripts.
const US_MATCH = ['https://*.stockanalysis.com/stocks/*', 'https://stockanalysis.com/stocks/*', 'https://*.roic.ai/*', 'https://roic.ai/*',
  'https://*.vcpscanner.com/stock/*', 'https://vcpscanner.com/stock/*', 'https://*.stockresearch.app/stocks/*', 'https://stockresearch.app/stocks/*'];

let bootstrapInflight = null;
let positionsCache = { at: 0, data: null };
let tokenRejected = false;

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
  // Token health: a 401 while we hold a token means this API rejects it
  // (expired, or minted by another Plutus API). Tell the panels once; a later
  // authenticated success clears the flag.
  if (settings.token && !/^\/api\/auth\//.test(path)) {
    if (res.status === 401 && !tokenRejected) { tokenRejected = true; broadcast({ type: 'plutus:token-state', rejected: true }); }
    else if (res.ok && tokenRejected && settings.token) { tokenRejected = false; broadcast({ type: 'plutus:token-state', rejected: false }); }
  }
  if (!res.ok) {
    let msg = (body && (body.error || body.detail)) || res.statusText || ('HTTP ' + res.status);
    if (res.status === 401 && settings.token) msg = 'Plutus rejected the saved token (expired, or issued by another Plutus API) — sign in on the web app again or paste a fresh token in the popup';
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
// US tickers carry no suffix, so the symbol converter has to be told which
// bare tickers are US (and on which exchange). The worker is restarted often:
// re-seed from the cached bootstrap before the first message is handled.
let usSeeded = false;
function registerUsFrom(data) {
  if (data && Array.isArray(data.stocks)) PlutusSymbols.registerUs(data.stocks);
}
async function ensureUsRegistry() {
  if (usSeeded) return;
  usSeeded = true;
  try {
    const { [CACHE_BOOTSTRAP]: cached } = await storageGet([CACHE_BOOTSTRAP]);
    registerUsFrom(cached && cached.data);
  } catch (e) { /* ignore — bare tickers fall back to Indian */ }
}

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
      registerUsFrom(data);
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

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function cleanColor(c) {
  if (c == null || c === '') return null;
  if (!HEX_COLOR_RE.test(String(c))) throw new ApiError("color must be '#rrggbb'", 400);
  return String(c).toLowerCase();
}

async function watchlistCreate(name, symbols, color) {
  const syms = PlutusSymbols.parseList((symbols || []).join(' '));
  const col = cleanColor(color);
  if (await hasToken()) {
    const body = { name, symbols: syms };
    if (col) body.color = col;
    const res = await apiFetch('/api/watchlists', { method: 'POST', body });
    return res.watchlist;
  }
  const lists = await localLists();
  if (lists.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw new ApiError('a watchlist named ' + name + ' exists', 409);
  const row = { id: 'local-' + Date.now(), name, symbols: syms, color: col, display_order: (Math.max(0, ...lists.map((l) => l.display_order || 0)) + 10) };
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
  if ('color' in patch) row.color = cleanColor(patch.color);
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

// The journal routes answer for ONE market per call (default IN): a US symbol
// needs `market=US`, and "all open lots" means both markets merged.
function marketOf(symbol) {
  return PlutusSymbols.isUs(PlutusSymbols.toPlutus(symbol)) ? 'US' : 'IN';
}
function marketQuery(symbol) {
  return marketOf(symbol) === 'US' ? '&market=US' : '';
}
async function bothMarkets(pathFor, mergeKey) {
  const [inn, us] = await Promise.all([
    apiFetch(pathFor('IN')),
    apiFetch(pathFor('US')).catch(() => ({ [mergeKey]: [] })),   // older APIs have no US journal
  ]);
  const rows = (inn[mergeKey] || []).concat(us[mergeKey] || []);
  return Object.assign({}, inn, { [mergeKey]: rows, count: rows.length });
}

async function getPositions({ force = false } = {}) {
  if (!(await hasToken())) return { positions: [], count: 0, _noToken: true };
  if (!force && positionsCache.data && (Date.now() - positionsCache.at) < POSITIONS_TTL_MS) return positionsCache.data;
  const data = await bothMarkets((m) => '/api/journal/positions' + (m === 'US' ? '?market=US' : ''), 'positions');
  positionsCache = { at: Date.now(), data };
  return data;
}

async function noteCreate({ symbol, content, note_date }) {
  await requireToken();
  const plain = PlutusSymbols.toPlain(symbol);
  if (!plain) throw new ApiError('not a ticker: ' + symbol, 400);
  return apiFetch('/api/journal/notes', { method: 'POST', body: { symbol: plain, content, note_date, market: marketOf(symbol) } });
}

async function notesList(symbol, limit) {
  await requireToken();
  const plain = PlutusSymbols.toPlain(symbol);
  const n = Math.max(1, Math.min(2000, Number(limit) || 20));
  return apiFetch('/api/journal/notes?symbol=' + encodeURIComponent(plain) + '&limit=' + n + marketQuery(symbol));
}

/** Everything the journal knows about one stock: open + closed lots, opportunities, sizing plans. */
async function tradesForSymbol(symbol) {
  await requireToken();
  const plain = PlutusSymbols.toPlain(symbol);
  if (!plain) throw new ApiError('not a ticker: ' + symbol, 400);
  const mq = marketQuery(symbol);
  const [trades, opps, plans] = await Promise.all([
    apiFetch('/api/journal/trades?symbol=' + encodeURIComponent(plain) + mq),
    apiFetch('/api/journal/opportunities?' + mq.replace(/^&/, '')).catch(() => ({ opportunities: [] })),
    apiFetch('/api/sizing/plans?symbol=' + encodeURIComponent(plain) + mq).catch(() => ({ plans: [] })),
  ]);
  const all = trades.trades || [];
  const opportunities = (opps.opportunities || []).filter((o) => String(o.symbol || '').toUpperCase() === plain);
  return {
    symbol: plain, market: marketOf(symbol),
    open: all.filter((t) => String(t.status || '').toUpperCase() === 'OPEN'),
    closed: all.filter((t) => String(t.status || '').toUpperCase() !== 'OPEN'),
    opportunities,
    plans: plans.plans || [],
  };
}

/** Live quotes for the rows on screen (display only; see shared/tvscan.js). */
async function liveQuotes(symbols) {
  const s = await PlutusSettings.get();
  if (!s.tvLivePrices) return { quotes: {}, degraded: false, off: true };
  const syms = Array.from(new Set((symbols || []).map((x) => PlutusSymbols.toPlutus(x)).filter(Boolean))).slice(0, 600);
  return PlutusTvScan.quotes(syms);
}

async function noteUpdate(id, patch) {
  await requireToken();
  if (id == null) throw new ApiError('note id required', 400);
  const body = {};
  if (patch && typeof patch.content === 'string') body.content = patch.content;
  if (patch && patch.note_date) body.note_date = patch.note_date;
  if (!Object.keys(body).length) throw new ApiError('nothing to update', 400);
  return apiFetch('/api/journal/notes/' + encodeURIComponent(id), { method: 'PUT', body });
}

async function noteDelete(id) {
  await requireToken();
  if (id == null) throw new ApiError('note id required', 400);
  return apiFetch('/api/journal/notes/' + encodeURIComponent(id), { method: 'DELETE' });
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

let settingsCache = { at: 0, data: null };
async function journalSettings() {
  await requireToken();
  if (settingsCache.data && (Date.now() - settingsCache.at) < POSITIONS_TTL_MS) return settingsCache.data;
  const data = await apiFetch('/api/journal/settings');
  settingsCache = { at: Date.now(), data };
  return data;
}

let openTradesCache = { at: 0, data: null };
/** OPEN journal lots (per-lot detail: buy date, price, qty, target, stop). */
async function openTrades({ force = false } = {}) {
  if (!(await hasToken())) return { trades: [], count: 0, _noToken: true };
  if (!force && openTradesCache.data && (Date.now() - openTradesCache.at) < POSITIONS_TTL_MS) return openTradesCache.data;
  const data = await bothMarkets((m) => '/api/journal/trades?status=OPEN' + (m === 'US' ? '&market=US' : ''), 'trades');
  openTradesCache = { at: Date.now(), data };
  return data;
}

async function sizingSave(body) {
  await requireToken();
  return apiFetch('/api/sizing/plans', { method: 'POST', body });
}

// ---------------------------------------------------------------------------
// Linked tabs: a chart tab and a Screener company tab follow each other.
// ---------------------------------------------------------------------------
const SCR_COMPANY_MATCH = ['https://*.screener.in/company/*', 'https://screener.in/company/*'];
// Echo guard: the tab we just moved will report the same symbol back once it
// loads; swallow that report instead of bouncing it to the other side.
let lastLink = { tabId: null, plain: null, at: 0 };

function screenerTicker(url) {
  const m = /\/company\/([^\/?#]+)/i.exec(url || '');
  return m ? PlutusSymbols.toPlain(decodeURIComponent(m[1])) : null;
}

/** The tab the user most likely means: active in the last-focused window, else most recently used. */
async function pickTab(urls, excludeTabId) {
  const tabs = (await chrome.tabs.query({ url: urls })).filter((t) => t.id && t.id !== excludeTabId);
  if (!tabs.length) return null;
  let focusedWindowId = null;
  try { focusedWindowId = (await chrome.windows.getLastFocused()).id; } catch (e) { /* ignore */ }
  const score = (t) => (t.active ? 2 : 0) + (t.active && t.windowId !== focusedWindowId ? 1 : 0) + (t.lastAccessed || 0) / 1e15;
  // Prefer a tab that is visible in ANOTHER window (second monitor), then any active tab, then most recent.
  return tabs.sort((a, b) => score(b) - score(a))[0];
}

async function linkSymbol(msg, sender) {
  const s = await PlutusSettings.get();
  if (!s.linkTabs) return { linked: false, reason: 'off' };
  const plain = PlutusSymbols.toPlain(msg.symbol);
  if (!plain) return { linked: false, reason: 'not a ticker' };
  const fromTab = sender && sender.tab ? sender.tab.id : null;
  if (fromTab === lastLink.tabId && plain === lastLink.plain && Date.now() - lastLink.at < 20000) {
    return { linked: false, reason: 'echo' };
  }
  if (msg.from === 'tv') {
    if (PlutusSymbols.isUs(PlutusSymbols.toPlutus(msg.symbol))) return { linked: false, reason: 'US stock — not on Screener' };
    const tab = await pickTab(SCR_COMPANY_MATCH, fromTab);
    if (!tab) return { linked: false, reason: 'no Screener company tab' };
    if (screenerTicker(tab.url) === plain) return { linked: false, reason: 'already there' };
    const consolidated = s.scrAutoConsolidated || /\/consolidated/i.test(tab.url || '');
    lastLink = { tabId: tab.id, plain, at: Date.now() };
    await chrome.tabs.update(tab.id, { url: PlutusSymbols.toScreenerUrl(plain, consolidated) });
    return { linked: true, tabId: tab.id };
  }
  if (msg.from === 'screener') {
    const tab = await pickTab(TV_MATCH, fromTab);
    if (!tab) return { linked: false, reason: 'no TradingView chart tab' };
    lastLink = { tabId: tab.id, plain, at: Date.now() };
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'plutus:switch-symbol', symbol: PlutusSymbols.toPlutus(plain, { market: 'IN' }) });
    } catch (e) {
      return { linked: false, reason: 'chart tab not ready — reload it once' };
    }
    return { linked: true, tabId: tab.id };
  }
  return { linked: false, reason: 'unknown source' };
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
  positionsCache = { at: 0, data: null }; openTradesCache = { at: 0, data: null }; settingsCache = { at: 0, data: null };
  PlutusTvScan.reset();
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
  'watchlist.create': (m) => watchlistCreate(m.name, m.symbols, m.color),
  'watchlist.update': (m) => watchlistUpdate(m.id, m.patch || {}),
  'watchlist.delete': (m) => watchlistDelete(m.id),
  'watchlist.add': (m) => watchlistAddSymbols(m.id, m.symbols),
  'watchlist.remove': (m) => watchlistRemoveSymbol(m.id, m.symbol),
  'positions': (m) => getPositions({ force: !!m.force }),
  'trades.open': (m) => openTrades({ force: !!m.force }),
  'journal.settings': () => journalSettings(),
  'sizing.save': (m) => sizingSave(m.body || {}),
  'link.symbol': (m, sender) => linkSymbol(m, sender),
  'notes.list': (m) => notesList(m.symbol, m.limit),
  'notes.create': (m) => noteCreate(m),
  'notes.update': (m) => noteUpdate(m.id, m.patch || {}),
  'notes.delete': (m) => noteDelete(m.id),
  'trades.forSymbol': (m) => tradesForSymbol(m.symbol),
  'live.quotes': (m) => liveQuotes(m.symbols || []),
  'live.fundamentals': (m) => PlutusTvScan.fundamentals(PlutusSymbols.toPlutus(m.symbol) || m.symbol),
  'live.fundamentalsBatch': (m) => PlutusTvScan.fundamentalsBatch(Array.from(new Set((m.symbols || []).map((x) => PlutusSymbols.toPlutus(x)).filter(Boolean))).slice(0, 800)),
  'bridge.register': () => registerTokenBridge(),
  'token.state': () => ({ rejected: tokenRejected }),
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
  ensureUsRegistry()
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
    positionsCache = { at: 0, data: null }; openTradesCache = { at: 0, data: null }; settingsCache = { at: 0, data: null };
    storageSet({ [CACHE_STOCK]: {} });
    if (tokenRejected) { tokenRejected = false; broadcast({ type: 'plutus:token-state', rejected: false }); }
  }
  if (before.webAppUrl !== after.webAppUrl) registerTokenBridge().catch(() => {});
});

// ---------------------------------------------------------------------------
// Token bridge on the deployed web app (F5)
// ---------------------------------------------------------------------------
// The manifest only matches localhost:5173. For a deployed web app the popup
// asks for that one origin (optional_host_permissions) and the worker then
// registers webapp/token_bridge.js there, so signing in on the web app is
// enough — no token pasting.
const BRIDGE_ID = 'plutus-token-bridge';
const LOCAL_BRIDGE_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/** Origin + "/*" match pattern for the web-app URL, or null when it is local / invalid. */
function bridgeMatchFor(webAppUrl) {
  let origin;
  try { origin = new URL(String(webAppUrl || '')).origin; } catch (e) { return null; }
  if (!/^https?:$/.test(new URL(origin).protocol) || LOCAL_BRIDGE_RE.test(origin)) return null;
  return origin + '/*';
}

async function registerTokenBridge() {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return { registered: false, reason: 'no scripting API' };
  const s = await PlutusSettings.get();
  const match = bridgeMatchFor(s.webAppUrl);
  try { await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_ID] }); } catch (e) { /* not registered yet */ }
  if (!match) return { registered: false, reason: 'local or invalid web-app URL' };
  let granted = false;
  try { granted = await chrome.permissions.contains({ origins: [match] }); } catch (e) { granted = false; }
  if (!granted) return { registered: false, reason: 'permission for ' + match + ' not granted (save the web-app URL in the popup)' };
  await chrome.scripting.registerContentScripts([{
    id: BRIDGE_ID, matches: [match], js: ['shared/settings.js', 'webapp/token_bridge.js'], runAt: 'document_idle', persistAcrossSessions: true,
  }]);
  return { registered: true, match };
}

// ---------------------------------------------------------------------------
// inject into tabs already open at install / browser start
// ---------------------------------------------------------------------------
async function injectIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: TV_MATCH.concat(SCR_MATCH) }); } catch (e) { return; }
  // US research tabs that were open before the extension (re)loaded
  try {
    const usTabs = await chrome.tabs.query({ url: US_MATCH });
    for (const tab of usTabs) {
      if (!tab.id) continue;
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['us/us.css'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared/symbols.js', 'shared/settings.js', 'shared/ui.js', 'shared/table_colour.js', 'us/us_sites.js'] });
      } catch (e) { /* no access to that tab (site access withheld) or already injected */ }
    }
  } catch (e) { /* ignore */ }
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    const isTv = tab.url.includes('tradingview.com');
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: [isTv ? 'tv/tv.css' : 'screener/screener.css'] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: isTv
          ? ['shared/symbols.js', 'shared/settings.js', 'shared/ui.js', 'shared/panel_logic.js', 'shared/card.js', 'shared/sizer.js', 'shared/links.js', 'tv/tv_content.js']
          : ['shared/symbols.js', 'shared/settings.js', 'shared/ui.js', 'shared/card.js', 'shared/sizer.js', 'vendor/chart.min.js', 'screener/screener_content.js'],
      });
    } catch (e) { /* restricted tab or already injected */ }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  injectIntoOpenTabs();
  registerTokenBridge().catch(() => {});
  chrome.alarms.create('plutus-prewarm', { periodInMinutes: 25 });
});
chrome.runtime.onStartup.addListener(() => {
  injectIntoOpenTabs();
  registerTokenBridge().catch(() => {});
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
