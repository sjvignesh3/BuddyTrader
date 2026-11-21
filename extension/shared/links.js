/**
 * Plutus Companion — research links for one stock (pure, Node-tested).
 *
 * India: Screener.in (company, quarters, P&L, balance sheet, shareholding,
 *        peers) and TradingView's financials.
 * US:    stockanalysis.com (quarterly and annual income statement, balance
 *        sheet, ratios), roic.ai, vcpscanner.com, stockresearch.app (P/E
 *        history) and TradingView's financials. The Plutus overlay colours
 *        every one of those pages.
 * -> [{group, label, url, title}]
 */
(function (root) {
  'use strict';

  function researchLinks(symbol) {
    const S = root.PlutusSymbols;
    const p = S && S.toPlutus(symbol);
    if (!p) return [];
    const tv = S.toTradingView(p) || '';
    const tvPath = tv.includes(':') ? tv.replace(':', '-') : tv;
    const tvFin = 'https://www.tradingview.com/symbols/' + encodeURIComponent(tvPath) + '/financials-overview/';
    if (!S.isUs(p)) {
      const base = S.toScreenerUrl(p, true);
      return [
        { group: 'Screener.in', label: 'Company', url: base, title: 'Screener consolidated page (the Plutus card and colouring are there)' },
        { group: 'Screener.in', label: 'Quarters', url: base + '#quarters', title: 'Quarterly results' },
        { group: 'Screener.in', label: 'P&L', url: base + '#profit-loss', title: 'Annual profit & loss' },
        { group: 'Screener.in', label: 'Balance sheet', url: base + '#balance-sheet', title: 'Balance sheet' },
        { group: 'Screener.in', label: 'Shareholding', url: base + '#shareholding', title: 'Shareholding pattern' },
        { group: 'Screener.in', label: 'Peers', url: base + '#peers', title: 'Peer comparison' },
        { group: 'TradingView', label: 'Financials', url: tvFin, title: 'TradingView financials overview' },
      ];
    }
    const t = p.toLowerCase().replace('.', '-');
    const T = p.toUpperCase();
    const sa = 'https://stockanalysis.com/stocks/' + encodeURIComponent(t) + '/financials/';
    return [
      { group: 'stockanalysis.com', label: 'P&L quarterly', url: sa + '?p=quarterly', title: 'Income statement, quarterly' },
      { group: 'stockanalysis.com', label: 'P&L annual', url: sa, title: 'Income statement, annual' },
      { group: 'stockanalysis.com', label: 'Balance sheet', url: sa + 'balance-sheet/', title: 'Balance sheet' },
      { group: 'stockanalysis.com', label: 'Ratios', url: sa + 'ratios/', title: 'Valuation and quality ratios' },
      { group: 'roic.ai', label: '15Y financials', url: 'https://www.roic.ai/quote/' + encodeURIComponent(T) + '/financials?yearRange=15', title: 'Long history, annual' },
      { group: 'vcpscanner.com', label: 'Financials', url: 'https://vcpscanner.com/stock/' + encodeURIComponent(t) + '/financials', title: 'Statements with Piotroski / ROIC cards' },
      { group: 'stockresearch.app', label: 'P/E history', url: 'https://www.stockresearch.app/stocks/' + encodeURIComponent(T), title: 'Weekly P/E with 3Y / 5Y / 10Y medians' },
      { group: 'TradingView', label: 'Financials', url: tvFin, title: 'TradingView financials overview' },
    ];
  }

  root.PlutusLinks = { researchLinks };
})(typeof self !== 'undefined' ? self : this);
