/**
 * Plutus Companion — symbol spelling converters.
 *
 * One ticker, four spellings:
 *   Plutus / yfinance  "TCS.NS"      (canonical everywhere inside the extension)
 *   journal            "TCS"          (plain, what /api/journal/* expects)
 *   TradingView        "NSE:TCS"      (hyphen and ampersand become underscore: "NSE:M_M")
 *   Screener.in URL    "/company/TCS/" (Screener keeps "&" and "-" as-is, URL-encoded)
 *
 * US stocks (same rule as plutus/markets.py): the canonical form is the plain
 * Yahoo ticker with NO suffix ("NVDA", "BRK-B"); TradingView wants the listing
 * exchange ("NASDAQ:NVDA", "NYSE:BRK.B"); Screener.in has no US pages.
 * A bare ticker cannot say which market it belongs to, so the US tickers Plutus
 * holds are registered here from the bootstrap payload (registerUs). A bare
 * ticker that is registered is US; any other bare ticker is Indian, as before.
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
  const IN_SUFFIX_RE = /\.(NS|BO)$/i;
  // 1-5 letters, optionally a share class: BRK-B / BRK.B.
  const US_RE = /^[A-Z]{1,5}(?:[.\-][A-Z]{1,2})?$/;
  // TradingView / Yahoo exchange names -> the three prefixes TradingView uses.
  const US_EXCHANGE = {
    NASDAQ: 'NASDAQ', NYSE: 'NYSE', AMEX: 'AMEX', ARCA: 'AMEX', NYSEARCA: 'AMEX', BATS: 'AMEX',
    NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NAS: 'NASDAQ', NYQ: 'NYSE', NYS: 'NYSE',
    ASE: 'AMEX', PCX: 'AMEX', BTS: 'AMEX',
  };
  // Known US tickers: "NVDA" -> "NASDAQ" | null (exchange unknown).
  const usRegistry = new Map();

  function usExchange(raw) {
    return US_EXCHANGE[String(raw || '').trim().toUpperCase()] || null;
  }

  /**
   * Register US tickers so bare spellings resolve to the US market.
   * Accepts bootstrap stock entries ({symbol, exchange}) or plain strings;
   * anything carrying an Indian suffix is ignored.
   */
  function registerUs(items) {
    (items || []).forEach(function (it) {
      const raw = String((it && it.symbol) || (typeof it === 'string' ? it : '')).trim().toUpperCase();
      if (!raw || IN_SUFFIX_RE.test(raw)) return;
      const sym = raw.replace('.', '-');
      if (!US_RE.test(sym)) return;
      usRegistry.set(sym, usExchange(it && it.exchange) || usRegistry.get(sym) || null);
    });
  }

  /** True for a canonical symbol of the US market (no .NS / .BO suffix). */
  function isUs(sym) {
    return !!sym && !IN_SUFFIX_RE.test(String(sym));
  }

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

  /**
   * Any spelling -> "TCS.NS" | "500325.BO" | "NVDA" (US) | null when not a ticker.
   * opts.market === 'IN' reads a bare ticker as Indian even when a US stock
   * of the same name is registered (Screener.in pages are always Indian).
   */
  function toPlutus(raw, opts) {
    if (raw == null) return null;
    let { exchange, body } = stripExchange(raw);
    if (!body) return null;
    body = decodeURIComponentSafe(body);
    const sfx = stripSuffix(body);
    if (!sfx.suffix && exchange !== 'NSE' && exchange !== 'BSE' && !(opts && opts.market === 'IN')) {
      const us = body.replace(/\s+/g, '').replace('.', '-');
      const ex = usExchange(exchange);
      if (US_RE.test(us) && (ex || (!exchange && usRegistry.has(us)))) {
        if (ex) usRegistry.set(us, ex);          // "NASDAQ:SNDK" teaches us the exchange
        return us;
      }
    }
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

  /**
   * "TCS.NS" -> "NSE:TCS"; "M&M.NS" -> "NSE:M_M"; "500325.BO" -> "BSE:500325".
   * US: "NVDA" -> "NASDAQ:NVDA", "BRK-B" -> "NYSE:BRK.B"; the bare ticker when
   * the listing exchange is unknown (TradingView picks the primary listing).
   */
  function toTradingView(raw) {
    const p = toPlutus(raw);
    if (!p) return null;
    if (isUs(p)) {
      const ex = usRegistry.get(p);
      return (ex ? ex + ':' : '') + p.replace('-', '.');
    }
    const sfx = stripSuffix(p);
    const exch = sfx.suffix === 'BO' ? 'BSE' : 'NSE';
    return exch + ':' + sfx.body.replace(/[-&]/g, '_');
  }

  /** "TCS.NS" -> "https://www.screener.in/company/TCS/consolidated/". */
  function toScreenerUrl(raw, consolidated) {
    const p = toPlutus(raw);
    if (!p || isUs(p)) return null;            // Screener.in covers Indian companies only
    const plain = stripSuffix(p).body;
    const seg = encodeURIComponent(plain);
    return 'https://www.screener.in/company/' + seg + '/' + (consolidated === false ? '' : 'consolidated/');
  }

  /** TradingView chart URL for a symbol. */
  function toTradingViewUrl(raw) {
    const tv = toTradingView(raw);
    if (!tv) return null;
    const host = isUs(toPlutus(raw)) ? 'www.tradingview.com' : 'in.tradingview.com';
    return 'https://' + host + '/chart/?symbol=' + encodeURIComponent(tv);
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
    registerUs: registerUs,
    isUs: isUs,
    TV_UNDERSCORE_TO_CANONICAL: TV_UNDERSCORE_TO_CANONICAL,
  };
})(typeof self !== 'undefined' ? self : this);
