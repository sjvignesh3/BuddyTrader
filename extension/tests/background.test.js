// Plutus Companion — offline tests for the service worker and shared helpers.
// Run:  node --test extension/tests
// No browser: background.js is evaluated in a vm context with a fake `chrome`.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Fresh worker context with a fake chrome.* API. */
function loadWorker({ settings = {}, tabs = [], fetch, granted = [] } = {}) {
  const store = { plutus_settings: Object.assign({ apiUrl: 'http://api.test', linkTabs: true, scrAutoConsolidated: true }, settings) };
  const calls = { updated: [], sent: [], fetched: [], registered: [], unregistered: [] };
  const listeners = { message: [] };
  const matches = (url, patterns) => patterns.some((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(url));
  const chrome = {
    runtime: {
      id: 'test',
      onMessage: { addListener: (f) => listeners.message.push(f) },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    },
    storage: {
      local: {
        get: (keys, cb) => { const out = {}; [].concat(keys).forEach((k) => { if (k in store) out[k] = store[k]; }); cb(out); },
        set: (obj, cb) => { Object.assign(store, obj); cb && cb(); },
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      // Both styles the worker uses: awaited, and callback (broadcast).
      query: (q, cb) => { const r = tabs.filter((t) => !q.url || matches(t.url, [].concat(q.url))); if (cb) cb(r); return Promise.resolve(r); },
      update: async (id, props) => { calls.updated.push({ id, url: props.url }); const t = tabs.find((x) => x.id === id); if (t) t.url = props.url; return t; },
      sendMessage: async (id, msg) => { calls.sent.push({ id, msg }); },
    },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    scripting: {
      registerContentScripts: async (defs) => { calls.registered.push(...defs); },
      unregisterContentScripts: async (q) => { calls.unregistered.push(q); },
    },
    permissions: { contains: async (q) => q.origins.every((o) => granted.includes(o)) },
  };
  const fakeFetch = fetch || (async () => { throw new Error('no network in tests'); });
  const ctx = { chrome, console, setTimeout, clearTimeout, AbortController, URL,
    fetch: async (url, opts) => { calls.fetched.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : undefined, headers: opts && opts.headers }); return fakeFetch(url, opts); } };
  ctx.self = ctx;
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
  vm.createContext(ctx);
  vm.runInContext(read('background.js'), ctx, { filename: 'background.js' });
  const send = (msg, senderTabId) => new Promise((resolve) => {
    const handled = listeners.message.some((f) => f(msg, { tab: senderTabId ? { id: senderTabId } : undefined }, resolve) === true);
    if (!handled) resolve(undefined);
  });
  return { send, calls, store, tabs };
}

const TV = (id, extra) => Object.assign({ id, url: 'https://in.tradingview.com/chart/abc/?symbol=NSE%3AINFY', active: true, windowId: 1, lastAccessed: 1 }, extra);
const SCR = (id, ticker, extra) => Object.assign({ id, url: 'https://www.screener.in/company/' + ticker + '/consolidated/', active: true, windowId: 2, lastAccessed: 1 }, extra);

test('chart change moves the Screener company tab to the same stock', async () => {
  const w = loadWorker({ tabs: [TV(1), SCR(2, 'RELIANCE')] });
  const res = await w.send({ type: 'link.symbol', from: 'tv', symbol: 'INFY.NS' }, 1);
  assert.equal(res.ok, true);
  assert.equal(res.data.linked, true);
  assert.deepEqual(w.calls.updated, [{ id: 2, url: 'https://www.screener.in/company/INFY/consolidated/' }]);
});

test('ampersand tickers keep the Screener spelling', async () => {
  const w = loadWorker({ tabs: [TV(1), SCR(2, 'TCS')] });
  await w.send({ type: 'link.symbol', from: 'tv', symbol: 'NSE:M_M' }, 1);
  assert.equal(w.calls.updated[0].url, 'https://www.screener.in/company/M%26M/consolidated/');
});

test('no navigation when Screener already shows the stock', async () => {
  const w = loadWorker({ tabs: [TV(1), SCR(2, 'INFY')] });
  const res = await w.send({ type: 'link.symbol', from: 'tv', symbol: 'INFY.NS' }, 1);
  assert.equal(res.data.reason, 'already there');
  assert.equal(w.calls.updated.length, 0);
});

test('Screener pages that are not company pages are never hijacked', async () => {
  const w = loadWorker({ tabs: [TV(1), { id: 3, url: 'https://www.screener.in/screens/123/my-screen/', active: true, windowId: 2 }] });
  const res = await w.send({ type: 'link.symbol', from: 'tv', symbol: 'INFY.NS' }, 1);
  assert.equal(res.data.linked, false);
  assert.equal(w.calls.updated.length, 0);
});

test('the moved tab reporting back is swallowed (no ping-pong)', async () => {
  const w = loadWorker({ tabs: [TV(1), SCR(2, 'RELIANCE')] });
  await w.send({ type: 'link.symbol', from: 'tv', symbol: 'INFY.NS' }, 1);
  const echo = await w.send({ type: 'link.symbol', from: 'screener', symbol: 'INFY' }, 2);
  assert.equal(echo.data.reason, 'echo');
  assert.equal(w.calls.sent.length, 0);
});

test('a Screener company page brings the chart to it', async () => {
  const w = loadWorker({ tabs: [TV(1), SCR(2, 'TCS')] });
  const res = await w.send({ type: 'link.symbol', from: 'screener', symbol: 'TCS' }, 2);
  assert.equal(res.data.linked, true);
  // The message is built inside the vm realm (other Object prototype) — compare by value.
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.sent)), [{ id: 1, msg: { type: 'plutus:switch-symbol', symbol: 'TCS.NS' } }]);
});

test('linking switched off does nothing', async () => {
  const w = loadWorker({ settings: { linkTabs: false }, tabs: [TV(1), SCR(2, 'RELIANCE')] });
  const res = await w.send({ type: 'link.symbol', from: 'tv', symbol: 'INFY.NS' }, 1);
  assert.equal(res.data.reason, 'off');
  assert.equal(w.calls.updated.length + w.calls.sent.length, 0);
});

test('prefers the Screener tab visible in another window over a background tab', async () => {
  const w = loadWorker({ tabs: [TV(1), SCR(2, 'AAA', { active: false, windowId: 1, lastAccessed: 9e12 }), SCR(3, 'BBB', { active: true, windowId: 2, lastAccessed: 1 })] });
  await w.send({ type: 'link.symbol', from: 'tv', symbol: 'INFY.NS' }, 1);
  assert.equal(w.calls.updated[0].id, 3);
});

test('auto-consolidated off keeps a standalone tab standalone', async () => {
  const w = loadWorker({ settings: { scrAutoConsolidated: false }, tabs: [TV(1), { id: 2, url: 'https://www.screener.in/company/TCS/', active: true, windowId: 2 }] });
  await w.send({ type: 'link.symbol', from: 'tv', symbol: 'INFY.NS' }, 1);
  assert.equal(w.calls.updated[0].url, 'https://www.screener.in/company/INFY/');
});

test('symbol converters', () => {
  const ctx = { self: {} }; ctx.self = ctx; vm.createContext(ctx);
  vm.runInContext(read('shared/symbols.js'), ctx);
  const S = ctx.PlutusSymbols;
  assert.equal(S.toPlutus('NSE:M_M'), 'M&M.NS');
  assert.equal(S.toPlutus('500325'), '500325.BO');
  assert.equal(S.toTradingView('BAJAJ-AUTO.NS'), 'NSE:BAJAJ_AUTO');
  assert.equal(S.toPlutusUrl('http://localhost:5173/', 'INFY'), 'http://localhost:5173/stocks/INFY.NS');
  assert.equal(S.toPlutus('bad symbol!'), null);
});

test('US tickers go to their own exchange, never NSE', () => {
  const ctx = { self: {} }; ctx.self = ctx; vm.createContext(ctx);
  vm.runInContext(read('shared/symbols.js'), ctx);
  const S = ctx.PlutusSymbols;
  // Unknown bare ticker is Indian, exactly as before.
  assert.equal(S.toPlutus('NVDA'), 'NVDA.NS');
  S.registerUs([{ symbol: 'NVDA', exchange: 'NASDAQ' }, { symbol: 'CAT', exchange: 'NYSE' },
    { symbol: 'BRK-B', exchange: 'NYSE' }, { symbol: 'WMT' }, { symbol: 'TCS.NS', exchange: 'NSE' }]);
  assert.equal(S.toPlutus('NVDA'), 'NVDA');
  assert.equal(S.toPlutus('nasdaq:nvda'), 'NVDA');
  assert.equal(S.toTradingView('NVDA'), 'NASDAQ:NVDA');
  assert.equal(S.toTradingView('CAT'), 'NYSE:CAT');
  assert.equal(S.toTradingView('BRK-B'), 'NYSE:BRK.B');
  assert.equal(S.toPlutus('BRK.B'), 'BRK-B');
  assert.equal(S.toTradingView('WMT'), 'WMT');                 // exchange unknown -> bare ticker
  assert.equal(S.toPlain('NVDA'), 'NVDA');
  assert.equal(S.toTradingViewUrl('NVDA'), 'https://www.tradingview.com/chart/?symbol=NASDAQ%3ANVDA');
  assert.equal(S.toScreenerUrl('NVDA'), null);                 // Screener has no US pages
  assert.equal(S.toPlutusUrl('http://localhost:5173', 'NVDA'), 'http://localhost:5173/stocks/NVDA');
  // A prefix names the exchange even for a ticker nobody registered.
  assert.equal(S.toPlutus('NYSE:GE'), 'GE');
  assert.equal(S.toTradingView('GE'), 'NYSE:GE');
  // Indian spellings are untouched; an explicit market wins over the registry.
  assert.equal(S.toTradingView('TCS'), 'NSE:TCS');
  assert.equal(S.toPlutus('NSE:CAT'), 'CAT.NS');
  assert.equal(S.toPlutus('CAT', { market: 'IN' }), 'CAT.NS');
  assert.deepEqual(Array.from(S.parseList('NVDA, TCS NASDAQ:AMAT')), ['NVDA', 'TCS.NS', 'AMAT']);
});

// ---- notes (F4) -------------------------------------------------------------
const okJson = (data) => async () => ({ ok: true, status: 200, json: async () => data });

test('notes.update sends only content / note_date as a PUT with the auth header', async () => {
  const w = loadWorker({ settings: { token: 'owner.tok' }, fetch: okJson({ note: { id: 7 } }) });
  const res = await w.send({ type: 'notes.update', id: 7, patch: { content: 'edited', note_date: '2026-11-20', symbol: 'HACK' } });
  assert.equal(res.ok, true);
  assert.equal(w.calls.fetched.length, 1);
  const f = w.calls.fetched[0];
  assert.equal(f.url, 'http://api.test/api/journal/notes/7');
  assert.equal(f.method, 'PUT');
  assert.deepEqual(f.body, { content: 'edited', note_date: '2026-11-20' });
  assert.equal(f.headers['X-Plutus-Auth'], 'owner.tok');
});

test('notes.delete is a DELETE on the note id', async () => {
  const w = loadWorker({ settings: { token: 'owner.tok' }, fetch: okJson({ deleted: 7 }) });
  const res = await w.send({ type: 'notes.delete', id: 7 });
  assert.equal(res.ok, true);
  assert.deepEqual(w.calls.fetched.map((f) => [f.method, f.url]), [['DELETE', 'http://api.test/api/journal/notes/7']]);
});

test('notes need a token; an empty patch is refused before any network call', async () => {
  const noTok = loadWorker({ fetch: okJson({}) });
  const r1 = await noTok.send({ type: 'notes.update', id: 7, patch: { content: 'x' } });
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 401);
  const tok = loadWorker({ settings: { token: 't' }, fetch: okJson({}) });
  const r2 = await tok.send({ type: 'notes.update', id: 7, patch: {} });
  assert.equal(r2.ok, false);
  assert.equal(tok.calls.fetched.length, 0);
});

test('notes.list clamps the limit and asks for the plain symbol', async () => {
  const w = loadWorker({ settings: { token: 't' }, fetch: okJson({ notes: [] }) });
  await w.send({ type: 'notes.list', symbol: 'TCS.NS', limit: 200 });
  assert.equal(w.calls.fetched[0].url, 'http://api.test/api/journal/notes?symbol=TCS&limit=200');
  await w.send({ type: 'notes.list', symbol: 'TCS.NS', limit: 99999 });
  assert.equal(w.calls.fetched[1].url, 'http://api.test/api/journal/notes?symbol=TCS&limit=2000');
});

test('journal calls carry the market: US symbols ask for market=US, open lots merge both markets', async () => {
  const w = loadWorker({ settings: { token: 't' }, fetch: okJson({ notes: [], trades: [{ symbol: 'X' }], positions: [{ symbol: 'Y' }] }) });
  w.store.plutus_cache_bootstrap = { fetchedAt: Date.now(), apiUrl: 'http://api.test', data: { stocks: [{ symbol: 'NVDA', exchange: 'NASDAQ' }] } };
  await w.send({ type: 'notes.list', symbol: 'NVDA', limit: 50 });
  assert.equal(w.calls.fetched[0].url, 'http://api.test/api/journal/notes?symbol=NVDA&limit=50&market=US');
  await w.send({ type: 'notes.create', symbol: 'NVDA', content: 'x', note_date: '2026-11-21' });
  assert.deepEqual(w.calls.fetched[1].body, { symbol: 'NVDA', content: 'x', note_date: '2026-11-21', market: 'US' });
  await w.send({ type: 'notes.create', symbol: 'TCS.NS', content: 'y', note_date: '2026-11-21' });
  assert.equal(w.calls.fetched[2].body.market, 'IN');
  const lots = await w.send({ type: 'trades.open' });
  const urls = w.calls.fetched.slice(3).map((f) => f.url).sort();
  assert.deepEqual(urls, ['http://api.test/api/journal/trades?status=OPEN', 'http://api.test/api/journal/trades?status=OPEN&market=US']);
  assert.equal(lots.data.trades.length, 2);                      // IN + US merged
  const pos = await w.send({ type: 'positions' });
  assert.equal(pos.data.positions.length, 2);
});

test('trades.forSymbol bundles lots, opportunities (filtered to the symbol) and plans', async () => {
  const w = loadWorker({ settings: { token: 't' }, fetch: async (url) => {
    if (url.includes('/trades')) return okJson({ trades: [{ symbol: 'TCS', status: 'OPEN', qty: 10 }, { symbol: 'TCS', status: 'CLOSED', qty: 5 }] })();
    if (url.includes('/opportunities')) return okJson({ opportunities: [{ symbol: 'TCS', status: 'ACTIVE' }, { symbol: 'INFY', status: 'ACTIVE' }] })();
    return okJson({ plans: [{ id: 1 }] })();
  } });
  const res = await w.send({ type: 'trades.forSymbol', symbol: 'TCS.NS' });
  assert.equal(res.ok, true);
  const d = JSON.parse(JSON.stringify(res.data));
  assert.equal(d.symbol, 'TCS');
  assert.equal(d.market, 'IN');
  assert.equal(d.open.length, 1);
  assert.equal(d.closed.length, 1);
  assert.deepEqual(d.opportunities, [{ symbol: 'TCS', status: 'ACTIVE' }]);
  assert.equal(d.plans.length, 1);
  assert.ok(w.calls.fetched.some((f) => f.url === 'http://api.test/api/journal/trades?symbol=TCS'));
  assert.ok(w.calls.fetched.some((f) => f.url === 'http://api.test/api/sizing/plans?symbol=TCS'));
});

test('live.quotes is off by setting, and otherwise goes through the scanner client', async () => {
  const off = loadWorker({ settings: { tvLivePrices: false } });
  const r0 = await off.send({ type: 'live.quotes', symbols: ['INFY.NS'] });
  assert.equal(r0.data.off, true);
  const on = loadWorker({ settings: { tvLivePrices: true }, fetch: okJson({ data: [{ s: 'NSE:INFY', d: [1500, 0.5, 7.5] }] }) });
  const r1 = await on.send({ type: 'live.quotes', symbols: ['INFY.NS', 'INFY.NS', 'bad symbol!'] });
  assert.equal(r1.data.quotes['INFY.NS'].close, 1500);
  assert.equal(on.calls.fetched.length, 1);
  assert.equal(on.calls.fetched[0].url, 'https://scanner.tradingview.com/india/scan');
  assert.deepEqual(on.calls.fetched[0].body, { symbols: { tickers: ['NSE:INFY'] }, columns: ['close', 'change', 'change_abs'] });
});

test('a 401 while holding a token flags it as rejected, tells the panels, and a later success clears it', async () => {
  let status = 401;
  const w = loadWorker({ settings: { token: 'stale.tok' }, tabs: [TV(1)], fetch: async () => ({ ok: status === 200, status, json: async () => (status === 200 ? { notes: [] } : { detail: 'Sign in required' }) }) });
  const r1 = await w.send({ type: 'notes.list', symbol: 'TCS.NS' });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /rejected the saved token/);
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.sent)), [{ id: 1, msg: { type: 'plutus:token-state', rejected: true } }]);
  assert.equal((await w.send({ type: 'token.state' })).data.rejected, true);
  status = 200;
  await w.send({ type: 'notes.list', symbol: 'TCS.NS' });
  assert.equal((await w.send({ type: 'token.state' })).data.rejected, false);
  assert.equal(w.calls.sent.length, 2);
  assert.equal(w.calls.sent[1].msg.rejected, false);
});

test('without a token a 401 is just "sign in required" — nothing is flagged', async () => {
  const w = loadWorker({ tabs: [TV(1)], fetch: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'Sign in required' }) }) });
  const r = await w.send({ type: 'api', path: '/api/journal/notes' });
  assert.equal(r.status, 401);
  assert.equal(w.calls.sent.length, 0);
  assert.equal((await w.send({ type: 'token.state' })).data.rejected, false);
});

test('local watchlists keep a colour; a bad colour is refused; the API gets it in the body', async () => {
  const local = loadWorker();
  const created = await local.send({ type: 'watchlist.create', name: 'Banks', symbols: ['HDFCBANK'], color: '#2962FF' });
  assert.equal(created.data.color, '#2962ff');
  const upd = await local.send({ type: 'watchlist.update', id: created.data.id, patch: { color: null } });
  assert.equal(upd.data.color, null);
  const bad = await local.send({ type: 'watchlist.update', id: created.data.id, patch: { color: 'blue' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  const api = loadWorker({ settings: { token: 't' }, fetch: okJson({ watchlist: { id: 9, name: 'Banks', color: '#2962ff' } }) });
  await api.send({ type: 'watchlist.create', name: 'Banks', symbols: [], color: '#2962ff' });
  assert.deepEqual(api.calls.fetched[0].body, { name: 'Banks', symbols: [], color: '#2962ff' });
});

// ---- token bridge on the deployed web app (F5) ------------------------------
test('bridge: a deployed web-app origin with permission gets the bridge registered', async () => {
  const w = loadWorker({ settings: { webAppUrl: 'https://plutus.example.app/stocks' }, granted: ['https://plutus.example.app/*'] });
  const res = await w.send({ type: 'bridge.register' });
  assert.equal(res.data.registered, true);
  assert.equal(w.calls.registered.length, 1);
  const def = JSON.parse(JSON.stringify(w.calls.registered[0]));
  assert.deepEqual(def.matches, ['https://plutus.example.app/*']);
  assert.deepEqual(def.js, ['shared/settings.js', 'webapp/token_bridge.js']);
  assert.equal(w.calls.unregistered.length, 1);               // the previous registration is replaced
});

test('bridge: localhost needs no registration (the manifest already covers it)', async () => {
  const w = loadWorker({ settings: { webAppUrl: 'http://localhost:5173' }, granted: ['http://localhost/*'] });
  const res = await w.send({ type: 'bridge.register' });
  assert.equal(res.data.registered, false);
  assert.equal(w.calls.registered.length, 0);
});

test('bridge: without the host permission nothing is registered and the reason says so', async () => {
  const w = loadWorker({ settings: { webAppUrl: 'https://plutus.example.app' } });
  const res = await w.send({ type: 'bridge.register' });
  assert.equal(res.data.registered, false);
  assert.match(res.data.reason, /permission/);
  assert.equal(w.calls.registered.length, 0);
});

test('a US chart never drags the Screener tab along', async () => {
  const w = loadWorker({ tabs: [TV(1), SCR(2, 'RELIANCE')] });
  w.store.plutus_cache_bootstrap = { fetchedAt: Date.now(), apiUrl: 'http://api.test', data: { stocks: [{ symbol: 'NVDA', exchange: 'NASDAQ' }] } };
  const res = await w.send({ type: 'link.symbol', from: 'tv', symbol: 'NVDA' }, 1);
  assert.equal(res.data.linked, false);
  assert.equal(w.calls.updated.length, 0);
});
