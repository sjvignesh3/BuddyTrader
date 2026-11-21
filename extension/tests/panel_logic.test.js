// Plutus Companion — tests for the pure panel helpers (shared/panel_logic.js).
// Run:  node --test extension/tests
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function load() {
  const ctx = { self: {} }; ctx.self = ctx; vm.createContext(ctx);
  vm.runInContext(read('shared/symbols.js'), ctx);
  vm.runInContext(read('shared/panel_logic.js'), ctx);
  return ctx.PlutusPanelLogic;
}
// Objects built inside the vm realm have another Object prototype: compare by value.
const plain = (v) => JSON.parse(JSON.stringify(v));

const STOCKS = [
  { symbol: 'TCS.NS', market: 'IN', pools: ['F40'], sector: 'Technology', sector_group: null, cap: 'Large', market_cap: '1200000000000' },
  { symbol: 'HDFCBANK.NS', market: 'IN', pools: ['F40'], sector: 'Financial Services', sector_group: 'Banks', cap: 'Large' },
  { symbol: 'BAJFINANCE.NS', market: 'IN', pools: ['E40'], sector: 'Financial Services', sector_group: 'NBFC', cap: 'Large' },
  { symbol: 'CELLO.NS', market: 'IN', pools: ['S200'], sector: 'Consumer Cyclical', cap: 'Small' },
  { symbol: 'NVDA', market: 'US', pools: ['USMEGA'], sector: 'Technology', market_cap: '4500000000000' },
  { symbol: 'CAT', market: 'US', pools: ['USMEGA'], sector: 'Industrials', market_cap: '180000000000' },
  { symbol: 'ETSY', market: 'US', pools: ['USMEGA'], sector: 'Consumer Cyclical', market_cap: '7000000000' },
];
const MAP = new Map(STOCKS.map((s) => [s.symbol, s]));

test('market of a stock: entry.market first, then the suffix rule', () => {
  const L = load();
  assert.equal(L.marketOfEntry(MAP.get('TCS.NS')), 'IN');
  assert.equal(L.marketOfEntry(MAP.get('NVDA')), 'US');
  assert.equal(L.marketOfEntry(null, 'INFY.NS'), 'IN');
  assert.equal(L.marketOfEntry(null, '500325.BO'), 'IN');
  assert.equal(L.marketOfEntry(null, 'XYZ'), 'IN');       // unknown bare ticker stays Indian
});

test('pool market: the API field wins, else the majority of members', () => {
  const L = load();
  assert.equal(L.poolMarket({ code: 'USMEGA', market: 'US' }, []), 'US');
  assert.equal(L.poolMarket({ code: 'USMEGA' }, STOCKS), 'US');
  assert.equal(L.poolMarket({ code: 'F40' }, STOCKS), 'IN');
  assert.equal(L.poolMarket({ code: 'PlayArea' }, STOCKS), 'IN');   // empty pool -> IN
});

test('watchlist market and visibility per region', () => {
  const L = load();
  assert.equal(L.listMarket(['TCS.NS', 'CELLO.NS'], MAP), 'IN');
  assert.equal(L.listMarket(['NVDA'], MAP), 'US');
  assert.equal(L.listMarket(['NVDA', 'TCS.NS'], MAP), 'both');
  assert.equal(L.listMarket([], MAP), 'empty');
  assert.equal(L.listVisibleIn('US', 'IN'), false);
  assert.equal(L.listVisibleIn('US', 'both'), true);
  assert.equal(L.listVisibleIn('IN', 'empty'), true);
});

test('US cap tiers from raw USD market cap; India keeps the Plutus bucket', () => {
  const L = load();
  assert.equal(L.usTier(4500e9), 'Mega');
  assert.equal(L.usTier(200e9), 'Mega');
  assert.equal(L.usTier(180e9), 'Large');
  assert.equal(L.usTier(7e9), 'Mid');
  assert.equal(L.usTier(1.5e9), 'Small');
  assert.equal(L.usTier(null), null);
  assert.equal(L.capLabel(MAP.get('NVDA')), 'Mega');
  assert.equal(L.capLabel(MAP.get('ETSY')), 'Mid');
  assert.equal(L.capLabel(MAP.get('TCS.NS')), 'Large');     // 1.2 trillion rupees is not a US tier
  assert.deepEqual(plain(L.capBuckets('US')), ['Mega', 'Large', 'Mid', 'Small']);
  assert.deepEqual(plain(L.capBuckets('IN')), ['Large', 'Mid', 'Small']);
  assert.equal(L.capMatches('Small', 'Micro'), true);
  assert.equal(L.capMatches('All', null), true);
  assert.equal(L.capMatches('Large', 'Mid'), false);
});

test('sector grouping: India prefers sector_group, US uses sector; counts sorted', () => {
  const L = load();
  assert.equal(L.sectorOf(MAP.get('HDFCBANK.NS')), 'Banks');
  assert.equal(L.sectorOf(MAP.get('TCS.NS')), 'Technology');
  assert.equal(L.sectorOf({ symbol: 'MARICO.NS', market: 'IN', sector: 'Consumer Defensive', sector_group: 'Normal' }), 'Consumer Defensive');
  assert.equal(L.sectorOf(MAP.get('NVDA')), 'Technology');
  assert.equal(L.sectorOf({ symbol: 'X.NS', sector: '  ' }), null);
  const { sectors, none } = L.sectorCounts(STOCKS.concat([{ symbol: 'Y.NS' }]));
  assert.equal(none, 1);
  // count desc, then name: the two 2-counts come alphabetically
  assert.deepEqual(plain(sectors.slice(0, 3)), [['Consumer Cyclical', 2], ['Technology', 2], ['Banks', 1]]);
});

test('comparator: missing values sink, text keys sort alphabetically, direction flips', () => {
  const L = load();
  const rows = [
    { plain: 'B', below: 5, points: 9 },
    { plain: 'A', below: null, points: 3 },
    { plain: 'C', below: 12, points: null },
  ];
  assert.deepEqual(rows.slice().sort(L.comparator('dma', 'desc')).map((r) => r.plain), ['C', 'B', 'A']);
  assert.deepEqual(rows.slice().sort(L.comparator('dma', 'asc')).map((r) => r.plain), ['B', 'C', 'A']);
  assert.deepEqual(rows.slice().sort(L.comparator('score')).map((r) => r.plain), ['B', 'A', 'C']);
  assert.deepEqual(rows.slice().sort(L.comparator('default')).map((r) => r.plain), ['A', 'B', 'C']);
  assert.deepEqual(rows.slice().sort(L.comparator('name', 'desc')).map((r) => r.plain), ['C', 'B', 'A']);
  assert.deepEqual(rows.slice().sort(L.comparator('nonsense')).map((r) => r.plain), ['A', 'B', 'C']);
});

test('conviction rank orders signal, then score, then DMA depth', () => {
  const L = load();
  const buy = { plain: 'X', status: 'BUY_ZONE', points: 5, below: 0 };
  const opp = { plain: 'Y', status: 'OPPORTUNITY', points: 11, below: 20 };
  const none = { plain: 'Z', status: null, points: 11, below: 30 };
  assert.ok(L.rankValue(buy) > L.rankValue(opp));
  assert.ok(L.rankValue(opp) > L.rankValue(none));
  assert.deepEqual([none, opp, buy].sort(L.comparator('conviction')).map((r) => r.plain), ['X', 'Y', 'Z']);
});

test('TradingView rules: per-region thresholds, saved overrides, missing data never passes', () => {
  const L = load();
  const us = L.tvThresholds({}, 'US');
  assert.equal(us.pe_max, 35);
  assert.equal(L.tvThresholds({ tvRules: { US: { pe_max: '60', junk: 1 } } }, 'US').pe_max, 60);
  assert.equal(L.tvThresholds({ tvRules: { US: { pe_max: '' } } }, 'US').pe_max, 35);       // blank keeps the default
  assert.equal(L.tvThresholds({}, 'IN').pe_max, 50);
  const d = { pe: 28, roe: 40, roic: 30, debtToEquity: 0.3, opMargin: 36, revenueYoY: 33, netIncomeYoY: -2, netMargin: null };
  const res = plain(L.evalTvRules(d, us));
  assert.deepEqual(res, { pe: true, roe: true, roic: true, de: true, opm: true, sales: true, profit: false, profitable: null });
  assert.equal(L.tvScore(res), 6);                                                          // six true; false and null do not count
  assert.equal(L.evalTvRules(null, us), null);
  assert.equal(plain(L.evalTvRules({ pe: -4 }, us)).pe, false);                             // loss-making P/E is not "cheap"
  assert.deepEqual(plain(L.TV_RULES.map((r) => r.id)), ['pe', 'roe', 'roic', 'de', 'opm', 'sales', 'profit', 'profitable']);
});

test('quick filters: cap-aware dips, buy zone, signal, held; unknown fails', () => {
  const L = load();
  const ctx = { buyZone: 14, athFall: { Large: '20', Mid: '30', Small: '40' } };
  assert.equal(L.dipRule('Mega', ctx.athFall), 20);
  assert.equal(L.dipRule('Small', ctx.athFall), 40);
  assert.equal(L.dipRule(null, null), 30);
  const row = { below: 15, off52: -45, athFall: 62, cap: 'Small', status: 'BUY_ZONE', held: { qty: 1 } };
  assert.equal(L.passesAll(['below200', 'buyzone', 'dip52', 'athdip', 'signal', 'held'], L.TECH_FILTERS, row, ctx), true);
  assert.equal(L.passesAll(['dip52'], L.TECH_FILTERS, Object.assign({}, row, { off52: -35 }), ctx), false);   // small cap needs 40 %
  assert.equal(L.passesAll(['notheld'], L.TECH_FILTERS, row, ctx), false);
  assert.equal(L.passesAll(['below200'], L.TECH_FILTERS, { below: null }, ctx), false);
  assert.equal(L.passesAll([], L.TECH_FILTERS, {}, ctx), true);
});

test('score sort falls back to the TradingView score when Plutus has none (US lists)', () => {
  const L = load();
  const rows = [{ plain: 'A', points: null, tvScore: 3 }, { plain: 'B', points: null, tvScore: 7 }, { plain: 'C', points: null, tvScore: null }];
  assert.deepEqual(rows.sort(L.comparator('score')).map((r) => r.plain), ['B', 'A', 'C']);
});

test('research links: Screener + TradingView for India, the four US sites + TradingView for US', () => {
  const ctx = { self: {} }; ctx.self = ctx; vm.createContext(ctx);
  vm.runInContext(read('shared/symbols.js'), ctx);
  vm.runInContext(read('shared/links.js'), ctx);
  ctx.PlutusSymbols.registerUs([{ symbol: 'SNDK', exchange: 'NASDAQ' }, { symbol: 'BRK-B', exchange: 'NYSE' }]);
  const inn = plain(ctx.PlutusLinks.researchLinks('M&M.NS'));
  assert.equal(inn[0].url, 'https://www.screener.in/company/M%26M/consolidated/');
  assert.ok(inn.some((l) => l.url.endsWith('#profit-loss')));
  assert.equal(inn[inn.length - 1].url, 'https://www.tradingview.com/symbols/NSE-M_M/financials-overview/');
  const us = plain(ctx.PlutusLinks.researchLinks('SNDK'));
  const urls = us.map((l) => l.url);
  assert.ok(urls.includes('https://stockanalysis.com/stocks/sndk/financials/?p=quarterly'));
  assert.ok(urls.includes('https://www.roic.ai/quote/SNDK/financials?yearRange=15'));
  assert.ok(urls.includes('https://vcpscanner.com/stock/sndk/financials'));
  assert.ok(urls.includes('https://www.stockresearch.app/stocks/SNDK'));
  assert.ok(urls.includes('https://www.tradingview.com/symbols/NASDAQ-SNDK/financials-overview/'));
  assert.ok(plain(ctx.PlutusLinks.researchLinks('BRK-B')).some((l) => l.url === 'https://stockanalysis.com/stocks/brk-b/financials/'));
  assert.equal(ctx.PlutusLinks.researchLinks('bad symbol!').length, 0);
});

test('US pages: market hint makes an unregistered ticker American', () => {
  const ctx = { self: {} }; ctx.self = ctx; vm.createContext(ctx);
  vm.runInContext(read('shared/symbols.js'), ctx);
  const S = ctx.PlutusSymbols;
  assert.equal(S.toPlutus('SNDK'), 'SNDK.NS');                    // unknown bare ticker: Indian, as before
  assert.equal(S.toPlutus('SNDK', { market: 'US' }), 'SNDK');
  assert.equal(S.toPlutus('SNDK'), 'SNDK');                       // and now remembered as US
  assert.equal(S.toTradingViewUrl('SNDK'), 'https://www.tradingview.com/chart/?symbol=SNDK');
});

test('header clicks: a new key starts at its natural direction, the same key flips', () => {
  const L = load();
  assert.deepEqual(plain(L.nextSort({ key: 'default', dir: 'asc' }, 'dma')), { key: 'dma', dir: 'desc' });
  assert.deepEqual(plain(L.nextSort({ key: 'dma', dir: 'desc' }, 'dma')), { key: 'dma', dir: 'asc' });
  assert.deepEqual(plain(L.nextSort({ key: 'dma', dir: 'asc' }, 'default')), { key: 'default', dir: 'asc' });
  assert.deepEqual(plain(L.nextSort(null, 'score')), { key: 'score', dir: 'desc' });
});
