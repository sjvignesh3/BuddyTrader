/**
 * Plutus Companion — pure helpers for the TradingView panel.
 *
 * No DOM, no chrome.*: everything here takes plain data and returns plain
 * data, so `extension/tests/panel_logic.test.js` can run it in Node.
 *
 *  - markets: which market a stock / pool / watchlist belongs to (IN or US)
 *  - cap tiers: the US Mega / Large / Mid / Small display tier from market cap
 *  - sectors: the grouping label per stock and the counts for a slicer
 *  - sorting: one comparator for the column headers and the sort select
 */
(function (root) {
  'use strict';

  const IN = 'IN', US = 'US';

  // US market cap (raw USD, from Yahoo) -> display tier. Display only: the
  // sizing rules still treat every US stock as "Large" (plutus/markets.py).
  const US_TIERS = [[200e9, 'Mega'], [10e9, 'Large'], [2e9, 'Mid']];

  function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Market of one stock entry (bootstrap) or symbol: the entry's `market`, else the suffix rule. */
  function marketOfEntry(entry, symbol) {
    if (entry && (entry.market === US || entry.market === IN)) return entry.market;
    const s = String(symbol || (entry && entry.symbol) || '');
    if (/\.(NS|BO)$/i.test(s)) return IN;
    // A bare ticker is US only when the registry knows it (toPlutus keeps it bare); otherwise it is Indian.
    const P = root.PlutusSymbols;
    if (P && typeof P.toPlutus === 'function' && typeof P.isUs === 'function') {
      const canon = P.toPlutus(s);
      return canon && P.isUs(canon) ? US : IN;
    }
    return IN;
  }

  /**
   * Market of a pool: its own `market` when the API sends one (migration 026),
   * else the majority market of its member stocks, else IN.
   */
  function poolMarket(pool, stocks) {
    if (pool && (pool.market === US || pool.market === IN)) return pool.market;
    let us = 0, inn = 0;
    (stocks || []).forEach((s) => {
      if (!(s.pools || []).includes(pool && pool.code)) return;
      if (marketOfEntry(s) === US) us++; else inn++;
    });
    return us > inn ? US : IN;
  }

  /**
   * Market of a symbol list: 'IN' | 'US' | 'both' | 'empty'. A list is shown in a
   * region when it is that region's, mixed, or empty (so a fresh list can be filled).
   */
  function listMarket(symbols, stocksMap) {
    let us = 0, inn = 0;
    (symbols || []).forEach((sym) => {
      const e = stocksMap && typeof stocksMap.get === 'function' ? stocksMap.get(sym) : null;
      if (marketOfEntry(e, sym) === US) us++; else inn++;
    });
    if (!us && !inn) return 'empty';
    if (us && inn) return 'both';
    return us ? US : IN;
  }
  function listVisibleIn(region, lm) { return lm === region || lm === 'both' || lm === 'empty'; }

  /** US display tier from raw USD market cap; null when unknown. */
  function usTier(marketCap) {
    const m = num(marketCap);
    if (m == null || m <= 0) return null;
    for (const [floor, name] of US_TIERS) if (m >= floor) return name;
    return 'Small';
  }

  /** Cap label to show for a row: the Plutus bucket for IN, the USD tier for US. */
  function capLabel(entry) {
    if (!entry) return null;
    if (marketOfEntry(entry) === US) return usTier(entry.market_cap) || entry.cap || null;
    return entry.cap || null;
  }

  /** Slicer buckets for a region (Small also absorbs Micro). */
  function capBuckets(region) {
    return region === US ? ['Mega', 'Large', 'Mid', 'Small'] : ['Large', 'Mid', 'Small'];
  }
  function capMatches(filter, cap) {
    if (filter === 'All') return true;
    if (filter === 'Small') return cap === 'Small' || cap === 'Micro';
    return cap === filter;
  }

  // sector_group is the lender classification (Banks | NBFC | Normal); only the
  // lender values are useful as a sector label, "Normal" just means "not a lender".
  const LENDER_GROUPS = ['Banks', 'NBFC'];

  /** Grouping label for the sector slicer: IN lenders by sector_group (Banks, NBFC), everything else by sector. */
  function sectorOf(entry) {
    if (!entry) return null;
    const m = marketOfEntry(entry);
    const grp = entry.sector_group == null ? '' : String(entry.sector_group).trim();
    const g = m === IN && LENDER_GROUPS.includes(grp) ? grp : entry.sector;
    const s = g == null ? '' : String(g).trim();
    return s || null;
  }

  /** {name: count} over rows, sorted by count desc then name. Rows without a sector are counted under null. */
  function sectorCounts(entries) {
    const counts = new Map();
    let none = 0;
    (entries || []).forEach((e) => {
      const s = sectorOf(e);
      if (!s) { none++; return; }
      counts.set(s, (counts.get(s) || 0) + 1);
    });
    const list = Array.from(counts.entries()).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
    return { sectors: list, none };
  }

  // ---- sorting ------------------------------------------------------------------
  const SIGNAL_WEIGHT = { BUY_ZONE: 3, OPPORTUNITY: 2, VALID: 1.5 };

  /** Conviction rank used by the "Conviction" sort (signal first, then score, then DMA depth). */
  function rankValue(r) {
    const sig = r.status ? (SIGNAL_WEIGHT[r.status] || 0) : 0;
    const score = (r.points || 0) / 11;
    const depth = Math.min(Math.max(r.below || 0, 0), 30) / 100;
    return sig * 10 + score * 5 + depth;
  }

  // Sort keys -> row getter and the direction that means "best first".
  // Rows are the objects `rowFor()` builds in tv_content.js.
  const SORT_KEYS = {
    default:    { label: 'A → Z',          get: (r) => r.plain,            text: true, dir: 'asc' },
    name:       { label: 'A → Z',          get: (r) => r.plain,            text: true, dir: 'asc' },
    conviction: { label: 'Conviction',     get: rankValue,                 dir: 'desc' },
    dma:        { label: '% below 200 DMA', get: (r) => r.below,            dir: 'desc' },
    ath:        { label: '% off ATH',      get: (r) => r.athFall,          dir: 'desc' },
    high52:     { label: '% off 52w high', get: (r) => r.off52,            dir: 'desc' },
    score:      { label: 'Funda score',    get: (r) => (r.points != null ? r.points : r.tvScore), dir: 'desc' },
    chg:        { label: 'Day change %',   get: (r) => r.chgPct,           dir: 'desc' },
    mcap:       { label: 'Market cap',     get: (r) => r.mcap,             dir: 'desc' },
  };

  /**
   * Comparator for `rows.sort`. Missing values always sink to the bottom,
   * whatever the direction. `dir` defaults to the key's natural direction.
   */
  function comparator(key, dir) {
    const spec = SORT_KEYS[key] || SORT_KEYS.default;
    const d = (dir || spec.dir) === 'asc' ? 1 : -1;
    return (a, b) => {
      const va = spec.get(a), vb = spec.get(b);
      const ma = va == null || va === '', mb = vb == null || vb === '';
      if (ma && mb) return a.plain.localeCompare(b.plain);
      if (ma) return 1;
      if (mb) return -1;
      if (spec.text) return d * String(va).localeCompare(String(vb));
      return d * (va - vb) || a.plain.localeCompare(b.plain);
    };
  }

  /** Next direction when a header is clicked: same key flips, a new key starts at its natural direction. */
  function nextSort(current, key) {
    const spec = SORT_KEYS[key] || SORT_KEYS.default;
    if (current && current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
    return { key, dir: spec.dir };
  }

  // ---- on-demand filters -----------------------------------------------------------
  // Two groups besides the Plutus checks (which arrive per stock in the bootstrap):
  //  * TECH: Plutus snapshot numbers — every market, no extra data.
  //  * TV:   TradingView's fundamentals, fetched on demand for the list on screen.
  //          The only fundamentals US stocks have today. Thresholds are per region
  //          and editable; a missing value never passes.
  const TV_DEFAULTS = {
    IN: { pe_max: 50, roe_min: 15, roic_min: 15, de_max: 0.5, opm_min: 15 },
    US: { pe_max: 35, roe_min: 15, roic_min: 12, de_max: 1.0, opm_min: 15 },
  };
  function tvThresholds(settings, region) {
    const saved = (settings && settings.tvRules && settings.tvRules[region]) || {};
    const out = Object.assign({}, TV_DEFAULTS[region === US ? US : IN]);
    Object.keys(out).forEach((k) => { const v = num(saved[k]); if (v != null) out[k] = v; });
    return out;
  }
  const TV_RULES = [
    { id: 'pe', label: (t) => 'P/E < ' + t.pe_max, test: (d, t) => (d.pe == null ? null : d.pe > 0 && d.pe < t.pe_max) },
    { id: 'roe', label: (t) => 'ROE ≥ ' + t.roe_min + '%', test: (d, t) => (d.roe == null ? null : d.roe >= t.roe_min) },
    { id: 'roic', label: (t) => 'ROIC ≥ ' + t.roic_min + '%', test: (d, t) => (d.roic == null ? null : d.roic >= t.roic_min) },
    { id: 'de', label: (t) => 'D/E ≤ ' + t.de_max, test: (d, t) => (d.debtToEquity == null ? null : d.debtToEquity <= t.de_max) },
    { id: 'opm', label: (t) => 'OPM ≥ ' + t.opm_min + '%', test: (d, t) => (d.opMargin == null ? null : d.opMargin >= t.opm_min) },
    { id: 'sales', label: () => 'Sales growth', test: (d) => (d.revenueYoY == null ? null : d.revenueYoY > 0) },
    { id: 'profit', label: () => 'Profit growth', test: (d) => (d.netIncomeYoY == null ? null : d.netIncomeYoY > 0) },
    { id: 'profitable', label: () => 'Profitable', test: (d) => (d.netMargin == null ? null : d.netMargin > 0) },
  ];
  /** {ruleId: true|false|null} for one stock's TradingView fundamentals (null data -> null). */
  function evalTvRules(data, t) {
    if (!data) return null;
    const out = {};
    TV_RULES.forEach((r) => { out[r.id] = r.test(data, t); });
    return out;
  }
  function tvScore(res) { return res ? Object.values(res).filter((v) => v === true).length : null; }

  /** Cap-aware dip rule (Plutus ath_fall_pct_by_cap); US Mega counts as Large. */
  function dipRule(cap, athFallByCap) {
    const R = Object.assign({ Large: 20, Mid: 30, Small: 40, Micro: 40 }, athFallByCap || {});
    const key = cap === 'Mega' ? 'Large' : cap;
    const v = num(R[key]);
    return v != null ? v : 30;
  }
  const TECH_FILTERS = [
    { id: 'below200', label: () => 'Below 200 DMA', test: (r) => (r.below == null ? null : r.below > 0) },
    { id: 'buyzone', label: (c) => 'Buy zone (≥ ' + c.buyZone + '% below)', test: (r, c) => (r.below == null ? null : r.below >= c.buyZone) },
    { id: 'dip52', label: () => '52W dip ≥ cap rule', test: (r, c) => (r.off52 == null ? null : Math.abs(r.off52) >= dipRule(r.cap, c.athFall)) },
    { id: 'athdip', label: () => 'ATH dip ≥ cap rule', test: (r, c) => (r.athFall == null ? null : Math.abs(r.athFall) >= dipRule(r.cap, c.athFall)) },
    { id: 'signal', label: () => 'Has a signal', test: (r) => !!r.status && ['BUY_ZONE', 'OPPORTUNITY', 'VALID'].includes(r.status) },
    { id: 'held', label: () => 'Held', test: (r) => !!r.held },
    { id: 'notheld', label: () => 'Not held', test: (r) => !r.held },
  ];
  /** Every selected filter id must test true (null = unknown = fails). */
  function passesAll(ids, defs, row, ctx, results) {
    return ids.every((id) => {
      const def = defs.find((x) => x.id === id);
      if (!def) return true;
      const v = results ? results[id] : def.test(row, ctx);
      return v === true;
    });
  }

  root.PlutusPanelLogic = {
    IN, US,
    marketOfEntry, poolMarket, listMarket, listVisibleIn,
    usTier, capLabel, capBuckets, capMatches,
    sectorOf, sectorCounts,
    SORT_KEYS, rankValue, comparator, nextSort,
    TV_DEFAULTS, tvThresholds, TV_RULES, evalTvRules, tvScore, dipRule, TECH_FILTERS, passesAll,
  };
})(typeof self !== 'undefined' ? self : this);
