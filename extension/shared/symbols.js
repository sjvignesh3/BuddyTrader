/**
 * Plutus Companion — symbol spelling converters.
 *
 * One ticker, four spellings:
 *   Plutus / yfinance  "TCS.NS"      (canonical everywhere inside the extension)
 *   journal            "TCS"          (plain, what /api/journal/* expects)
 *   TradingView        "NSE:TCS"      (hyphen and ampersand become underscore: "NSE:M_M")
 *   Screener.in URL    "/company/TCS/" (Screener keeps "&" and "-" as-is, URL-encoded)
 *
 * Loaded as a plain script in content scripts, the popup and (via
 * importScripts) the service worker, so everything hangs off a single
 * global namespace `PlutusSymbols`.
 */
(function (root) {
  'use strict';

  // TradingView spells a few NSE tickers with underscores; map them back.
  // Extend here when a new one shows up (the canonical side is what Plutus
  // and Screener use).
  const TV_UNDERSCORE_TO_CANONICAL = {
    'BAJAJ_AUTO': 'BAJAJ-AUTO',
    'NAM_INDIA': 'NAM-INDIA',
    'M_M': 'M&M',
    'M_MFIN': 'M&MFIN',
    'ARE_M': 'ARE&M',
    'GVT_D': 'GVT&D',
    'J_KBANK': 'J&KBANK',
    'HDFC_LIFE': 'HDFCLIFE',   // defensive: some feeds insert an underscore
  };

  const BODY_RE = /^[A-Z0-9&\-]{1,20}$/;

  function stripExchange(s) {
    const t = String(s || '').trim().toUpperCase();
    if (!t) return { exchange: null, body: '' };
    const idx = t.indexOf(':');
    if (idx >= 0) return { exchange: t.slice(0, idx), body: t.slice(idx + 1).trim() };
    return { exchange: null, body: t };
  }

  function stripSuffix(body) {
    const m = /^(.*?)\.(NS|BO)$/i.exec(body);
    return m ? { body: m[1], suffix: m[2].toUpperCase() } : { body: body, suffix: null };
  }

  /** Any spelling -> "TCS.NS" | "500325.BO" | null when not a ticker. */
  function toPlutus(raw) {
    if (raw == null) return null;
    let { exchange, body } = stripExchange(raw);
    if (!body) return null;
    body = decodeURIComponentSafe(body);
    const sfx = stripSuffix(body);
    body = sfx.body.replace(/\s+/g, '');
    if (TV_UNDERSCORE_TO_CANONICAL[body]) body = TV_UNDERSCORE_TO_CANONICAL[body];
    if (!BODY_RE.test(body)) return null;
    let suffix = sfx.suffix;
    if (!suffix) suffix = (exchange === 'BSE' || /^\d{6}$/.test(body)) ? 'BO' : 'NS';
    return body + '.' + suffix;
  }

  /** "TCS.NS" -> "TCS" (journal / Screener path segment). */
  function toPlain(raw) {
    const p = toPlutus(raw);
    if (!p) return null;
    return stripSuffix(p).body;
  }

  /** "TCS.NS" -> "NSE:TCS"; "M&M.NS" -> "NSE:M_M"; "500325.BO" -> "BSE:500325". */
  function toTradingView(raw) {
    const p = toPlutus(raw);
    if (!p) return null;
    const sfx = stripSuffix(p);
    const exch = sfx.suffix === 'BO' ? 'BSE' : 'NSE';
    return exch + ':' + sfx.body.replace(/[-&]/g, '_');
  }

  /** "TCS.NS" -> "https://www.screener.in/company/TCS/consolidated/". */
  function toScreenerUrl(raw, consolidated) {
    const plain = toPlain(raw);
    if (!plain) return null;
    const seg = encodeURIComponent(plain);
    return 'https://www.screener.in/company/' + seg + '/' + (consolidated === false ? '' : 'consolidated/');
  }

  /** TradingView chart URL for a symbol. */
  function toTradingViewUrl(raw) {
    const tv = toTradingView(raw);
    return tv ? 'https://in.tradingview.com/chart/?symbol=' + encodeURIComponent(tv) : null;
  }

  /** Plutus web-app stock page — the route takes the yfinance form ("/stocks/INFY.NS"). */
  function toPlutusUrl(webAppBase, raw) {
    const sym = toPlutus(raw);
    if (!sym) return null;
    const base = String(webAppBase || '').replace(/\/+$/, '');
    return base + '/stocks/' + encodeURIComponent(sym);
  }

  /** Split pasted text into canonical symbols (dedupe, order kept). */
  function parseList(text) {
    const out = [];
    const seen = new Set();
    String(text || '').split(/[\s,;]+/).forEach(function (tok) {
      const p = toPlutus(tok);
      if (p && !seen.has(p)) { seen.add(p); out.push(p); }
    });
    return out;
  }

  function decodeURIComponentSafe(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  root.PlutusSymbols = {
    toPlutus: toPlutus,
    toPlain: toPlain,
    toTradingView: toTradingView,
    toScreenerUrl: toScreenerUrl,
    toTradingViewUrl: toTradingViewUrl,
    toPlutusUrl: toPlutusUrl,
    parseList: parseList,
    TV_UNDERSCORE_TO_CANONICAL: TV_UNDERSCORE_TO_CANONICAL,
  };
})(typeof self !== 'undefined' ? self : this);
