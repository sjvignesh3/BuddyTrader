/**
 * Plutus Companion — financial-table colouring core (pure, Node-tested).
 *
 * The rules the Screener overlay applies to #profit-loss / #quarters, written
 * once so the US sites (stockanalysis.com, roic.ai, vcpscanner.com) colour
 * the same way:
 *   - value rows (revenue, profit, EPS, cash…): up vs the prior period green,
 *     down red, the row's best value dark green
 *   - expense rows: as % of revenue, lower is better; row min / max marked
 *   - reverse rows (interest, tax, depreciation, debt): lower is better
 *   - margin rows: vs prior ±0.05 pt; row peak dark green
 *   - growth % rows: fixed bands (≥ 20 dark green … ≤ −15 dark red)
 *   - liquidity ratios: fixed bands (current, quick, interest coverage)
 *   - net debt: negative = net cash (green); positive rising = red
 *   - other income / exceptional / unusual items: statistical outlier fence
 * Prior period = same quarter last year when the headers allow, else the
 * adjacent earlier column. Nothing here touches the DOM.
 */
(function (root) {
  'use strict';

  // ---- numbers -------------------------------------------------------------------
  const SUFFIX = { T: 1e12, B: 1e9, M: 1e6, K: 1e3 };
  /** "$1,234.5", "(3.2B)", "−12.4%", "1.2 T", "—" -> number | null. First line of a cell only. */
  function parseNumber(text) {
    if (text == null) return null;
    let s = String(text).split('\n')[0].trim();
    if (!s || /^(—|–|-|n\/a|na|null|upgrade)$/i.test(s)) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[−–]/g, '-').replace(/[$€£₹,\s]/g, '').replace(/%$/, '').replace(/x$/i, '');
    const m = /^(-?\d*\.?\d+)([TBMK])?$/i.exec(s);
    if (!m) return null;
    let n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    if (m[2]) n *= SUFFIX[m[2].toUpperCase()];
    return neg ? -n : n;
  }

  // ---- periods -------------------------------------------------------------------
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const yy = (s) => { const n = Number(s); return s.length === 2 ? (n >= 50 ? 1900 + n : 2000 + n) : n; };
  /**
   * Header text -> {kind, year, q|month, score} or null.
   *   "Q3 2025" / "Q3'25" / "2025 Q3"  -> quarter
   *   "Jun 2024" / "Jun'24" / "Jun-24" / "2024-06-30" -> month end (treated as a quarter)
   *   "FY2024" / "FY24" / "2024"        -> fiscal year
   *   "TTM" / "LTM" / "Current"         -> trailing (score above everything)
   * `score` orders columns in time regardless of how the site prints them.
   */
  function parsePeriod(text) {
    const s = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
    if (!s) return null;
    if (/^(ttm|ltm|trailing|current|latest)\b/i.test(s)) return { kind: 'TTM', score: 999999, label: s };
    let m;
    if ((m = /^Q([1-4])\s*['’]?\s*(\d{2}|\d{4})$/i.exec(s)) || (m = /^(?:(\d{4})\s*)?Q([1-4])(?:\s*(\d{4}))?$/i.exec(s) && m[1] ? [m[0], m[2], m[1]] : (m && m[3] ? [m[0], m[2], m[3]] : null))) {
      const q = Number(m[1]), year = yy(String(m[2]));
      return { kind: 'Q', year, q, score: year * 4 + q, label: s };
    }
    if ((m = /^(?:FY\s*['’]?)(\d{2}|\d{4})$/i.exec(s))) { const year = yy(m[1]); return { kind: 'FY', year, score: year * 4 + 4, label: s }; }
    if ((m = /^(\d{4})$/.exec(s))) { const year = Number(m[1]); if (year > 1900 && year < 2100) return { kind: 'FY', year, score: year * 4 + 4, label: s }; }
    if ((m = /^([A-Za-z]{3,4})\.?\s*['’\-]?\s*(\d{2}|\d{4})$/.exec(s)) && MON[m[1].toLowerCase()]) {
      const month = MON[m[1].toLowerCase()], year = yy(m[2]);
      return { kind: 'M', year, month, q: Math.ceil(month / 3), score: year * 4 + Math.ceil(month / 3), label: s };
    }
    if ((m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s))) {
      const year = Number(m[1]), month = Number(m[2]);
      return { kind: 'M', year, month, q: Math.ceil(month / 3), score: year * 4 + Math.ceil(month / 3), label: s };
    }
    if ((m = /^([A-Za-z]{3,4})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s)) && MON[m[1].toLowerCase()]) {
      const month = MON[m[1].toLowerCase()], year = Number(m[3]);
      return { kind: 'M', year, month, q: Math.ceil(month / 3), score: year * 4 + Math.ceil(month / 3), label: s };
    }
    return null;
  }

  /**
   * Index of the column to compare column `i` against, or -1.
   * Quarters / month-ends: the same quarter one year earlier when present
   * (YoY, what Screener does), else the nearest earlier period. Fiscal years:
   * the previous year. TTM: the latest fiscal year. Unparseable headers fall
   * back to the adjacent earlier column by detecting the table's direction.
   */
  function priorIndex(periods, i) {
    const p = periods[i];
    const known = periods.map((x, j) => (x ? j : -1)).filter((j) => j >= 0);
    if (!p || known.length < 2) {
      // direction from any two parseable headers; default newest-first (US sites) when unknown
      let newestFirst = true;
      if (known.length >= 2) newestFirst = periods[known[0]].score > periods[known[known.length - 1]].score;
      const j = newestFirst ? i + 1 : i - 1;
      return j >= 0 && j < periods.length ? j : -1;
    }
    let want = null;
    if (p.kind === 'Q' || p.kind === 'M') want = p.score - 4;
    else if (p.kind === 'FY') want = p.score - 4;
    if (want != null) {
      const exact = periods.findIndex((x, j) => x && j !== i && x.score === want && x.kind !== 'TTM');
      if (exact >= 0) return exact;
    }
    // nearest earlier period (TTM compares with the latest full period)
    let best = -1, bestScore = -Infinity;
    periods.forEach((x, j) => { if (x && j !== i && x.score < p.score && x.score > bestScore && x.kind !== 'TTM') { best = j; bestScore = x.score; } });
    return best;
  }

  // ---- row classification ------------------------------------------------------------
  const RX = {
    revenue: /^(total\s+)?(revenue|revenues|sales|net sales|turnover|total income|income from operations)\b/i,
    growth: /growth|yoy|y\/y|\bchange\b/i,
    margin: /margin|\bopm\b|\bnpm\b|\bebitda\s*%|\bebit\s*%|return on|\broe\b|\broce\b|\broic\b|\broa\b/i,
    expense: /^(cost of|cogs|cost of revenue|cost of goods|operating expenses?|opex|selling|sg&a|sga|general (and|&) admin|research|r&d|employee|staff|personnel|marketing|advertising|other (operating )?expenses?|total (operating )?expenses?|expenses)\b/i,
    reverse: /^(interest( expense)?|finance cost|depreciation|amortization|amortisation|d&a|tax(es)?( expense)?|income tax|provision for tax|total debt|long[- ]term debt|short[- ]term debt|borrowings?|debt|lease liabilit|capital expenditure|capex)\b/i,
    bankIncome: /net interest income|interest income/i,
    outlier: /other income|other non[- ]?operating|non[- ]?operating|exceptional|unusual|one[- ]?time|special item|impairment|restructuring|write[- ]?(off|down)|gain|loss on|fx |foreign exchange|currency/i,
    netDebt: /^net debt\b/i,
    current: /^current ratio/i, quick: /^quick ratio/i, coverage: /interest coverage/i,
    pct: /%|margin|ratio|growth|yield|return/i,
    skip: /^(shares|weighted|diluted shares|basic shares|dividend per|dps|payout|employees|number of)/i,
  };
  function classify(label) {
    const l = String(label || '').replace(/\s*\+\s*$/, '').trim();
    if (!l) return { type: 'SKIP' };
    if (RX.skip.test(l)) return { type: 'SKIP' };
    if (RX.current.test(l)) return { type: 'CURRENT_RATIO' };
    if (RX.quick.test(l)) return { type: 'QUICK_RATIO' };
    if (RX.coverage.test(l)) return { type: 'COVERAGE' };
    if (RX.netDebt.test(l)) return { type: 'NET_DEBT' };
    if (RX.growth.test(l)) return { type: 'GROWTH_PCT' };
    if (RX.bankIncome.test(l)) return { type: 'VALUE' };               // a bank's interest income is revenue, not a cost
    if (RX.outlier.test(l) && !RX.revenue.test(l)) return { type: 'OUTLIER' };
    if (RX.margin.test(l)) return { type: 'MARGIN' };
    if (RX.expense.test(l)) return { type: 'EXPENSE' };
    if (RX.reverse.test(l)) return { type: 'REVERSE' };
    return { type: 'VALUE', revenue: RX.revenue.test(l) };
  }

  // ---- outlier fence (Screener's) ----------------------------------------------------
  function outlierMarks(label, vals) {
    const marks = vals.map(() => null);
    const nums = vals.filter((v) => v != null);
    if (nums.length < 4) return marks;
    const sorted = nums.slice().sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    const q1 = q(.25), med = q(.5), q3 = q(.75);
    const iqr = Math.max(q3 - q1, Math.abs(med) * .2, 2);
    const nonzero = nums.filter((v) => v !== 0).map(Math.abs).sort((a, b) => a - b);
    const mnz = nonzero.length ? nonzero[Math.floor(nonzero.length / 2)] : 0;
    const exceptional = /exceptional|unusual|one[- ]?time|special|impairment|restructuring/i.test(label);
    vals.forEach((v, i) => {
      if (v == null) return;
      if (exceptional) {
        const light = Math.max(4, 1.2 * mnz), darkPos = Math.max(15, 3 * mnz), darkNeg = -Math.max(10, 2.5 * mnz);
        if (v <= darkNeg || v >= darkPos) marks[i] = { cls: 'px-c-alert', title: 'Exceptional item — extreme vs history' };
        else if (Math.abs(v) >= light) marks[i] = { cls: 'px-c-warn', title: 'Exceptional item — check the notes' };
      } else if (Math.max(...nums) - Math.min(...nums) >= 3) {
        if (v >= q3 + .2 * iqr || (v <= q1 - .5 * iqr && q1 - .5 * iqr < 0)) marks[i] = { cls: 'px-c-alert', title: 'Spike vs history (median ' + med + ')' };
        else if (v >= med + .18 * iqr || (v <= q1 - .2 * iqr && q1 - .2 * iqr < 0)) marks[i] = { cls: 'px-c-warn', title: 'Elevated vs history' };
      }
    });
    return marks;
  }

  const fmt = (v) => (Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Number(v.toFixed(2)).toString());

  /**
   * colourTable({headers, rows}) -> marks[rowIndex][colIndex] = {cls, title} | null
   *   headers: header texts for the value columns (no label column)
   *   rows:    [{label, values:[number|null]}]
   */
  function colourTable(table) {
    const periods = (table.headers || []).map(parsePeriod);
    const rows = table.rows || [];
    const revRow = rows.find((r) => classify(r.label).revenue);
    const rev = revRow ? revRow.values : [];
    const out = [];
    rows.forEach((r) => {
      const vals = r.values || [];
      const marks = vals.map(() => null);
      const c = classify(r.label);
      const set = (i, cls, title) => { if (i >= 0 && i < marks.length) marks[i] = { cls, title }; };
      const prev = (i) => { const j = priorIndex(periods, i); return j >= 0 && vals[j] != null ? j : -1; };
      const plabel = (j) => (table.headers && table.headers[j]) || 'prior';
      if (c.type === 'SKIP') { out.push(marks); return; }
      if (c.type === 'OUTLIER') { out.push(outlierMarks(r.label, vals)); return; }
      if (c.type === 'GROWTH_PCT') {
        vals.forEach((v, i) => { if (v == null) return; if (v >= 20) set(i, 'px-c-best', 'Growth ≥ 20%'); else if (v > 0) set(i, 'px-c-up', 'Growth'); else if (v <= -15) set(i, 'px-c-worst', 'Decline ≥ 15%'); else if (v < 0) set(i, 'px-c-down', 'Decline'); });
        out.push(marks); return;
      }
      if (c.type === 'CURRENT_RATIO' || c.type === 'QUICK_RATIO' || c.type === 'COVERAGE') {
        const B = c.type === 'CURRENT_RATIO' ? [2.5, 1.5, 1] : c.type === 'QUICK_RATIO' ? [1.2, 1, 0.8] : [10, 4, 2];
        vals.forEach((v, i) => { if (v == null) return; if (v >= B[0]) set(i, 'px-c-best', '≥ ' + B[0]); else if (v >= B[1]) set(i, 'px-c-up', '≥ ' + B[1]); else if (v < B[2]) set(i, 'px-c-down', '< ' + B[2]); });
        out.push(marks); return;
      }
      if (c.type === 'NET_DEBT') {
        let minI = -1, maxI = -1, min = Infinity, max = -Infinity;
        vals.forEach((v, i) => { if (v == null) return; if (v < min) { min = v; minI = i; } if (v > max) { max = v; maxI = i; } });
        vals.forEach((v, i) => {
          if (v == null) return;
          const j = prev(i);
          if (v < 0) set(i, i === minI ? 'px-c-best' : 'px-c-up', 'Net cash');
          else if (j >= 0) set(i, v > vals[j] ? 'px-c-down' : v < vals[j] ? 'px-c-up' : null, (v > vals[j] ? 'Net debt up vs ' : 'Net debt down vs ') + plabel(j));
          if (v > 0 && i === maxI && minI !== maxI) set(i, 'px-c-worst', 'Highest net debt');
        });
        out.push(marks.map((m) => (m && m.cls ? m : null))); return;
      }
      if (c.type === 'MARGIN') {
        let bestI = -1, best = -Infinity, n = 0;
        vals.forEach((v, i) => { if (v == null) return; n++; if (v > best) { best = v; bestI = i; } });
        vals.forEach((v, i) => { if (v == null) return; const j = prev(i); if (j < 0) return; const d = v - vals[j]; if (d >= 0.05) set(i, 'px-c-up', '+' + d.toFixed(1) + ' pt vs ' + plabel(j)); else if (d <= -0.05) set(i, 'px-c-down', d.toFixed(1) + ' pt vs ' + plabel(j)); });
        if (n >= 3 && bestI >= 0) set(bestI, 'px-c-best', 'Row peak');
        out.push(marks); return;
      }
      if (c.type === 'EXPENSE') {
        const ratio = (i) => (rev[i] > 0 && vals[i] != null ? Math.abs(vals[i]) / rev[i] * 100 : null);
        let bestI = -1, worstI = -1, best = Infinity, worst = -Infinity, usable = 0;
        vals.forEach((v, i) => { const q = ratio(i); if (q == null) return; usable++; if (q < best) { best = q; bestI = i; } if (q > worst) { worst = q; worstI = i; } });
        vals.forEach((v, i) => {
          if (v == null) return;
          const j = prev(i);
          if (j < 0) return;
          const cur = ratio(i), pr = ratio(j);
          if (cur != null && pr != null) set(i, cur > pr + 0.05 ? 'px-c-down' : cur < pr - 0.05 ? 'px-c-up' : 'px-c-note', cur.toFixed(1) + '% of revenue (' + plabel(j) + ': ' + pr.toFixed(1) + '%)');
          else set(i, Math.abs(v) > Math.abs(vals[j]) ? 'px-c-down' : Math.abs(v) < Math.abs(vals[j]) ? 'px-c-up' : null, 'vs ' + plabel(j));
        });
        if (usable >= 3 && bestI >= 0 && bestI !== worstI) { set(bestI, 'px-c-best', 'Lowest % of revenue'); set(worstI, 'px-c-worst', 'Highest % of revenue'); }
        out.push(marks.map((m) => (m && m.cls ? m : null))); return;
      }
      if (c.type === 'REVERSE') {
        let minI = -1, maxI = -1, min = Infinity, max = -Infinity, n = 0;
        vals.forEach((v, i) => { if (v == null) return; n++; const a = Math.abs(v); if (a < min) { min = a; minI = i; } if (a > max) { max = a; maxI = i; } });
        vals.forEach((v, i) => { if (v == null) return; const j = prev(i); if (j < 0) return; const a = Math.abs(v), b = Math.abs(vals[j]); if (a > b) set(i, 'px-c-down', 'Up vs ' + plabel(j) + ' (' + fmt(vals[j]) + ')'); else if (a < b) set(i, 'px-c-up', 'Down vs ' + plabel(j) + ' (' + fmt(vals[j]) + ')'); });
        if (n >= 3 && minI >= 0 && minI !== maxI) { if (min === 0) set(minI, 'px-c-best', 'Zero'); else set(minI, 'px-c-best', 'Lowest'); set(maxI, 'px-c-worst', 'Highest'); }
        out.push(marks); return;
      }
      // VALUE: higher is better
      let bestI = -1, best = -Infinity, n = 0;
      vals.forEach((v, i) => { if (v == null) return; n++; if (v > best) { best = v; bestI = i; } });
      vals.forEach((v, i) => { if (v == null) return; const j = prev(i); if (j < 0) return; const pv = vals[j]; if (v > pv) set(i, 'px-c-up', 'Up ' + ((v - pv) / Math.abs(pv || 1) * 100).toFixed(1) + '% vs ' + plabel(j)); else if (v < pv) set(i, 'px-c-down', 'Down ' + ((pv - v) / Math.abs(pv || 1) * 100).toFixed(1) + '% vs ' + plabel(j)); });
      if (n >= 3 && bestI >= 0) set(bestI, 'px-c-best', 'Row peak');
      out.push(marks);
    });
    return out;
  }

  // ---- P/E history from an embedded weekly series (stockresearch.app) ------------------
  /** `{start:'yyyy-mm-dd', scale, deltas:[…]}` -> [(iso, value)] weekly, cumulative. */
  function decodeDeltaSeries(start, scale, deltas) {
    const out = [];
    const t0 = new Date(String(start) + 'T00:00:00Z').getTime();
    if (!Number.isFinite(t0) || !(scale > 0) || !Array.isArray(deltas)) return out;
    let acc = 0;
    deltas.forEach((d, i) => {
      acc += Number(d) || 0;
      out.push([new Date(t0 + i * 7 * 86400000).toISOString().slice(0, 10), acc / scale]);
    });
    return out;
  }
  function seriesStats(series, years, now) {
    const cutoff = new Date((now || Date.now()) - years * 365 * 86400000).toISOString().slice(0, 10);
    const vals = series.filter(([d, v]) => d >= cutoff && v > 0).map(([, v]) => v).sort((a, b) => a - b);
    if (!vals.length) return null;
    const mid = vals.length >> 1;
    const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    return { median: Math.round(median * 10) / 10, low: Math.round(vals[0] * 10) / 10, high: Math.round(vals[vals.length - 1] * 10) / 10, n: vals.length };
  }

  root.PlutusTableColour = { parseNumber, parsePeriod, priorIndex, classify, outlierMarks, colourTable, decodeDeltaSeries, seriesStats };
})(typeof self !== 'undefined' ? self : this);
