/**
 * Plutus Companion — TradingView scanner client (service worker side).
 *
 * Live quotes for the rows the panel shows. The endpoint is TradingView's own
 * unofficial scanner (what tradingview.com/screener uses); it can change or
 * rate-limit at any time, so this client:
 *   - asks for the visible symbols only, in batches, one region per request;
 *   - keeps every quote for a short time so repeated polls do not re-fetch;
 *   - backs off exponentially on any failure and reports `degraded`, and the
 *     panel then shows the nightly close instead.
 * Nothing fetched here is ever written to Plutus or used in a score: it is
 * display only. Pure request/response helpers are exported for the Node tests.
 */
(function (root) {
  'use strict';

  const HOSTS = { IN: 'https://scanner.tradingview.com/india/scan', US: 'https://scanner.tradingview.com/america/scan' };
  const COLUMNS = ['close', 'change', 'change_abs'];
  const BATCH = 200;
  const QUOTE_TTL_MS = 10 * 1000;
  const BACKOFF_MS = [15000, 30000, 60000, 120000];

  const cache = new Map();                 // symbol -> {close, chg, chgPct, at}
  const backoff = { IN: { until: 0, level: 0 }, US: { until: 0, level: 0 } };

  /** Region from the TradingView ticker itself: NSE / BSE go to the India scanner, every other exchange to America. */
  function regionOfTicker(tv) {
    return /^(NSE|BSE):/i.test(tv) ? 'IN' : 'US';
  }

  /** Group Plutus symbols by region and map each to its TradingView ticker (and back). */
  function buildRequests(symbols) {
    const S = root.PlutusSymbols;
    const groups = { IN: [], US: [] };
    const back = {};
    (symbols || []).forEach((sym) => {
      const tv = S ? S.toTradingView(sym) : null;
      if (!tv || !tv.includes(':')) return;            // the scanner needs EXCHANGE:TICKER
      groups[regionOfTicker(tv)].push(tv);
      back[tv] = sym;
    });
    const requests = [];
    ['IN', 'US'].forEach((region) => {
      for (let i = 0; i < groups[region].length; i += BATCH) {
        requests.push({ region, url: HOSTS[region], tickers: groups[region].slice(i, i + BATCH) });
      }
    });
    return { requests, back };
  }

  function requestBody(tickers) {
    return JSON.stringify({ symbols: { tickers }, columns: COLUMNS });
  }

  /** `{data: [{s: 'NSE:INFY', d: [close, change, change_abs]}]}` -> {symbol: quote}. */
  function parseResponse(json, back, now) {
    const out = {};
    const rows = json && Array.isArray(json.data) ? json.data : [];
    rows.forEach((row) => {
      const sym = back[row && row.s];
      const d = row && Array.isArray(row.d) ? row.d : null;
      if (!sym || !d) return;
      const close = typeof d[0] === 'number' ? d[0] : null;
      if (close == null || !(close > 0)) return;
      out[sym] = {
        close,
        chgPct: typeof d[1] === 'number' ? d[1] : null,
        chg: typeof d[2] === 'number' ? d[2] : null,
        at: now || Date.now(),
      };
    });
    return out;
  }

  /**
   * Quotes for `symbols`: cached ones are reused for QUOTE_TTL_MS, the rest
   * are fetched (unless the region is backing off). Never throws: a failed
   * region just comes back without quotes and `degraded: true`.
   */
  async function quotes(symbols, fetchFn) {
    const doFetch = fetchFn || root.fetch;
    const now = Date.now();
    const result = { quotes: {}, degraded: false, error: null, fetched: 0 };
    const missing = [];
    (symbols || []).forEach((sym) => {
      const hit = cache.get(sym);
      if (hit && now - hit.at < QUOTE_TTL_MS) result.quotes[sym] = hit; else missing.push(sym);
    });
    if (!missing.length) return result;
    const { requests, back } = buildRequests(missing);
    for (const req of requests) {
      const b = backoff[req.region];
      if (now < b.until) { result.degraded = true; result.error = result.error || ('live quotes paused (' + req.region + ')'); continue; }
      try {
        const res = await doFetch(req.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: requestBody(req.tickers) });
        if (!res || !res.ok) throw new Error('scanner HTTP ' + (res ? res.status : '0'));
        const json = await res.json();
        const got = parseResponse(json, back, now);
        Object.keys(got).forEach((sym) => { cache.set(sym, got[sym]); result.quotes[sym] = got[sym]; });
        result.fetched += Object.keys(got).length;
        b.level = 0; b.until = 0;
      } catch (e) {
        b.until = now + BACKOFF_MS[Math.min(b.level, BACKOFF_MS.length - 1)];
        b.level = Math.min(b.level + 1, BACKOFF_MS.length - 1);
        result.degraded = true;
        result.error = (e && e.message) || String(e);
      }
    }
    // Stale cache beats nothing while a region is paused.
    missing.forEach((sym) => { if (!result.quotes[sym] && cache.has(sym)) result.quotes[sym] = Object.assign({ stale: true }, cache.get(sym)); });
    if (cache.size > 3000) Array.from(cache.keys()).slice(0, cache.size - 2000).forEach((k) => cache.delete(k));
    return result;
  }

  // ---- one stock outside the Plutus universe: a provisional read ---------------
  // Shown on a grey "TradingView data · provisional" card only. These columns
  // are TradingView's own definitions (ROIC, not Screener's ROCE; TTM margins)
  // and must never be mixed into a Plutus score.
  const FUND_COLUMNS = [
    'description', 'close', 'change', 'SMA200', 'price_52_week_high', 'price_52_week_low', 'all_time_high',
    'market_cap_basic', 'price_earnings_ttm', 'price_book_fq', 'return_on_equity_fq', 'return_on_invested_capital_fq',
    'debt_to_equity_fq', 'operating_margin_ttm', 'net_margin_ttm', 'total_revenue_yoy_growth_ttm', 'net_income_yoy_growth_ttm',
    'earnings_per_share_diluted_ttm', 'dividends_yield', 'sector', 'industry',
  ];
  const FUND_KEYS = ['name', 'close', 'chgPct', 'sma200', 'high52', 'low52', 'ath', 'marketCap', 'pe', 'pb', 'roe', 'roic',
    'debtToEquity', 'opMargin', 'netMargin', 'revenueYoY', 'netIncomeYoY', 'eps', 'dividendYield', 'sector', 'industry'];
  const FUND_TTL_MS = 60 * 60 * 1000;
  const fundCache = new Map();

  function parseFundamentals(json, tv) {
    const rows = json && Array.isArray(json.data) ? json.data : [];
    return parseFundRow(rows.find((r) => r && r.s === tv) || rows[0]);
  }
  function parseFundRow(row) {
    if (!row || !Array.isArray(row.d)) return null;
    const out = {};
    FUND_KEYS.forEach((k, i) => {
      const v = row.d[i];
      out[k] = typeof v === 'number' ? v : (typeof v === 'string' && v ? v : null);
    });
    if (out.close == null) return null;
    const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);
    out.dist200 = pct(out.close, out.sma200);          // + above, − below
    out.off52 = pct(out.close, out.high52);
    out.offAth = pct(out.close, out.ath);
    return out;
  }

  async function fundamentals(symbol, fetchFn) {
    const doFetch = fetchFn || root.fetch;
    const S = root.PlutusSymbols;
    const tv = S ? S.toTradingView(symbol) : null;
    if (!tv || !tv.includes(':')) return { symbol, data: null, error: 'no TradingView ticker for ' + symbol };
    const hit = fundCache.get(symbol);
    if (hit && Date.now() - hit.at < FUND_TTL_MS) return Object.assign({ cached: true }, hit);
    const region = regionOfTicker(tv);
    try {
      const res = await doFetch(HOSTS[region], { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ symbols: { tickers: [tv] }, columns: FUND_COLUMNS }) });
      if (!res || !res.ok) throw new Error('scanner HTTP ' + (res ? res.status : '0'));
      const data = parseFundamentals(await res.json(), tv);
      const rec = { symbol, tv, region, data, error: data ? null : 'no data for ' + tv, at: Date.now(), source: 'tradingview-scanner' };
      fundCache.set(symbol, rec);
      return rec;
    } catch (e) {
      return { symbol, tv, region, data: null, error: (e && e.message) || String(e), at: Date.now() };
    }
  }

  /**
   * Fundamentals for a whole list (the on-demand filters): one request per
   * region per 200 symbols, each stock cached for an hour. Never throws.
   * -> {data: {symbol: fields|null}, error, fetched}
   */
  async function fundamentalsBatch(symbols, fetchFn) {
    const doFetch = fetchFn || root.fetch;
    const now = Date.now();
    const out = { data: {}, error: null, fetched: 0 };
    const missing = [];
    (symbols || []).forEach((sym) => {
      const hit = fundCache.get(sym);
      if (hit && now - hit.at < FUND_TTL_MS) out.data[sym] = hit.data; else missing.push(sym);
    });
    if (!missing.length) return out;
    const { requests, back } = buildRequests(missing);
    for (const req of requests) {
      try {
        const res = await doFetch(req.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ symbols: { tickers: req.tickers }, columns: FUND_COLUMNS }) });
        if (!res || !res.ok) throw new Error('scanner HTTP ' + (res ? res.status : '0'));
        const json = await res.json();
        const seen = new Set();
        ((json && json.data) || []).forEach((row) => {
          const sym = back[row && row.s];
          if (!sym) return;
          const data = parseFundRow(row);
          fundCache.set(sym, { symbol: sym, tv: row.s, data, error: data ? null : 'no data', at: now, source: 'tradingview-scanner' });
          out.data[sym] = data; seen.add(sym); out.fetched++;
        });
        // asked but not returned: remember the miss for the hour too, so we do not ask again and again
        req.tickers.forEach((tv) => { const sym = back[tv]; if (sym && !seen.has(sym)) { fundCache.set(sym, { symbol: sym, tv, data: null, error: 'not on TradingView', at: now }); out.data[sym] = null; } });
      } catch (e) { out.error = (e && e.message) || String(e); }
    }
    return out;
  }

  function reset() { cache.clear(); fundCache.clear(); backoff.IN = { until: 0, level: 0 }; backoff.US = { until: 0, level: 0 }; }

  root.PlutusTvScan = { HOSTS, COLUMNS, FUND_COLUMNS, FUND_KEYS, BATCH, QUOTE_TTL_MS, FUND_TTL_MS, BACKOFF_MS, buildRequests, requestBody, parseResponse, parseFundamentals, parseFundRow, quotes, fundamentals, fundamentalsBatch, reset, _state: { cache, backoff, fundCache } };
})(typeof self !== 'undefined' ? self : this);
