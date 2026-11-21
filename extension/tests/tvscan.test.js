// Plutus Companion — tests for the TradingView scanner client (shared/tvscan.js).
// Run:  node --test extension/tests/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

function load() {
  const ctx = { self: {}, Date }; ctx.self = ctx; vm.createContext(ctx);
  vm.runInContext(read('shared/symbols.js'), ctx);
  vm.runInContext(read('shared/tvscan.js'), ctx);
  ctx.PlutusSymbols.registerUs([{ symbol: 'NVDA', exchange: 'NASDAQ' }, { symbol: 'CAT', exchange: 'NYSE' }]);
  return ctx;
}
const okResponse = (data) => ({ ok: true, status: 200, json: async () => ({ totalCount: data.length, data }) });

test('requests: one per region, TradingView tickers, batches of 200, bare tickers skipped', () => {
  const T = load().PlutusTvScan;
  const many = Array.from({ length: 250 }, (_, i) => 'S' + i + '.NS');
  const { requests, back } = T.buildRequests(['INFY.NS', 'M&M.NS', 'NVDA', 'CAT', 'WMT', 'NYSE:GE'].concat(many));
  // WMT is not a registered US ticker, so it reads as Indian (NSE:WMT) and rides the India batch.
  assert.deepEqual(plain(requests.map((r) => [r.region, r.tickers.length])), [['IN', 200], ['IN', 53], ['US', 3]]);
  assert.equal(requests[0].url, 'https://scanner.tradingview.com/india/scan');
  assert.equal(requests[2].url, 'https://scanner.tradingview.com/america/scan');
  assert.equal(back['NSE:M_M'], 'M&M.NS');
  assert.equal(back['NASDAQ:NVDA'], 'NVDA');
  assert.equal(back['NYSE:GE'], 'NYSE:GE');                       // keyed by what the caller passed
  assert.ok(requests[2].tickers.includes('NYSE:GE'));
  assert.equal(T.buildRequests(['bad symbol!']).requests.length, 0);
  assert.deepEqual(JSON.parse(T.requestBody(['NSE:INFY'])), { symbols: { tickers: ['NSE:INFY'] }, columns: ['close', 'change', 'change_abs'] });
});

test('response: rows map back to Plutus symbols; junk rows are dropped', () => {
  const T = load().PlutusTvScan;
  const back = { 'NSE:INFY': 'INFY.NS', 'NASDAQ:NVDA': 'NVDA' };
  const got = T.parseResponse({ data: [
    { s: 'NSE:INFY', d: [1520.35, -0.86, -13.2] },
    { s: 'NASDAQ:NVDA', d: [182.11, null, null] },
    { s: 'NSE:UNKNOWN', d: [1, 2, 3] },
    { s: 'NSE:INFY2', d: null },
  ] }, back, 1000);
  assert.deepEqual(plain(got), { 'INFY.NS': { close: 1520.35, chgPct: -0.86, chg: -13.2, at: 1000 }, NVDA: { close: 182.11, chgPct: null, chg: null, at: 1000 } });
  assert.deepEqual(plain(T.parseResponse(null, back)), {});
});

test('quotes: cached within the TTL, re-fetched after it', async () => {
  const ctx = load(); const T = ctx.PlutusTvScan;
  let calls = 0;
  const fetchFn = async () => { calls++; return okResponse([{ s: 'NSE:INFY', d: [1500, 0.5, 7.5] }]); };
  const a = await T.quotes(['INFY.NS'], fetchFn);
  const b = await T.quotes(['INFY.NS'], fetchFn);
  assert.equal(calls, 1);
  assert.equal(a.quotes['INFY.NS'].close, 1500);
  assert.equal(b.quotes['INFY.NS'].close, 1500);
  assert.equal(b.degraded, false);
  T._state.cache.get('INFY.NS').at -= T.QUOTE_TTL_MS + 1;        // age the quote
  await T.quotes(['INFY.NS'], fetchFn);
  assert.equal(calls, 2);
});

test('quotes: a failing region backs off, reports degraded and serves the stale quote', async () => {
  const ctx = load(); const T = ctx.PlutusTvScan;
  let calls = 0;
  const good = async () => { calls++; return okResponse([{ s: 'NSE:INFY', d: [1500, 0.5, 7.5] }]); };
  const bad = async () => { calls++; return { ok: false, status: 429, json: async () => ({}) }; };
  await T.quotes(['INFY.NS'], good);
  T._state.cache.get('INFY.NS').at -= T.QUOTE_TTL_MS + 1;
  const r = await T.quotes(['INFY.NS'], bad);
  assert.equal(r.degraded, true);
  assert.match(r.error, /429/);
  assert.equal(r.quotes['INFY.NS'].stale, true);                 // last good price still shown
  assert.equal(r.quotes['INFY.NS'].close, 1500);
  assert.ok(T._state.backoff.IN.until > Date.now());
  const again = await T.quotes(['INFY.NS'], bad);                 // paused: no network call
  assert.equal(calls, 2);
  assert.equal(again.degraded, true);
  // US is independent of the Indian back-off
  const us = await T.quotes(['NVDA'], async () => { calls++; return okResponse([{ s: 'NASDAQ:NVDA', d: [182, 2.3, 4.1] }]); });
  assert.equal(us.quotes.NVDA.close, 182);
  assert.equal(calls, 3);
});

test('fundamentals: one request, named fields, derived distances, 1 h cache, never throws', async () => {
  const T = load().PlutusTvScan;
  let calls = 0;
  const d = ['NVIDIA', 180, 2.3, 150, 200, 90, 210, 4.4e12, 45.2, 30.1, 90.5, 60.2, 0.4, 62.1, 55.3, 60.0, 70.0, 3.9, 0.02, 'Technology', 'Semiconductors'];
  const fetchFn = async (url, opts) => { calls++; assert.equal(url, 'https://scanner.tradingview.com/america/scan'); assert.deepEqual(JSON.parse(opts.body).columns, plain(T.FUND_COLUMNS)); return { ok: true, status: 200, json: async () => ({ data: [{ s: 'NASDAQ:NVDA', d }] }) }; };
  const r = await T.fundamentals('NVDA', fetchFn);
  assert.equal(r.error, null);
  assert.equal(r.data.name, 'NVIDIA');
  assert.equal(r.data.pe, 45.2);
  assert.equal(r.data.sector, 'Technology');
  assert.equal(Math.round(r.data.dist200 * 10) / 10, 20);        // 180 vs SMA200 150 -> +20 %
  assert.equal(Math.round(r.data.off52 * 10) / 10, -10);       // 180 vs 200
  const again = await T.fundamentals('NVDA', fetchFn);
  assert.equal(again.cached, true);
  assert.equal(calls, 1);
  const bad = await T.fundamentals('INFY.NS', async () => ({ ok: false, status: 500 }));
  assert.equal(bad.data, null);
  assert.match(bad.error, /500/);
  const bare = await T.fundamentals('bad symbol!', fetchFn);
  assert.equal(bare.data, null);
  assert.equal(calls, 1);
});

test('fundamentalsBatch: one request per region, per-stock cache, misses remembered', async () => {
  const T = load().PlutusTvScan;
  const row = (s, pe) => ({ s, d: ['X', 100, 1, 90, 120, 80, 150, 1e12, pe, 3, 20, 18, 0.2, 25, 15, 10, 12, 4, 1, 'Tech', 'Chips'] });
  const calls = [];
  const fetchFn = async (url, opts) => {
    const tickers = JSON.parse(opts.body).symbols.tickers;
    calls.push([url, tickers.length]);
    const data = tickers.filter((t) => t !== 'NYSE:CAT').map((t) => row(t, 20));      // CAT "not on TradingView"
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const r = await T.fundamentalsBatch(['INFY.NS', 'TCS.NS', 'NVDA', 'CAT'], fetchFn);
  assert.equal(calls.length, 2);                                   // India + America
  assert.equal(r.data['INFY.NS'].pe, 20);
  assert.equal(r.data.NVDA.sector, 'Tech');
  assert.equal(r.data.CAT, null);
  const again = await T.fundamentalsBatch(['INFY.NS', 'CAT'], fetchFn);
  assert.equal(calls.length, 2);                                   // both answered from the cache, the miss included
  assert.equal(again.data['INFY.NS'].pe, 20);
  const bad = await T.fundamentalsBatch(['HDFCBANK.NS'], async () => ({ ok: false, status: 429 }));
  assert.match(bad.error, /429/);
});

test('quotes: a thrown fetch never rejects', async () => {
  const T = load().PlutusTvScan;
  const r = await T.quotes(['INFY.NS'], async () => { throw new Error('offline'); });
  assert.equal(r.degraded, true);
  assert.equal(r.error, 'offline');
  assert.deepEqual(plain(r.quotes), {});
});
