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
function loadWorker({ settings = {}, tabs = [] } = {}) {
  const store = { plutus_settings: Object.assign({ apiUrl: 'http://api.test', linkTabs: true, scrAutoConsolidated: true }, settings) };
  const calls = { updated: [], sent: [] };
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
      query: async (q) => tabs.filter((t) => !q.url || matches(t.url, [].concat(q.url))),
      update: async (id, props) => { calls.updated.push({ id, url: props.url }); const t = tabs.find((x) => x.id === id); if (t) t.url = props.url; return t; },
      sendMessage: async (id, msg) => { calls.sent.push({ id, msg }); },
    },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    scripting: {},
  };
  const ctx = { chrome, console, setTimeout, clearTimeout, fetch: async () => { throw new Error('no network in tests'); }, AbortController, URL };
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
