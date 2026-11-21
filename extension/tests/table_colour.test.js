// Plutus Companion — tests for the shared financial-table colouring core.
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
  vm.runInContext(read('shared/table_colour.js'), ctx);
  return ctx.PlutusTableColour;
}
const cls = (marks) => marks.map((m) => (m ? m.cls : null));

test('numbers: currencies, brackets, suffixes, percentages, dashes', () => {
  const T = load();
  assert.equal(T.parseNumber('$1,234.5'), 1234.5);
  assert.equal(T.parseNumber('(3.2B)'), -3.2e9);
  assert.equal(T.parseNumber('26.13B'), 26.13e9);
  assert.equal(T.parseNumber('981.7M'), 981.7e6);
  assert.equal(T.parseNumber('−12.4%'), -12.4);
  assert.equal(T.parseNumber('1.8x'), 1.8);
  assert.equal(T.parseNumber('₹2,367 Cr'), null);          // Screener units are handled by the Screener script
  assert.equal(T.parseNumber('—'), null);
  assert.equal(T.parseNumber('Upgrade'), null);
  assert.equal(T.parseNumber('12.5\nsecond line ignored'), 12.5);
});

test('periods: quarters, fiscal years, month ends, TTM, and their ordering', () => {
  const T = load();
  assert.equal(T.parsePeriod('Q3 2025').score, 2025 * 4 + 3);
  assert.equal(T.parsePeriod("Q3'25").score, 2025 * 4 + 3);
  assert.equal(T.parsePeriod('FY2024').score, 2024 * 4 + 4);
  assert.equal(T.parsePeriod('FY24').score, 2024 * 4 + 4);
  assert.equal(T.parsePeriod('2024').score, 2024 * 4 + 4);
  assert.equal(T.parsePeriod("Jun'24").q, 2);
  assert.equal(T.parsePeriod('JUN 2026').score, 2026 * 4 + 2);
  assert.equal(T.parsePeriod('2024-06-30').q, 2);
  assert.equal(T.parsePeriod('Mar 31, 2025').q, 1);
  assert.equal(T.parsePeriod('TTM').kind, 'TTM');
  assert.equal(T.parsePeriod('Metric'), null);
  assert.equal(T.parsePeriod('12345'), null);
});

test('prior column: same quarter last year, previous fiscal year, TTM vs latest year, adjacent fallback', () => {
  const T = load();
  const q = ['Q3 2026', 'Q2 2026', 'Q1 2026', 'Q4 2025', 'Q3 2025', 'Q2 2025'].map(T.parsePeriod);
  assert.equal(T.priorIndex(q, 0), 4);                 // Q3 2026 -> Q3 2025
  assert.equal(T.priorIndex(q, 1), 5);
  assert.equal(T.priorIndex(q, 2), 3);                 // Q1 2026 has no Q1 2025: nearest earlier = Q4 2025
  assert.equal(T.priorIndex(q, 5), -1);                // oldest column has nothing earlier
  const y = ['TTM', "Jun'26", "Jun'25", "Jun'24"].map(T.parsePeriod);
  assert.equal(T.priorIndex(y, 0), 1);                 // TTM vs the latest full year
  assert.equal(T.priorIndex(y, 1), 2);
  const oldestFirst = ['2021', '2022', '2023'].map(T.parsePeriod);
  assert.equal(T.priorIndex(oldestFirst, 2), 1);
  const unknown = [null, null, null];
  assert.equal(T.priorIndex(unknown, 0), 1);           // newest-first default: compare with the next column
  assert.equal(T.priorIndex(unknown, 2), -1);
});

test('classification: expense, reverse, bank interest income, growth, margins, outliers, ratios', () => {
  const T = load();
  const t = (l) => T.classify(l).type;
  assert.equal(t('Revenue'), 'VALUE');
  assert.equal(T.classify('Total Revenue').revenue, true);
  assert.equal(t('Cost of Goods Sold'), 'EXPENSE');
  assert.equal(t('Selling, General & Admin'), 'EXPENSE');
  assert.equal(t('Research & Development'), 'EXPENSE');
  assert.equal(t('Interest Expense'), 'REVERSE');
  assert.equal(t('Depreciation & Amortization'), 'REVERSE');
  assert.equal(t('Income Tax'), 'REVERSE');
  assert.equal(t('Long-Term Debt'), 'REVERSE');
  assert.equal(t('Net Interest Income'), 'VALUE');      // a bank's revenue line, never a cost
  assert.equal(t('Revenue Growth %'), 'GROWTH_PCT');
  assert.equal(t('Gross Margin %'), 'MARGIN');
  assert.equal(t('Operating Margin'), 'MARGIN');
  assert.equal(t('Other Income'), 'OUTLIER');
  assert.equal(t('Unusual Items'), 'OUTLIER');
  assert.equal(t('Net Debt'), 'NET_DEBT');
  assert.equal(t('Current Ratio'), 'CURRENT_RATIO');
  assert.equal(t('Interest Coverage'), 'COVERAGE');
  assert.equal(t('Shares Outstanding (Basic)'), 'SKIP');
  assert.equal(t('Sales +'), 'VALUE');                   // Screener's expandable marker is stripped
});

test('value rows: up / down vs the same quarter last year, row peak dark green', () => {
  const T = load();
  const marks = T.colourTable({ headers: ['Q3 2026', 'Q2 2026', 'Q3 2025', 'Q2 2025'], rows: [{ label: 'Revenue', values: [120, 90, 100, 95] }] });
  // Q3 2025 has no Q3 2024 column: it falls back to the nearest earlier period (Q2 2025)
  assert.deepEqual(cls(marks[0]), ['px-c-best', 'px-c-down', 'px-c-up', null]);
  assert.match(marks[0][1].title, /Down 5\.3% vs Q2 2025/);
  assert.match(marks[0][0].title, /Row peak/);
});

test('expense rows: % of revenue vs prior, lowest / highest marked', () => {
  const T = load();
  const marks = T.colourTable({ headers: ['2026', '2025', '2024'], rows: [
    { label: 'Revenue', values: [200, 100, 100] },
    { label: 'Cost of Revenue', values: [120, 50, 60] },          // 60 %, 50 %, 60 %
  ] });
  assert.deepEqual(cls(marks[1]), ['px-c-worst', 'px-c-best', null]);   // 2026: up vs 2025 AND the row's worst -> worst wins; 2025: down vs 2024 AND best
  assert.match(marks[1][1].title, /Lowest % of revenue/);
});

test('reverse rows: lower is better; zero debt is the best', () => {
  const T = load();
  const marks = T.colourTable({ headers: ['2026', '2025', '2024'], rows: [{ label: 'Total Debt', values: [0, 50, 80] }] });
  assert.deepEqual(cls(marks[0]), ['px-c-best', 'px-c-up', 'px-c-worst']);
  assert.equal(marks[0][0].title, 'Zero');
});

test('margins, growth bands and liquidity ratios use fixed rules', () => {
  const T = load();
  const marks = T.colourTable({ headers: ['2026', '2025', '2024'], rows: [
    { label: 'Operating Margin %', values: [36.9, 32.0, 28.6] },
    { label: 'Revenue Growth %', values: [33.4, -14.5, -16.0] },
    { label: 'Current Ratio', values: [2.6, 1.6, 0.9] },
    { label: 'Interest Coverage', values: [12, 5, 1.5] },
  ] });
  assert.deepEqual(cls(marks[0]), ['px-c-best', 'px-c-up', null]);
  assert.deepEqual(cls(marks[1]), ['px-c-best', 'px-c-down', 'px-c-worst']);
  assert.deepEqual(cls(marks[2]), ['px-c-best', 'px-c-up', 'px-c-down']);
  assert.deepEqual(cls(marks[3]), ['px-c-best', 'px-c-up', 'px-c-down']);
});

test('net debt: net cash green, rising net debt red, highest marked', () => {
  const T = load();
  const marks = T.colourTable({ headers: ['2026', '2025', '2024', '2023'], rows: [{ label: 'Net Debt', values: [-500, 200, 100, 300] }] });
  assert.deepEqual(cls(marks[0]), ['px-c-best', 'px-c-down', 'px-c-up', 'px-c-worst']);
});

test('outlier rows: a spike in other income is flagged, a steady line is not', () => {
  const T = load();
  const marks = T.colourTable({ headers: ['2026', '2025', '2024', '2023', '2022'], rows: [
    { label: 'Other Income', values: [60, 5, 4, 6, 5] },
    { label: 'Other Income', values: [5, 5, 4, 6, 5] },
  ] });
  assert.equal(marks[0][0].cls, 'px-c-alert');
  assert.deepEqual(cls(marks[1]), [null, null, null, null, null]);
});

test('P/E history: cumulative weekly deltas decode and summarise', () => {
  const T = load();
  const series = T.decodeDeltaSeries('2016-01-01', 10, [200, 10, -20, 30, 0, 10]);   // 20, 21, 19, 22, 22, 23
  assert.equal(series.length, 6);
  assert.equal(series[0][0], '2016-01-01');
  assert.equal(series[1][0], '2016-01-08');
  assert.deepEqual(plain(series.map(([, v]) => v)), [20, 21, 19, 22, 22, 23]);
  const now = new Date('2016-03-01').getTime();
  assert.deepEqual(plain(T.seriesStats(series, 1, now)), { median: 21.5, low: 19, high: 23, n: 6 });
  assert.equal(T.seriesStats(series, 1, new Date('2030-01-01').getTime()), null);
  assert.equal(T.decodeDeltaSeries('bad', 10, [1]).length, 0);
});
