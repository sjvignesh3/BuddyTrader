/**
 * Plutus Companion — Screener.in content script.
 *
 * On a company page:
 *   1. auto-open the consolidated view (falls back to standalone when the
 *      consolidated statements are stale, and remembers the choice per stock);
 *   2. toolbar next to "Export to Excel": TradingView, Plutus, ON/OFF, view switch,
 *      note / bookmark / PlayArea;
 *   3. Plutus card above the ratios: signal, fundamental score with the 11
 *      checks, 200 DMA / ATH / 52-week read, held position, on-page rule checks;
 *   4. colour-coding: ratio tiles against Plutus thresholds, YoY growth in the
 *      quarters / P&L / balance-sheet tables, expense share of sales,
 *      other-income & exceptional-item outliers, shareholding trends, peers;
 *   5. Chart.js modal with fundamentals and shareholding series.
 *
 * All Plutus data comes from the service worker; nothing here fetches.
 * Screener tables are parsed in the page, never sent anywhere.
 */
(function () {
  'use strict';
  if (window.__plutusScrLoaded) { if (typeof window.__plutusScrRun === 'function') window.__plutusScrRun(); return; }
  window.__plutusScrLoaded = true;

  const S = window.PlutusSymbols, U = window.PlutusUI, SET = window.PlutusSettings;
  const el = U.el, esc = U.esc, num = U.num;

  const st = { settings: null, boot: null, stocks: new Map(), stock: null, stockErr: null, ticker: null, updating: false, timer: null, charts: {} };

  // =============================================================================
  // Page helpers
  // =============================================================================
  function ticker() {
    const m = /\/company\/([^\/]+)/i.exec(location.pathname);
    return m ? S.toPlain(decodeURIComponent(m[1])) : null;
  }
  function isConsolidated() { return location.pathname.toLowerCase().includes('/consolidated'); }
  function parseNum(text) {
    if (text == null) return null;
    const t = String(text).replace(/[\s,₹%]/g, '').replace(/ /g, '');
    if (!t || t === '-' || t === '—' || /^n\/?a$/i.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  function sectionTable(id) {
    const sec = document.getElementById(id);
    return sec ? sec.querySelector('table.data-table') : null;
  }
  /** Header cells; the peers table keeps its header row inside <tbody>, so fall back to the first row. */
  function tableHeaders(table) {
    let ths = Array.from(table.querySelectorAll('thead th'));
    if (!ths.length) { const first = table.querySelector('tr'); ths = first ? Array.from(first.children) : []; }
    return ths.map((th) => th.innerText.trim());
  }
  function tableRows(table) {
    const hasThead = !!table.querySelector('thead th');
    let trs = Array.from(table.querySelectorAll('tbody tr'));
    if (!hasThead) trs = trs.filter((tr) => tr !== table.querySelector('tr'));   // drop the header row
    return trs.map((tr) => {
      const cells = Array.from(tr.children);
      // Screener appends " +" to expandable rows ("Sales +"); strip it for matching.
      return { tr, label: (cells[0] ? cells[0].innerText : '').replace(/\s*\+\s*$/, '').trim(), cells, values: cells.slice(1).map((td) => parseNum(td.innerText)) };
    });
  }
  function findRow(rows, re) { return rows.find((r) => re.test(r.label)); }
  function thresholds() {
    const t = (st.boot && st.boot.thresholds) || {};
    const o = (st.settings && st.settings.thresholdOverrides) || {};
    const f = t.fundamental || {};
    const pick = (k, v, d) => (o[k] !== undefined && o[k] !== '' ? Number(o[k]) : (num(v) != null ? num(v) : d));
    return {
      peMax: pick('pe_max', f.pe_max, 70),
      ndeMax: pick('net_debt_to_equity_max', f.net_debt_to_equity_max, 0.25),
      roceMin: pick('roce_min', f.roce_min, 15),
      roeMin: pick('roe_min', f.roe_min, 15),
      pledgeMax: pick('pledging_max', f.pledging_max, 5),
      athTol: num(f.ath_tolerance) != null ? num(f.ath_tolerance) : 0.9,
      buyZone: num((t.envelope || {}).buy_zone_below_dma_pct) != null ? num(t.envelope.buy_zone_below_dma_pct) : 14,
      oppZone: num((t.envelope || {}).opportunity_below_dma_pct) != null ? num(t.envelope.opportunity_below_dma_pct) : 9,
      athFall: Object.assign({ Large: 20, Mid: 30, Small: 40, Micro: 40 }, Object.fromEntries(Object.entries(t.ath_fall_pct_by_cap || {}).map(([k, v]) => [k, num(v)]))),
      pointers: Object.assign({ public_holding_max_pct: 30, ttm_net_profit_min_cr: 250, ttm_vs_peak_min_ratio: 0.9 }, Object.fromEntries(Object.entries(t.pointers || {}).map(([k, v]) => [k, num(v)]))),
      tiles: (st.settings && st.settings.tiles) || SET.DEFAULTS.tiles,
      // Banks / NBFC list (stocks.sector_group): PE / ROE / ROA / TTM profit / NPA bars.
      groups: lenderGroups(f.groups),
    };
  }
  const LENDER_DEFAULTS = {
    Banks: { pe_max: 30, roe_min: 12, roa_min: 1.2, net_profit_ttm_min_cr: 1000, gross_npa_max: 3, net_npa_max: 1 },
    NBFC: { pe_max: 30, roe_min: 15, roa_min: 2, net_profit_ttm_min_cr: 1000, gross_npa_max: 3, net_npa_max: 1 },
  };
  function lenderGroups(server) {
    const out = {};
    Object.keys(LENDER_DEFAULTS).forEach((g) => {
      const s = (server || {})[g] || {};
      out[g] = Object.assign({}, LENDER_DEFAULTS[g], Object.fromEntries(Object.entries(s).map(([k, v]) => [k, num(v)]).filter(([, v]) => v != null)));
    });
    return out;
  }
  /** 'Banks' | 'NBFC' when the open stock is scored on the lender list, else null. */
  function lenderGroup() {
    const g = st.stock && st.stock.summary && st.stock.summary.sector_group;
    return g === 'Banks' || g === 'NBFC' ? g : null;
  }
  /** Effective bars for the open stock: lender group block or the Normal list. */
  function barsFor(T) {
    const g = lenderGroup();
    const G = g ? T.groups[g] : null;
    return {
      group: g,
      peMax: G ? G.pe_max : T.peMax,
      roeMin: G ? G.roe_min : T.roeMin,
      roaMin: G ? G.roa_min : null,
      gnpaMax: G ? G.gross_npa_max : null,
      nnpaMax: G ? G.net_npa_max : null,
      npTtmMinCr: G ? G.net_profit_ttm_min_cr : T.pointers.ttm_net_profit_min_cr,
    };
  }

  // =============================================================================
  // Boot / orchestration
  // =============================================================================
  async function start() {
    st.settings = await SET.get();
    st.ticker = ticker();
    document.addEventListener('click', trackViewClicks, true);
    SET.onChange((s) => { const was = st.settings; st.settings = s; if (was.scrEnabled !== s.scrEnabled || JSON.stringify(was.tiles) !== JSON.stringify(s.tiles)) { clearHighlights(); } schedule(); });
    if (U.contextAlive()) chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'plutus:bootstrap-updated') { st.boot = null; loadPlutus().then(schedule); } });
    window.addEventListener('focus', schedule);
    window.addEventListener('popstate', () => setTimeout(schedule, 200));
    if (U.contextAlive()) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[NAV_KEY]) { st.nav = changes[NAV_KEY].newValue || null; renderWalk(); }
      });
      try { chrome.storage.local.get([NAV_KEY], (d) => { st.nav = (d && d[NAV_KEY]) || null; renderWalk(); }); } catch (e) { /* ignore */ }
    }
    document.addEventListener('keydown', onWalkKey, true);
    await loadPlutus();
    run();
    new MutationObserver(() => { if (!st.updating) schedule(); }).observe(document.body, { childList: true, subtree: true });
  }
  window.__plutusScrRun = () => run();

  async function loadPlutus() {
    if (!st.settings.scrEnabled) return;
    try {
      st.boot = await U.send({ type: 'bootstrap' }, 95000);
      st.stocks = new Map((st.boot.stocks || []).map((s) => [s.symbol, s]));
    } catch (e) { st.boot = st.boot || null; }
    if (st.ticker) {
      try { st.stock = await U.send({ type: 'stock', symbol: st.ticker }); st.stockErr = null; }
      catch (e) { st.stock = null; st.stockErr = e; }
    }
  }

  function schedule() { clearTimeout(st.timer); st.timer = setTimeout(run, 350); }

  function run() {
    if (!U.contextAlive()) return;
    if (st.updating) return;
    st.updating = true;
    try {
      const s = st.settings;
      if (!st.ticker) return;                                  // screens, explore, etc.: nothing to do
      injectToolbar();
      if (!s.scrEnabled) { clearHighlights(); removeCard(); removeFabs(); announceOnce(); renderWalk(); return; }
      if (s.scrAutoConsolidated && handleAutoConsolidated()) return;   // navigating away
      announceOnce();                                          // this page is the one the user stays on
      renderWalk();
      if (s.scrPlutusCard) injectCard(); else removeCard();
      colourTiles();
      if (s.scrHighlightTables) { ['quarters', 'profit-loss', 'balance-sheet', 'cash-flow'].forEach(highlightTable); highlightShareholding(); highlightPeers(); }
      injectFabs();
    } catch (e) {
      console.warn('[Plutus] run failed', e);
    } finally {
      setTimeout(() => { st.updating = false; }, 150);
    }
  }

  // =============================================================================
  // Linked tabs — tell the worker which company this tab settled on
  // =============================================================================
  function announceOnce() {
    if (!st.settings.linkTabs || !st.ticker || st.announcedTicker === st.ticker) return;
    st.announcedTicker = st.ticker;
    U.send({ type: 'link.symbol', from: 'screener', symbol: st.ticker }).catch(() => {});
  }

  // =============================================================================
  // Walk-through — ← / → through the list the TradingView panel shows
  // =============================================================================
  const NAV_KEY = 'plutus_nav';
  function navLists() {
    const out = [];
    ((st.boot && st.boot.pools) || []).forEach((p) => out.push({ kind: 'pool', id: p.code, name: p.name }));
    (st.walkWatchlists || []).forEach((w) => out.push({ kind: 'wl', id: w.id, name: w.name, symbols: w.symbols || [] }));
    return out;
  }
  function symbolsFor(list) {
    if (list.kind === 'pool') {
      return Array.from(st.stocks.values()).filter((s) => (s.pools || []).includes(list.id)).map((s) => s.symbol).sort();
    }
    return (list.symbols || []).slice();
  }
  /** The list to walk: what TradingView published, else the first pool holding this stock. */
  function currentNav() {
    if (st.nav && Array.isArray(st.nav.symbols) && st.nav.symbols.length) return st.nav;
    const me = S.toPlutus(st.ticker);
    const e = me && st.stocks.get(me);
    const pool = e && (e.pools || [])[0];
    const lists = navLists();
    const pick = (pool && lists.find((l) => l.kind === 'pool' && l.id === pool)) || lists[0];
    return pick ? { kind: pick.kind, id: pick.id, name: pick.name, symbols: symbolsFor(pick), source: 'screener-default' } : null;
  }
  function walkNeighbours() {
    const nav = currentNav();
    if (!nav) return null;
    const me = S.toPlutus(st.ticker);
    const idx = nav.symbols.indexOf(me);
    const n = nav.symbols.length;
    if (!n) return { nav, idx, prev: null, next: null };
    if (idx < 0) return { nav, idx, prev: nav.symbols[n - 1], next: nav.symbols[0] };
    return { nav, idx, prev: nav.symbols[(idx - 1 + n) % n], next: nav.symbols[(idx + 1) % n] };
  }
  function walkTo(symbol) {
    if (!symbol) return;
    const consolidated = st.settings.scrAutoConsolidated || isConsolidated();
    location.href = S.toScreenerUrl(symbol, consolidated);
  }
  function onWalkKey(e) {
    if (!st.settings.scrWalk || !st.ticker || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const t = e.target, tag = (t && t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
    if (document.querySelector('.px-dialog-overlay, #px-viz')) return;
    const w = walkNeighbours();
    if (!w || !w.nav.symbols.length) return;
    e.preventDefault(); e.stopPropagation();
    walkTo(e.key === 'ArrowRight' ? w.next : w.prev);
  }
  function renderWalk() {
    const old = document.getElementById('px-walk');
    if (!st.settings.scrWalk || !st.ticker || !st.boot) { if (old) old.remove(); return; }
    if (!st.walkWatchlists && !st.walkWlLoading) {
      st.walkWlLoading = true;
      U.send({ type: 'watchlists' }).then((r) => { st.walkWatchlists = r.watchlists || []; renderWalk(); }).catch(() => { st.walkWatchlists = []; });
    }
    const w = walkNeighbours();
    if (!w) { if (old) old.remove(); return; }
    const sig = JSON.stringify([w.nav.kind, w.nav.id, w.idx, w.nav.symbols.length, w.prev, w.next, st.settings.linkTabs, (st.walkWatchlists || []).length]);
    // The signature covers everything the pill shows, so a same-signature pill is already current.
    if (old && old.getAttribute('data-sig') === sig) return;
    if (old) old.remove();

    const sel = el('select', { title: 'List to walk with ← / → (shared with the TradingView panel)' });
    navLists().forEach((l) => sel.appendChild(el('option', { value: l.kind + ':' + l.id, text: l.name })));
    sel.value = w.nav.kind + ':' + w.nav.id;
    sel.addEventListener('change', () => {
      const l = navLists().find((x) => x.kind + ':' + x.id === sel.value);
      if (!l) return;
      const nav = { kind: l.kind, id: l.id, name: l.name, symbols: symbolsFor(l), source: 'screener', at: Date.now() };
      st.nav = nav;
      try { chrome.storage.local.set({ [NAV_KEY]: nav }); } catch (e) { /* ignore */ }
      renderWalk();
    });
    const n = w.nav.symbols.length;
    const btn = (dir, sym) => el('button', { type: 'button', class: 'px-walk-btn', disabled: sym ? null : 'disabled', title: sym ? 'Go to ' + S.toPlain(sym) : '', onclick: () => walkTo(sym) },
      dir < 0 ? [el('kbd', { text: '←' }), sym ? S.toPlain(sym) : '—'] : [sym ? S.toPlain(sym) : '—', el('kbd', { text: '→' })]);
    const pos = el('span', { class: 'px-walk-pos', html: w.idx >= 0 ? '<b>' + (w.idx + 1) + '</b> / ' + n : 'not in list · ' + n });
    const link = el('button', { type: 'button', class: 'px-walk-link' + (st.settings.linkTabs ? ' px-on' : ''), title: st.settings.linkTabs ? 'Tabs linked: the TradingView chart follows this page (click to unlink)' : 'Tabs not linked (click to link with TradingView)', text: '⇄', onclick: () => SET.save({ linkTabs: !st.settings.linkTabs }) });
    const pill = el('div', { id: 'px-walk', 'data-sig': sig, role: 'navigation', 'aria-label': 'Plutus walk-through' }, [U.logo(18), sel, btn(-1, w.prev), pos, btn(1, w.next), link]);
    document.body.appendChild(pill);
  }

  // =============================================================================
  // 1. Auto-consolidated with staleness detection
  // =============================================================================
  const prefKey = () => 'plutus_view_pref_' + st.ticker;
  function trackViewClicks(e) {
    const a = e.target && e.target.closest && e.target.closest('a[href*="/company/"]');
    if (!a || !st.ticker) return;
    const href = a.getAttribute('href') || '';
    if (!href.toUpperCase().includes('/COMPANY/' + st.ticker.toUpperCase())) return;
    try { localStorage.setItem(prefKey(), href.includes('/consolidated') ? 'consolidated' : 'standalone'); } catch (err) { /* ignore */ }
  }
  function consolidatedIsStale() {
    const table = sectionTable('profit-loss') || sectionTable('quarters');
    if (!table) return false;
    let maxYear = 0;
    tableHeaders(table).forEach((h) => { const m = /\b(19|20)(\d\d)\b/.exec(h); if (m) maxYear = Math.max(maxYear, Number(m[1] + m[2])); });
    return maxYear > 0 && (new Date().getFullYear() - maxYear) >= 3;
  }
  /**
   * Screener serves an EMPTY consolidated page for companies that file only
   * standalone statements (e.g. SANOFICONR after its 2023 demerger): every
   * top-ratio number is blank and the tables carry row labels but no period
   * columns. Mirrors plutus/fundamentals/screener_client.py, which also
   * prefers the view whose numbers are populated.
   */
  function consolidatedLacksData() {
    const nums = Array.from(document.querySelectorAll('#top-ratios .number'));
    const ratiosEmpty = nums.length > 0 && nums.every((n) => !n.textContent.trim());
    const dated = (id) => { const t = sectionTable(id); return !!t && tableHeaders(t).some((h) => /\b(19|20)\d\d\b/.test(h)); };
    const hasTables = !!(sectionTable('quarters') || sectionTable('profit-loss'));
    const tablesEmpty = hasTables && !dated('quarters') && !dated('profit-loss');
    return ratiosEmpty || tablesEmpty;
  }
  /** Returns true when a redirect was issued. */
  function handleAutoConsolidated() {
    const cons = isConsolidated();
    const base = 'https://www.screener.in/company/' + encodeURIComponent(st.ticker) + '/';
    let pref = null;
    try { pref = localStorage.getItem(prefKey()); } catch (e) { /* ignore */ }
    if (pref === 'standalone') { if (cons) { location.replace(base); return true; } return false; }
    if (pref === 'consolidated') { if (!cons) { location.replace(base + 'consolidated/'); return true; } return false; }
    if (cons) {
      const empty = consolidatedLacksData();
      if (empty || consolidatedIsStale()) {
        try {
          localStorage.setItem(prefKey(), 'standalone');
          sessionStorage.setItem('plutus_view_reason_' + st.ticker, empty ? 'empty' : 'stale');
        } catch (e) { /* ignore */ }
        location.replace(base);
        return true;
      }
      return false;
    }
    // Arrived on standalone because consolidated was unusable: say so once.
    try {
      const why = sessionStorage.getItem('plutus_view_reason_' + st.ticker);
      if (why) {
        sessionStorage.removeItem('plutus_view_reason_' + st.ticker);
        U.toast('Showing standalone — the consolidated view ' + (why === 'empty' ? 'has no figures' : 'stopped being updated 3+ years ago') + ' for ' + st.ticker, 'info', 4500);
      }
    } catch (e) { /* ignore */ }
    if (document.referrer && document.referrer.includes('/consolidated') && document.referrer.toUpperCase().includes(st.ticker.toUpperCase())) {
      try { localStorage.setItem(prefKey(), 'standalone'); } catch (e) { /* ignore */ }
      return false;
    }
    const guard = 'plutus_redir_guard_' + st.ticker;
    try { if (sessionStorage.getItem(guard)) return false; } catch (e) { /* ignore */ }
    if (document.querySelector('a[href*="/consolidated"]')) {
      try { sessionStorage.setItem(guard, '1'); } catch (e) { /* ignore */ }
      location.replace(base + 'consolidated/');
      return true;
    }
    return false;
  }

  // =============================================================================
  // 2. Toolbar
  // =============================================================================
  function excelAnchor() {
    const cands = Array.from(document.querySelectorAll('form, button, a'));
    const hit = cands.find((n) => /export to (company )?excel/i.test(n.textContent || ''));
    if (hit) return hit.closest('form') || hit;
    return document.querySelector('form[action*="/excel/"]') || document.querySelector('a[href*="/excel/"]');
  }
  /**
   * Where the toolbar goes, best first:
   *   excel  — just before "Export to Excel" in the company header row;
   *   header — before the last control in that header row (Follow), for pages
   *            without Export (empty consolidated view, some logged-out pages);
   *   block  — a full-width row above the ratios card, never inside its flex row.
   */
  function toolbarAnchor() {
    const excel = excelAnchor();
    if (excel && excel.parentNode) return { node: excel, kind: 'excel' };
    const card = document.querySelector('.card.card-large');
    const row = card && card.querySelector('.flex.flex-space-between');
    const last = row && row.lastElementChild;
    if (last && last !== row.firstElementChild) return { node: last, kind: 'header' };
    const info = document.querySelector('.company-info');
    if (info && info.parentNode) return { node: info, kind: 'block' };
    return null;
  }
  function injectToolbar() {
    const existing = document.getElementById('px-scr-toolbar');
    const a = toolbarAnchor();
    if (existing) {
      // Page finished rendering and a better anchor exists now: move there.
      const rank = { block: 0, header: 1, excel: 2 };
      const was = existing.getAttribute('data-px-anchor');
      if (a && rank[a.kind] > (rank[was] == null ? -1 : rank[was])) placeToolbar(existing, a);
      refreshToolbarState();
      return;
    }
    if (!a) return;
    placeToolbar(buildToolbar(a.kind === 'block' ? null : a.node), a);
    refreshToolbarState();
  }
  function placeToolbar(bar, a) {
    bar.setAttribute('data-px-anchor', a.kind);
    bar.classList.toggle('px-tbar-block', a.kind === 'block');
    a.node.parentNode.insertBefore(bar, a.node);
  }
  /**
   * One tidy control strip, sized to Screener's own Export button:
   *   TradingView ↗  [P] Plutus ↗ | Consolidated · Standalone | ✎ 🔖 | ● On
   * Links, the view switch, quick actions and the on/off switch are separate
   * groups so the eye reads them as four things, not seven buttons.
   */
  function buildToolbar(anchor) {
    const sym = S.toPlutus(st.ticker);
    const bar = el('div', { id: 'px-scr-toolbar', role: 'toolbar', 'aria-label': 'Plutus' });
    if (anchor) {
      const ref = anchor.tagName === 'FORM' ? (anchor.querySelector('button, a') || anchor) : anchor;
      const h = ref.getBoundingClientRect().height;
      if (h >= 24 && h <= 48) bar.style.setProperty('--px-btn-h', Math.round(h) + 'px');
    }

    const tvMark = el('span', { class: 'px-ico', html: '<svg width="14" height="12" viewBox="0 0 36 28" fill="currentColor"><path d="M14 22H7V7H0V0h14v22zm14-22a4 4 0 110 8 4 4 0 010-8zM22.5 22h-8l7.5-22h8l-7.5 22z"/></svg>' });
    const links = el('div', { class: 'px-tbar-group' }, [
      el('a', { class: 'px-tbar-btn px-tbar-tv', href: S.toTradingViewUrl(sym), target: '_blank', rel: 'noopener', title: 'Open ' + st.ticker + ' on TradingView' }, [tvMark, 'TradingView', U.icon('external', 11)]),
      el('a', { class: 'px-tbar-btn px-tbar-plutus', id: 'px-tb-plutus', href: S.toPlutusUrl(st.settings.webAppUrl, sym), target: '_blank', rel: 'noopener', title: 'Open ' + st.ticker + ' in Plutus' }, [U.logo(13), 'Plutus', U.icon('external', 11)]),
    ]);

    const seg = el('div', { class: 'px-tbar-seg', role: 'group', 'aria-label': 'Statement view' }, [
      el('button', { type: 'button', class: 'px-tbar-segbtn', 'data-view': 'consolidated', title: 'Consolidated figures', text: 'Consolidated', onclick: () => setView('consolidated') }),
      el('button', { type: 'button', class: 'px-tbar-segbtn', 'data-view': 'standalone', title: 'Standalone figures', text: 'Standalone', onclick: () => setView('standalone') }),
    ]);

    const actions = el('div', { class: 'px-tbar-group' }, [
      el('button', { type: 'button', class: 'px-tbar-btn px-tbar-icon', title: 'Save a dated note to Plutus', 'aria-label': 'Note', onclick: () => noteDialog(sym) }, [U.icon('note', 15)]),
      el('button', { type: 'button', class: 'px-tbar-btn px-tbar-icon', title: 'Bookmark to a Plutus watchlist', 'aria-label': 'Bookmark', onclick: () => bookmarkDialog(sym) }, [U.icon('bookmark', 15)]),
    ]);

    const sw = el('button', { type: 'button', class: 'px-tbar-switch', id: 'px-tb-toggle', role: 'switch', title: 'Turn all Plutus overlays on Screener on or off', onclick: () => SET.save({ scrEnabled: !st.settings.scrEnabled }) }, [
      el('span', { class: 'px-tbar-track' }, [el('span', { class: 'px-tbar-knob' })]),
      el('span', { class: 'px-tbar-switch-label' }),
    ]);

    [links, seg, actions, sw].forEach((n) => bar.appendChild(n));
    return bar;
  }
  function refreshToolbarState() {
    const bar = document.getElementById('px-scr-toolbar');
    if (!bar) return;
    const on = !!st.settings.scrEnabled;
    bar.classList.toggle('px-tbar-off', !on);
    const t = document.getElementById('px-tb-toggle');
    if (t) {
      t.setAttribute('aria-checked', String(on));
      const lab = t.querySelector('.px-tbar-switch-label');
      if (lab) lab.textContent = on ? 'On' : 'Off';
    }
    const cons = isConsolidated();
    bar.querySelectorAll('.px-tbar-segbtn').forEach((b) => {
      const active = (b.getAttribute('data-view') === 'consolidated') === cons;
      b.classList.toggle('px-active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    const p = document.getElementById('px-tb-plutus');
    if (p) p.href = S.toPlutusUrl(st.settings.webAppUrl, S.toPlutus(st.ticker));
  }
  function setView(view) {
    const cons = isConsolidated();
    if ((view === 'consolidated') === cons) return;           // already there
    try { localStorage.setItem(prefKey(), view); } catch (e) { /* ignore */ }
    location.href = 'https://www.screener.in/company/' + encodeURIComponent(st.ticker) + '/' + (view === 'consolidated' ? 'consolidated/' : '');
  }

  // =============================================================================
  // 3. Plutus card
  // =============================================================================
  const SIGNAL_CHIP = { BUY_ZONE: ['BUY ZONE', 'px-chip-buy'], OPPORTUNITY: ['OPPORTUNITY', 'px-chip-opp'], VALID: ['20% RALLY', 'px-chip-rally'] };
  function removeCard() { const c = document.getElementById('px-card'); if (c) c.remove(); }
  function cardAnchor() { return document.getElementById('top-ratios') || document.querySelector('.company-ratios') || document.querySelector('.company-info'); }

  function injectCard() {
    const anchor = cardAnchor();
    if (!anchor) return;
    const sig = pageSignature();
    const existing = document.getElementById('px-card');
    if (existing && existing.getAttribute('data-sig') === sig) return;
    if (existing) existing.remove();
    const card = buildCard();
    card.setAttribute('data-sig', sig);
    anchor.parentNode.insertBefore(card, anchor);
  }
  function pageSignature() {
    const q = sectionTable('quarters'), p = sectionTable('profit-loss');
    return [st.ticker, !!st.stock, st.stock && st.stock.snapshot_date, !!st.positionsLoaded, q ? q.rows.length : 0, p ? p.rows.length : 0, JSON.stringify(st.settings.thresholdOverrides), st.settings.scrPageRules].join('|');
  }

  function buildCard() {
    const T = thresholds();
    const data = st.stock;
    const head = el('div', { class: 'px-card-head' }, [
      el('span', { class: 'px-card-title' }, [U.logo(18), 'Plutus · ' + st.ticker]),
    ]);
    const body = el('div', { class: 'px-card-body' });
    const card = el('div', { id: 'px-card' }, [head, body]);

    if (!data) {
      head.appendChild(el('span', { class: 'px-card-meta', text: st.stockErr && st.stockErr.status === 404 ? 'not in the Plutus universe' : (st.stockErr ? st.stockErr.message : 'loading…') }));
      head.appendChild(el('span', { class: 'px-card-spacer' }));
      const actions = el('div', { class: 'px-card-actions' });
      if (st.stockErr && st.stockErr.status === 404) actions.appendChild(el('button', { class: 'px-btn px-btn-primary', text: '⚡ Add to PlayArea', onclick: () => playAreaAdd(S.toPlutus(st.ticker)) }));
      actions.appendChild(el('button', { class: 'px-btn', text: '↻', title: 'Retry', onclick: () => loadPlutus().then(() => { removeCard(); run(); }) }));
      head.appendChild(actions);
      if (st.settings.scrPageRules) body.appendChild(pageRulesBox(T));
      return card;
    }

    const sm = data.summary || {}, snap = data.snapshot || {}, fund = data.fundamentals || {};
    const results = data.scan_results || [];
    const fundaRes = results.find((r) => r.strategy_id === 'fundamental_screener');
    const ms = (fundaRes && fundaRes.metrics_snapshot) || {};
    const checks = ms.checks || [];
    const points = sm.funda_points, status = sm.best_status;
    const held = (st.boot && st.stock && st.stock.plain && positionFor(st.stock.plain)) || null;

    // header chips
    if (sm.cap) head.appendChild(el('span', { class: 'px-chip px-chip-cap', text: sm.cap + ' cap' }));
    if (status && SIGNAL_CHIP[status]) head.appendChild(el('span', { class: 'px-chip ' + SIGNAL_CHIP[status][1], text: SIGNAL_CHIP[status][0] }));
    else head.appendChild(el('span', { class: 'px-chip px-chip-none', text: 'no technical signal' }));
    if (status === 'BUY_ZONE' && points != null && points >= 8) head.appendChild(el('span', { class: 'px-chip px-chip-prime', text: 'PRIME' }));
    if (held) head.appendChild(el('span', { class: 'px-chip px-chip-held', text: 'HELD ' + held.qty + ' @ ₹' + U.fmt(held.invested / Math.max(1, held.qty), 0) }));
    (sm.pools || []).forEach((p) => head.appendChild(el('span', { class: 'px-chip px-chip-none', text: p })));
    head.appendChild(el('span', { class: 'px-card-meta', text: 'snapshot ' + (data.snapshot_date || '—') + (fund.quarter_label ? ' · Q ' + fund.quarter_label : '') }));
    head.appendChild(el('span', { class: 'px-card-spacer' }));
    const inPlay = (sm.pools || []).includes('PlayArea');
    head.appendChild(el('div', { class: 'px-card-actions' }, [
      el('button', { class: 'px-btn', text: '✎ Note', onclick: () => noteDialog(data.symbol) }),
      el('button', { class: 'px-btn', text: '⚖ Size', title: 'Position sizer: risk-based qty, cap-allocation check, then opportunity or plan', onclick: () => sizerDialog(data) }),
      el('button', { class: 'px-btn', text: '＋ Opportunity', onclick: () => opportunityDialog(data) }),
      el('button', { class: 'px-btn', text: inPlay ? '⚡ Remove from PlayArea' : '⚡ PlayArea', onclick: () => (inPlay ? playAreaRemove(data.symbol) : playAreaAdd(data.symbol)) }),
    ]));

    // box 1: fundamental score
    const scoreBox = el('div', { class: 'px-box' }, [
      el('div', { class: 'px-box-title' }, ['Fundamental score' + (ms.group && ms.group !== 'Normal' ? ' · ' + ms.group + ' list' : ''), el('span', { class: 'px-muted', text: fundaRes ? (fundaRes.status || '') : 'no scan yet' })]),
      el('div', { class: 'px-score', html: (points == null ? '—' : points) + ' <small>/ ' + (ms.points_max || 11) + (ms.unknown ? ' · ' + ms.unknown + ' n/a' : '') + '</small>' }),
    ]);
    if (checks.length) {
      const grid = el('div', { class: 'px-checks' });
      checks.forEach((c) => {
        const cls = c.passed === true ? 'px-pass' : c.passed === false ? 'px-fail' : 'px-na';
        grid.appendChild(el('div', { class: 'px-check ' + cls, title: c.detail || '' }, [el('b', { text: c.passed === true ? '✓' : c.passed === false ? '✗' : '·' }), c.label]));
      });
      scoreBox.appendChild(grid);
    }
    body.appendChild(scoreBox);

    // box 2: technical read
    const close = num(snap.close), dma = num(snap.dma_200), below = num(snap.below_200dma_pct);
    const athFall = num(snap.fall_from_ath_pct), capRule = T.athFall[sm.cap] || 30;
    const tech = el('div', { class: 'px-box' }, [el('div', { class: 'px-box-title' }, ['Technical read', el('span', { class: 'px-muted', text: close != null ? '₹' + U.fmt(close, 2) : '' })])]);
    if (dma != null && below != null) {
      const MIN = -20, MAX = 25, x = Math.max(0, Math.min(100, ((Math.max(MIN, Math.min(MAX, below)) - MIN) / (MAX - MIN)) * 100));
      tech.appendChild(kv('200 DMA', '₹' + U.fmt(dma, 0) + ' · ' + (below >= 0 ? below.toFixed(1) + '% below' : Math.abs(below).toFixed(1) + '% above')));
      tech.appendChild(el('div', { class: 'px-gauge' }, [el('i', { style: 'left:' + x.toFixed(1) + '%' })]));
      tech.appendChild(el('div', { class: 'px-gauge-labels', html: '<span>premium</span><span>' + T.oppZone + '% opp</span><span>' + T.buyZone + '% buy</span>' }));
      tech.appendChild(kv('Entry levels', '₹' + U.fmt(dma * (1 - T.oppZone / 100), 0) + ' / ₹' + U.fmt(dma * (1 - T.buyZone / 100), 0)));
    } else tech.appendChild(el('div', { class: 'px-muted', text: 'No 200 DMA yet.' }));
    if (athFall != null) tech.appendChild(kv('Off ATH (' + (sm.cap || '?') + ' rule > ' + capRule + '%)', athFall.toFixed(1) + '% ' + (athFall > capRule ? '✓' : '✗') + ' · ATH ₹' + U.fmt(snap.ath, 0)));
    if (snap.high_52w) tech.appendChild(kv('52-week', '₹' + U.fmt(snap.low_52w, 0) + ' – ₹' + U.fmt(snap.high_52w, 0) + ' · ' + U.fmtPct(snap.distance_from_52w_high_pct) + ' off high'));
    if (snap.has_valid_20pct_rally != null) tech.appendChild(kv('20% rally', snap.has_valid_20pct_rally ? 'valid · ' + U.fmtPct(snap.last_rally_pct) + ' · ' + (snap.days_since_last_rally || 0) + 'd ago' : 'none'));
    if (snap.pe_current) tech.appendChild(kv('PE / PB (Screener weekly)', U.fmt(snap.pe_current, 1) + ' / ' + U.fmt(snap.pb_current, 2)));
    body.appendChild(tech);

    // box 3: on-page rules
    if (st.settings.scrPageRules) body.appendChild(pageRulesBox(T));
    return card;
  }
  function kv(k, v) { return el('div', { class: 'px-kv' }, [el('span', { text: k }), el('span', { text: v })]); }
  function positionFor(plain) {
    // Positions arrive lazily: first call kicks off the fetch, the card is
    // rebuilt on the next scheduled run (its signature includes the flag).
    if (!st.positions) {
      st.positions = new Map();
      U.send({ type: 'positions' }).then((r) => {
        st.positions = new Map((r.positions || []).map((p) => [String(p.symbol).toUpperCase(), p]));
        st.positionsLoaded = true;
        schedule();
      }).catch(() => { st.positionsLoaded = true; });
    }
    return st.positions.get(plain) || null;
  }

  // ---- on-page rule checks (from the user's fundamental pointers) ------------
  function pageRulesBox(T) {
    const box = el('div', { class: 'px-box' }, [el('div', { class: 'px-box-title' }, ['Page rules', el('span', { class: 'px-muted', text: isConsolidated() ? 'consolidated' : 'standalone' })])]);
    const rules = el('div', { class: 'px-rules' });
    const out = computePageRules(T);
    if (!out.length) rules.appendChild(el('span', { class: 'px-muted', text: 'Tables not loaded yet.' }));
    out.forEach((r) => rules.appendChild(el('span', { class: 'px-chip ' + (r.pass === true ? 'px-chip-pass' : r.pass === false ? 'px-chip-fail' : 'px-chip-na'), title: r.detail || '', text: (r.pass === true ? '✓ ' : r.pass === false ? '✗ ' : '· ') + r.label })));
    box.appendChild(rules);
    return box;
  }
  function computePageRules(T) {
    const out = [];
    const B = barsFor(T), lender = !!B.group;
    const pl = sectionTable('profit-loss');
    if (pl) {
      const H = tableHeaders(pl), rows = tableRows(pl);
      const ttmIdx = H.findIndex((h) => /ttm/i.test(h)) - 1;           // values[] excludes the label cell
      const lastIdx = ttmIdx >= 0 ? ttmIdx : rows[0] ? rows[0].values.length - 1 : -1;
      const sales = findRow(rows, /^(sales|revenue)/i), np = findRow(rows, /^net profit/i), opm = findRow(rows, /^opm/i),
        tax = findRow(rows, /^tax %/i), interest = findRow(rows, /^interest/i), pbt = findRow(rows, /^profit before tax/i);
      const peakRule = (row, label, min) => {
        if (!row || lastIdx < 0) return;
        const vals = row.values.filter((v) => v != null);
        const cur = row.values[lastIdx];
        if (cur == null || !vals.length) return;
        const peak = Math.max(...vals);
        const ratio = peak > 0 ? cur / peak : null;
        out.push({ label: label + ' ≥ ' + Math.round(T.pointers.ttm_vs_peak_min_ratio * 100) + '% of 10Y peak', pass: ratio == null ? null : ratio >= T.pointers.ttm_vs_peak_min_ratio, detail: (ttmIdx >= 0 ? 'TTM ' : 'Latest ') + cur.toLocaleString('en-IN') + ' vs peak ' + peak.toLocaleString('en-IN') + ' Cr (' + (ratio == null ? '—' : Math.round(ratio * 100) + '%') + ')' });
        if (min != null) out.push({ label: label + ' > ₹' + min + ' Cr', pass: cur > min, detail: cur.toLocaleString('en-IN') + ' Cr' });
      };
      peakRule(sales, lender ? 'Revenue' : 'Sales', null);
      peakRule(np, 'Net profit', B.npTtmMinCr);
      if (opm) {
        const v = opm.values.filter((x) => x != null).slice(-4);
        if (v.length >= 3) {
          const trendUp = v[v.length - 1] >= v[v.length - 2] - 1 && v[v.length - 2] >= v[v.length - 3] - 1;
          const falling = v[v.length - 1] < v[v.length - 3] - 2;
          out.push({ label: 'OPM stable / rising', pass: falling ? false : trendUp ? true : null, detail: 'OPM% last periods: ' + v.join(' → ') });
        }
      }
      if (tax) {
        const v = tax.values.filter((x) => x != null).slice(-4);
        if (v.length >= 2) {
          const latest = v[v.length - 1], swing = Math.max(...v) - Math.min(...v);
          out.push({ label: 'Tax rate normal', pass: latest < 15 || swing > 12 ? false : true, detail: 'Tax%: ' + v.join(' → ') + (latest < 15 ? ' — unusually low' : swing > 12 ? ' — large swing' : '') });
        }
      }
      if (interest && pbt && !lender) {   // interest IS a lender's cost of goods — not a burden signal
        const iv = interest.values, pv = pbt.values;
        const last = lastIdx >= 0 ? lastIdx : iv.length - 1, prev = Math.max(0, last - 3);
        const share = (i) => (iv[i] != null && pv[i] != null && (iv[i] + pv[i]) > 0 ? iv[i] / (iv[i] + pv[i]) * 100 : null);
        const a = share(prev), b = share(last);
        if (a != null && b != null) out.push({ label: 'Interest burden not rising', pass: b <= a + 2, detail: 'Interest / (PBT + interest): ' + a.toFixed(1) + '% → ' + b.toFixed(1) + '%' });
      }
      // Growth mini-tables: Compounded Profit Growth vs Stock Price CAGR (3Y & 1Y)
      const ranges = Array.from(document.querySelectorAll('#profit-loss table.ranges-table'));
      const readRange = (titleRe) => {
        const t = ranges.find((tb) => titleRe.test((tb.querySelector('th') || {}).innerText || ''));
        if (!t) return null;
        const m = {};
        Array.from(t.querySelectorAll('tr')).forEach((tr) => { const c = tr.querySelectorAll('td'); if (c.length >= 2) m[c[0].innerText.replace(':', '').trim()] = parseNum(c[1].innerText); });
        return m;
      };
      const pg = readRange(/compounded profit growth/i), pc = readRange(/stock price cagr/i);
      if (pg && pc) {
        [['3 Years', '3Y'], ['1 Year', '1Y']].forEach(([k, lab]) => {
          if (pg[k] != null && pc[k] != null) out.push({ label: lab + ' price CAGR < profit CAGR', pass: pc[k] < pg[k], detail: 'Price ' + pc[k] + '% vs profit ' + pg[k] + '%' });
        });
      }
    }
    const bs = sectionTable('balance-sheet');
    if (bs) {
      const rows = tableRows(bs);
      const borrow = findRow(rows, /^borrowings/i);
      if (borrow && !lender) {            // a growing lender's borrowings climb by design
        const v = borrow.values.filter((x) => x != null).slice(-4);
        if (v.length >= 3) out.push({ label: 'Borrowings not climbing', pass: !(v[v.length - 1] > v[v.length - 2] && v[v.length - 2] > v[v.length - 3]), detail: 'Borrowings: ' + v.join(' → ') });
      }
      const fa = findRow(rows, /^fixed assets/i);
      if (fa) {
        const vals = fa.values.filter((x) => x != null);
        const cur = vals[vals.length - 1], peak = Math.max(...vals);
        if (cur != null && peak > 0) out.push({ label: 'Fixed assets ≥ 90% of peak', pass: cur / peak >= (T.pointers.tfa_vs_peak_min_ratio || 0.9), detail: cur.toLocaleString('en-IN') + ' vs peak ' + peak.toLocaleString('en-IN') + ' Cr (intangibles not netted — expand the row for TFA)' });
      }
    }
    const q = sectionTable('quarters');
    if (q) {
      const rows = tableRows(q);
      const gnpa = findRow(rows, /^gross npa/i), nnpa = findRow(rows, /^net npa/i);
      // Banks / NBFC asset quality — bars from the lender list (Banks bars when the group is unknown).
      const G = T.groups[B.group || 'Banks'];
      const latest = (row) => { const v = row.values.filter((x) => x != null); return v.length ? v[v.length - 1] : null; };
      if (gnpa) { const v = latest(gnpa); if (v != null) out.push({ label: 'Gross NPA < ' + G.gross_npa_max + '%', pass: v < G.gross_npa_max, detail: 'Latest quarter Gross NPA ' + v + '%' }); }
      if (nnpa) { const v = latest(nnpa); if (v != null) out.push({ label: 'Net NPA < ' + G.net_npa_max + '%', pass: v < G.net_npa_max, detail: 'Latest quarter Net NPA ' + v + '%' }); }
    }
    const sh = sectionTable('shareholding');
    if (sh) {
      const rows = tableRows(sh);
      const pub = findRow(rows, /^public/i);
      if (pub) { const v = pub.values.filter((x) => x != null); const cur = v[v.length - 1]; if (cur != null) out.push({ label: 'Public holding < ' + T.pointers.public_holding_max_pct + '%', pass: cur < T.pointers.public_holding_max_pct, detail: 'Public ' + cur + '%' }); }
    }
    return out;
  }

  // =============================================================================
  // 4a. Ratio tiles
  // =============================================================================
  function colourTiles() {
    const lis = Array.from(document.querySelectorAll('#top-ratios li'));
    if (!lis.length) return;
    const T = thresholds();
    const read = (li) => ({ li, name: ((li.querySelector('.name') || {}).innerText || '').trim().toLowerCase(), val: parseNum((li.querySelector('.value') || li.querySelector('.number') || {}).innerText) });
    const tiles = lis.map(read);
    const B = barsFor(T), lender = !!B.group;
    const stockPE = (tiles.find((t) => t.name === 'stock p/e' || t.name === 'p/e') || {}).val;
    const cmp = (tiles.find((t) => t.name.includes('current price') || t.name === 'cmp') || {}).val;
    tiles.forEach((t) => {
      t.li.classList.remove('px-t-good', 'px-t-bad', 'px-t-warn');
      const n = t.name, v = t.val;
      if (v == null) return;
      let cls = null, why = '';
      if (n === 'stock p/e' || n === 'p/e') { cls = v > B.peMax ? 'bad' : 'good'; why = 'PE ' + (cls === 'good' ? '<' : '>') + ' ' + B.peMax + (lender ? ' (' + B.group + ' list)' : ''); }
      else if (/\bpe\b|p\/e/.test(n) && /(3|5|10)\s*y/.test(n)) { if (stockPE != null) { cls = v > stockPE ? 'good' : 'bad'; why = 'historical PE ' + v + ' vs current ' + stockPE; } }
      else if (n === 'book value') { if (cmp != null) { cls = v < cmp ? null : 'good'; why = 'book value vs price'; } }
      else if (n === 'roce' || n === 'roce %') { if (lender) { t.li.title = 'Plutus: ROCE is not scored for ' + B.group; return; } cls = v < T.roceMin ? 'bad' : 'good'; why = 'ROCE min ' + T.roceMin; }
      else if (n === 'roe' || n === 'roe %') { cls = v < B.roeMin ? 'bad' : 'good'; why = 'ROE min ' + B.roeMin + (lender ? ' (' + B.group + ' list)' : ''); }
      else if (/return on assets|^roa\b/.test(n)) { if (B.roaMin != null) { cls = v > B.roaMin ? 'good' : 'bad'; why = 'ROA min ' + B.roaMin + ' (' + B.group + ' list)'; } }
      else if (/gross npa/.test(n)) { if (B.gnpaMax != null) { cls = v < B.gnpaMax ? 'good' : 'bad'; why = 'Gross NPA max ' + B.gnpaMax + '%'; } }
      else if (/net npa/.test(n)) { if (B.nnpaMax != null) { cls = v < B.nnpaMax ? 'good' : 'bad'; why = 'Net NPA max ' + B.nnpaMax + '%'; } }
      else if (/52w high|52 ?week high|from 52w high|down from 52w/.test(n)) { const d = Math.abs(v); cls = d < T.tiles.high52RedPct ? 'bad' : d < T.tiles.high52YellowPct ? 'warn' : 'good'; why = d.toFixed(1) + '% below 52w high'; }
      else if (/debt to equity|debt\/equity|net debt/.test(n)) { if (lender) { t.li.title = 'Plutus: Net D/E is not scored for ' + B.group; return; } cls = v < T.ndeMax ? 'good' : 'bad'; why = 'D/E max ' + T.ndeMax; }
      else if (/200 ?(sma|dma|day)|down from 200/.test(n)) { cls = v >= T.tiles.smaGreenPct ? 'good' : v >= 0 ? 'warn' : 'bad'; why = v + '% vs 200 DMA'; }
      else if (/\bath\b|all time high|from ath/.test(n)) { const d = Math.abs(v); cls = d > T.tiles.athGreenPct ? 'good' : d > T.tiles.athYellowPct ? 'warn' : null; why = d.toFixed(1) + '% off ATH'; }
      else if (/pledge/.test(n)) { cls = v < T.pledgeMax ? 'good' : 'bad'; why = 'pledge max ' + T.pledgeMax + '%'; }
      else if (/public holding|public shareholding/.test(n)) { cls = v < T.tiles.publicHoldingMaxPct ? 'good' : 'warn'; why = 'public max ' + T.tiles.publicHoldingMaxPct + '%'; }
      else if (/dividend yield/.test(n)) { cls = v >= 1 ? 'good' : null; }
      if (cls) { t.li.classList.add('px-t-' + cls); t.li.title = 'Plutus: ' + why; }
    });
    injectSyntheticTiles(tiles, T);
  }
  /** Plutus numbers Screener does not show as tiles, appended to #top-ratios. */
  function injectSyntheticTiles(tiles, T) {
    const ul = document.getElementById('top-ratios');
    if (!ul || !st.stock || !st.stock.snapshot) return;
    ul.querySelectorAll('li.px-synthetic').forEach((n) => n.remove());
    const snap = st.stock.snapshot, fund = st.stock.fundamentals || {};
    const has = (re) => tiles.some((t) => re.test(t.name));
    const add = (label, valueText, cls, title) => {
      const li = el('li', { class: 'flex flex-space-between px-synthetic' + (cls ? ' px-t-' + cls : ''), title: title || '' }, [
        el('span', { class: 'name', text: label }), el('span', { class: 'value', html: '<span class="number">' + esc(valueText) + '</span>' }),
      ]);
      ul.appendChild(li);
    };
    const below = num(snap.below_200dma_pct);
    if (!has(/200 ?(sma|dma|day)/) && below != null) add('200 DMA', (below >= 0 ? '−' : '+') + Math.abs(below).toFixed(1) + '%', below >= T.buyZone ? 'good' : below >= T.oppZone ? 'warn' : below < 0 ? 'bad' : null, 'Plutus: distance below 200 DMA ₹' + U.fmt(snap.dma_200, 0));
    const ath = num(snap.fall_from_ath_pct);
    if (!has(/\bath\b|all time high/) && ath != null) { const rule = T.athFall[(st.stock.summary || {}).cap] || 30; add('Off ATH', ath.toFixed(1) + '%', ath > rule ? 'good' : ath > rule / 2 ? 'warn' : null, 'Plutus: ATH ₹' + U.fmt(snap.ath, 0) + ' · cap rule > ' + rule + '%'); }
    const pledge = num(fund.promoter_pledging_pct);
    if (!has(/pledge/) && pledge != null) add('Pledged', pledge.toFixed(1) + '%', pledge < T.pledgeMax ? 'good' : 'bad', 'Plutus quarterly sync');
    const pub = num(fund.public_holding_pct);
    if (!has(/public holding/) && pub != null) add('Public holding', pub.toFixed(1) + '%', pub < T.tiles.publicHoldingMaxPct ? 'good' : 'warn', 'Plutus quarterly sync');
    const B = barsFor(T);
    const nde = num(fund.net_debt_to_equity);
    if (!B.group && !has(/net debt/) && nde != null) add('Net debt / equity', nde.toFixed(2), nde < T.ndeMax ? 'good' : 'bad', 'Plutus quarterly sync');
    if (B.group) {
      const roa = num(fund.roa);
      if (!has(/return on assets|^roa\b/) && roa != null) add('Return on assets', roa.toFixed(2) + '%', roa > B.roaMin ? 'good' : 'bad', 'Plutus: ' + B.group + ' list · ROA > ' + B.roaMin + '% (TTM net profit / total assets)');
      const gnpa = num(fund.gross_npa_pct), nnpa = num(fund.net_npa_pct);
      if (!has(/gross npa/) && gnpa != null) add('Gross NPA', gnpa.toFixed(2) + '%', gnpa < B.gnpaMax ? 'good' : 'bad', 'Plutus: latest quarter · max ' + B.gnpaMax + '%');
      if (!has(/net npa/) && nnpa != null) add('Net NPA', nnpa.toFixed(2) + '%', nnpa < B.nnpaMax ? 'good' : 'bad', 'Plutus: latest quarter · max ' + B.nnpaMax + '%');
    }
    const pe5 = num(fund.pe_5y_avg), pe = num(snap.pe_current);
    if (!has(/5 ?y.*pe|pe.*5 ?y/) && pe5 != null) add('5Y avg PE', pe5.toFixed(1), pe != null ? (pe < pe5 ? 'good' : 'bad') : null, 'Plutus: current PE ' + (pe == null ? '—' : pe.toFixed(1)));
  }

  // =============================================================================
  // 4b. Financial tables
  // =============================================================================
  const HL_CLASSES = ['px-c-up', 'px-c-down', 'px-c-warn', 'px-c-alert', 'px-c-best', 'px-c-worst', 'px-c-note'];
  function clearHighlights() {
    document.querySelectorAll('#quarters td, #profit-loss td, #balance-sheet td, #cash-flow td, #shareholding td, #peers td').forEach((td) => { td.classList.remove(...HL_CLASSES); if (td.getAttribute('data-px-title')) { td.removeAttribute('title'); td.removeAttribute('data-px-title'); } });
    document.querySelectorAll('#top-ratios li').forEach((li) => li.classList.remove('px-t-good', 'px-t-bad', 'px-t-warn'));
    document.querySelectorAll('#top-ratios li.px-synthetic, .px-peer-chip').forEach((n) => n.remove());
  }
  function mark(td, cls, title) {
    td.classList.remove(...HL_CLASSES);
    td.classList.add(cls);
    if (title) { td.setAttribute('title', title); td.setAttribute('data-px-title', '1'); }
  }
  const isIncomeOutlierRow = (l) => /other income|exceptional/i.test(l);
  const isExpenseRow = (l) => !isIncomeOutlierRow(l) && !/profit|sales|revenue|margin|opm|income|eps|tax|dividend/i.test(l) && /expense|material|cost|power|fuel|freight|employee|manufactur/i.test(l);
  const isReverseRow = (l) => !isIncomeOutlierRow(l) && !/profit|sales|revenue|opm|income|eps|growth|dividend|margin/i.test(l) && (isExpenseRow(l) || /depreciation|interest|tax|borrowing|debt|liabilit/i.test(l));

  function prevPeriodIndex(headers, idx) {
    const h = headers[idx] || '';
    let m = /([A-Z][a-z]{2}) (\d{4})/.exec(h);
    if (m) { const want = m[1] + ' ' + (Number(m[2]) - 1); const j = headers.findIndex((x) => x.startsWith(want)); if (j > 0) return j; }
    m = /\b(19\d\d|20\d\d)\b/.exec(h);
    if (m) { const j = headers.findIndex((x) => x.includes(String(Number(m[1]) - 1))); if (j > 0) return j; }
    return idx > 1 ? idx - 1 : -1;
  }

  function highlightTable(secId) {
    const table = sectionTable(secId);
    if (!table || table.getAttribute('data-px-done') === String(table.rows.length)) return;
    const H = tableHeaders(table);          // H[0] is the blank label header
    const rows = tableRows(table);
    if (!rows.length) return;
    const sales = findRow(rows, /^(sales|revenue)/i);
    const salesVals = sales ? sales.values : [];

    rows.forEach((r) => {
      const label = r.label;
      if (!label || /growth/i.test(label)) return;
      const vals = r.values;
      const cells = r.cells.slice(1);

      // Other income / exceptional items: statistical outliers get yellow.
      if (isIncomeOutlierRow(label)) {
        const nums = vals.filter((v) => v != null);
        if (nums.length >= 4) {
          const sorted = nums.slice().sort((a, b) => a - b);
          const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
          const q1 = q(.25), med = q(.5), q3 = q(.75);
          const iqr = Math.max(q3 - q1, Math.abs(med) * .2, 2);
          const nonzero = nums.filter((v) => v !== 0).map(Math.abs).sort((a, b) => a - b);
          const mnz = nonzero.length ? nonzero[Math.floor(nonzero.length / 2)] : 0;
          vals.forEach((v, i) => {
            if (v == null) return;
            if (/exceptional/i.test(label)) {
              const light = Math.max(4, 1.2 * mnz), darkPos = Math.max(15, 3 * mnz), darkNeg = -Math.max(10, 2.5 * mnz);
              if (v <= darkNeg || v >= darkPos) mark(cells[i], 'px-c-alert', 'Exceptional item — extreme vs history');
              else if (Math.abs(v) >= light) mark(cells[i], 'px-c-warn', 'Exceptional item — check the notes');
            } else if (Math.max(...nums) - Math.min(...nums) >= 3) {
              if (v >= q3 + .2 * iqr || (v <= q1 - .5 * iqr && q1 - .5 * iqr < 0)) mark(cells[i], 'px-c-alert', 'Other income spike vs history (median ' + med + ')');
              else if (v >= med + .18 * iqr || (v <= q1 - .2 * iqr && q1 - .2 * iqr < 0)) mark(cells[i], 'px-c-warn', 'Other income elevated vs history');
            }
          });
        }
        return;
      }

      const expense = isExpenseRow(label), reverse = isReverseRow(label);
      const ratio = (i) => (expense && salesVals[i] > 0 && vals[i] != null ? vals[i] / salesVals[i] * 100 : null);

      // Period-over-period (same period last year when headers allow).
      vals.forEach((v, i) => {
        if (v == null) return;
        const hIdx = i + 1;                         // header index includes the label column
        const pj = prevPeriodIndex(H, hIdx) - 1;    // back to values[] index
        if (pj < 0 || vals[pj] == null) return;
        const pv = vals[pj], prevLabel = H[pj + 1];
        if (expense) {
          const cur = ratio(i), prev = ratio(pj);
          if (cur != null && prev != null) mark(cells[i], cur > prev + 0.05 ? 'px-c-down' : cur < prev - 0.05 ? 'px-c-up' : 'px-c-note', label + ': ' + cur.toFixed(1) + '% of sales (' + prevLabel + ': ' + prev.toFixed(1) + '%)');
        } else if (reverse) {
          if (v > pv) mark(cells[i], 'px-c-down', 'Up vs ' + prevLabel + ' (' + pv + ')'); else if (v < pv) mark(cells[i], 'px-c-up', 'Down vs ' + prevLabel + ' (' + pv + ')');
        } else {
          if (v > pv) mark(cells[i], 'px-c-up', 'Up ' + ((v - pv) / Math.abs(pv || 1) * 100).toFixed(1) + '% vs ' + prevLabel);
          else if (v < pv) mark(cells[i], 'px-c-down', 'Down ' + ((pv - v) / Math.abs(pv || 1) * 100).toFixed(1) + '% vs ' + prevLabel);
        }
      });

      // Row extrema
      let bestI = -1, worstI = -1;
      if (expense) {
        let best = Infinity, worst = -Infinity;
        vals.forEach((v, i) => { const r2 = ratio(i); if (r2 == null) return; if (r2 < best) { best = r2; bestI = i; } if (r2 > worst) { worst = r2; worstI = i; } });
      } else {
        let best = -Infinity, worst = Infinity;
        vals.forEach((v, i) => { if (v == null) return; if (v > best) { best = v; bestI = i; } if (v < worst) { worst = v; worstI = i; } });
        if (reverse) { const t = bestI; bestI = worstI; worstI = t; }
      }
      if (bestI >= 0 && bestI !== worstI) mark(cells[bestI], 'px-c-best', 'Best in row');
      if (worstI >= 0 && bestI !== worstI && (expense || reverse)) mark(cells[worstI], 'px-c-worst', 'Worst in row');
    });
    table.setAttribute('data-px-done', String(table.rows.length));
  }

  // =============================================================================
  // 4c. Shareholding
  // =============================================================================
  function highlightShareholding() {
    const table = sectionTable('shareholding');
    if (!table || table.getAttribute('data-px-done') === String(table.rows.length)) return;
    tableRows(table).forEach((r) => {
      const l = r.label.toLowerCase();
      if (!l || /no\. of shareholder|total/.test(l) || !/public|promoter|fii|dii|govt|government|other/.test(l)) return;
      const isPublic = /public/.test(l);
      const cells = r.cells.slice(1), vals = r.values;
      for (let i = 1; i < vals.length; i++) {
        if (vals[i] == null || vals[i - 1] == null || vals[i] === vals[i - 1]) continue;
        const up = vals[i] > vals[i - 1];
        const good = isPublic ? !up : up;
        mark(cells[i], good ? 'px-c-up' : 'px-c-warn', (up ? '+' : '') + (vals[i] - vals[i - 1]).toFixed(2) + ' pts QoQ');
      }
      const nums = vals.map((v, i) => [v, i]).filter((x) => x[0] != null);
      if (nums.length) { const best = nums.reduce((a, b) => (isPublic ? (b[0] < a[0] ? b : a) : (b[0] > a[0] ? b : a))); mark(cells[best[1]], 'px-c-best', isPublic ? 'Lowest public holding' : 'Highest'); }
    });
    table.setAttribute('data-px-done', String(table.rows.length));
  }

  // =============================================================================
  // 4d. Peers — best in column, thresholds, universe membership
  // =============================================================================
  function highlightPeers() {
    const table = sectionTable('peers');
    if (!table || table.getAttribute('data-px-done') === String(table.rows.length)) return;
    const T = thresholds(), B = barsFor(T);
    const H = tableHeaders(table).map((h) => h.toLowerCase());
    const rows = tableRows(table);
    H.forEach((h, col) => {
      if (col < 2 || !h) return;
      const lowBetter = /p\/e|debt|pe\b|npa/.test(h);
      const skip = /mar cap|cmp|price|s\.no|name/.test(h);
      if (skip) return;
      let best = null;
      rows.forEach((r) => {
        const td = r.cells[col]; const v = parseNum(td ? td.innerText : null);
        if (v == null) return;
        if (/p\/e/.test(h)) mark(td, v > B.peMax ? 'px-c-down' : 'px-c-up', 'PE vs ' + B.peMax);
        else if (/roce/.test(h)) { if (!B.group) mark(td, v < T.roceMin ? 'px-c-down' : 'px-c-up', 'ROCE vs ' + T.roceMin); }
        else if (/roe/.test(h)) mark(td, v < B.roeMin ? 'px-c-down' : 'px-c-up', 'ROE vs ' + B.roeMin);
        if (best == null || (lowBetter ? v < best.v : v > best.v)) best = { v, td };
      });
      if (best) mark(best.td, 'px-c-best', 'Best in column');
    });
    // Universe membership chips on the name cell
    rows.forEach((r) => {
      const a = r.tr.querySelector('a[href*="/company/"]');
      if (!a) return;
      const m = /\/company\/([^\/]+)/.exec(a.getAttribute('href') || '');
      const sym = m ? S.toPlutus(decodeURIComponent(m[1])) : null;
      const e = sym && st.stocks.get(sym);
      if (e && !a.parentNode.querySelector('.px-peer-chip')) {
        const parts = [(e.pools || []).join('/'), e.funda_points != null ? e.funda_points + '/11' : null, e.best_status && e.best_status !== 'NO_SIGNAL' && e.best_status !== 'INVALID' ? e.best_status.replace('_', ' ') : null].filter(Boolean);
        a.parentNode.appendChild(el('span', { class: 'px-peer-chip', text: parts.join(' · ') || 'Plutus', title: 'In the Plutus universe' }));
      }
    });
    table.setAttribute('data-px-done', String(table.rows.length));
  }

  // =============================================================================
  // 5. Charts modal
  // =============================================================================
  function removeFabs() { ['px-fab-fund', 'px-fab-shd', 'px-viz'].forEach((id) => { const n = document.getElementById(id); if (n) n.remove(); }); }
  function injectFabs() {
    if (typeof Chart === 'undefined' || document.getElementById('px-fab-fund')) return;
    if (!sectionTable('quarters') && !sectionTable('profit-loss')) return;
    document.body.appendChild(el('button', { class: 'px-fab', id: 'px-fab-fund', title: 'Plutus: fundamentals charts', text: '📊', onclick: () => openViz('fund') }));
    document.body.appendChild(el('button', { class: 'px-fab', id: 'px-fab-shd', title: 'Plutus: shareholding charts', text: '👥', onclick: () => openViz('shd') }));
  }
  function seriesFrom(secId, labelRe) {
    const table = sectionTable(secId);
    if (!table) return null;
    const labels = tableHeaders(table).slice(1);
    const row = findRow(tableRows(table), labelRe);
    if (!row) return null;
    return { labels, values: row.values.map((v) => (v == null ? 0 : v)) };
  }
  function openViz(kind) {
    let modal = document.getElementById('px-viz');
    if (modal) modal.remove();
    Object.values(st.charts).forEach((c) => { try { c.destroy(); } catch (e) { /* ignore */ } }); st.charts = {};
    const grid = el('div', { class: 'px-viz-grid' });
    modal = el('div', { id: 'px-viz' }, [
      el('div', { class: 'px-viz-head' }, [el('h2', { text: 'Plutus · ' + st.ticker + (kind === 'fund' ? ' — fundamentals' : ' — shareholding') }),
        el('button', { class: 'px-btn', text: kind === 'fund' ? '👥 Shareholding' : '📊 Fundamentals', onclick: () => openViz(kind === 'fund' ? 'shd' : 'fund') }),
        el('button', { class: 'px-btn', text: '✕ Close', onclick: () => modal.remove() })]),
      grid,
    ]);
    document.body.appendChild(modal);
    const onKey = (e) => { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', onKey, true); } };
    document.addEventListener('keydown', onKey, true);
    const specs = kind === 'fund'
      ? [['Quarterly sales (₹ Cr)', 'quarters', /^(sales|revenue)/i], ['Quarterly net profit (₹ Cr)', 'quarters', /^net profit/i], ['Quarterly OPM %', 'quarters', /^opm/i],
        ['Annual sales (₹ Cr)', 'profit-loss', /^(sales|revenue)/i], ['Annual net profit (₹ Cr)', 'profit-loss', /^net profit/i], ['Annual OPM %', 'profit-loss', /^opm/i],
        ['EPS (₹)', 'profit-loss', /^eps/i], ['Interest (₹ Cr)', 'profit-loss', /^interest/i], ['Borrowings (₹ Cr)', 'balance-sheet', /^borrowings/i]]
      : [['Promoters %', 'shareholding', /^promoter/i], ['FIIs %', 'shareholding', /^fii/i], ['DIIs %', 'shareholding', /^dii/i], ['Public %', 'shareholding', /^public/i], ['Government %', 'shareholding', /^gov/i], ['No. of shareholders', 'shareholding', /shareholders/i]];
    specs.forEach(([title, sec, re], i) => {
      const s = seriesFrom(sec, re);
      if (!s) return;
      const canvas = el('canvas');
      grid.appendChild(el('div', { class: 'px-viz-box' }, [canvas]));
      const colors = s.values.map((v, j) => (j > 0 && v < s.values[j - 1] ? 'rgba(239,68,68,.85)' : 'rgba(15,118,110,.85)'));
      st.charts['c' + i] = new Chart(canvas, {
        type: 'bar',
        data: { labels: s.labels, datasets: [{ data: s.values, backgroundColor: colors, borderRadius: 3 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, title: { display: true, text: title } }, scales: { x: { grid: { display: false } } } },
      });
    });
    if (!grid.children.length) grid.appendChild(el('div', { class: 'px-muted', text: 'No tables found on this page yet.' }));
  }

  // =============================================================================
  // Actions (token-gated)
  // =============================================================================
  function screenerPrice() {
    const li = Array.from(document.querySelectorAll('#top-ratios li')).find((n) => /current price/i.test(((n.querySelector('.name') || {}).innerText || '')));
    return li ? parseNum((li.querySelector('.value') || li.querySelector('.number') || {}).innerText) : null;
  }
  function sizerDialog(data) {
    if (needToken('The sizer')) return;
    const sm = data.summary || {}, snap = data.snapshot || {};
    const pagePrice = screenerPrice();
    const entry = pagePrice || num(snap.close);
    const pos = st.positions && st.positions.get(data.plain);
    window.PlutusSizer.open({
      symbol: data.symbol, cap: sm.cap || null, entry, entryLabel: pagePrice ? 'Screener price' : 'last close',
      snapshot: Object.assign({}, snap), heldValue: pos ? Number(pos.invested) || 0 : 0, settings: st.settings,
    });
  }
  function needToken(what) { if (!st.settings.token) { U.toast(what + ' needs a Plutus token — open the extension popup', 'error'); return true; } return false; }
  function noteDialog(symbol) {
    if (needToken('Notes')) return;
    const plain = S.toPlain(symbol);
    const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const text = el('textarea', { placeholder: 'Your view on ' + plain + ' today — thesis, results read, valuation, risks, triggers…' });
    const recent = el('div', { class: 'px-muted', text: 'Loading recent notes…' });
    U.send({ type: 'notes.list', symbol, limit: 3 }).then((r) => {
      const notes = r.notes || [];
      recent.innerHTML = notes.length ? '<b>Recent:</b> ' + notes.map((n) => esc(n.note_date) + ' — ' + esc(String(n.content).slice(0, 90)) + (n.content.length > 90 ? '…' : '')).join('<br>') : 'No notes yet for ' + esc(plain) + '.';
    }).catch((e) => { recent.textContent = e.message; });
    U.dialog({ title: 'Plutus note · ' + plain, actionLabel: 'Save note', body: el('div', {}, [el('label', {}, ['View as of', date]), el('label', {}, ['Note', text]), recent]),
      onConfirm: async () => { if (!text.value.trim()) throw new Error('Write something first'); await U.send({ type: 'notes.create', symbol, content: text.value.trim(), note_date: date.value }); U.toast('Note saved to Plutus', 'success'); } });
  }
  async function bookmarkDialog(symbol) {
    let lists = [];
    try { lists = (await U.send({ type: 'watchlists' })).watchlists || []; } catch (e) { U.toast(e.message, 'error'); return; }
    const plain = S.toPlain(symbol);
    const list = el('div', { class: 'px-radio-list' });
    lists.forEach((w, i) => list.appendChild(el('label', {}, [el('input', { type: 'radio', name: 'px-wl', value: String(w.id), ...(i === 0 ? { checked: 'checked' } : {}) }), w.name + ' (' + (w.symbols || []).length + ')' + ((w.symbols || []).includes(symbol) ? ' — already in' : '')])));
    list.appendChild(el('label', {}, [el('input', { type: 'radio', name: 'px-wl', value: '__new__' }), '＋ New watchlist…']));
    U.dialog({ title: 'Bookmark ' + plain, actionLabel: 'Add', body: list,
      onConfirm: async (card) => {
        const v = (card.querySelector('input[name=px-wl]:checked') || {}).value;
        if (!v) throw new Error('Pick a list');
        if (v === '__new__') {
          const name = el('input', { type: 'text', placeholder: 'Name' });
          setTimeout(() => U.dialog({ title: 'New watchlist', actionLabel: 'Create', body: el('label', {}, ['Name', name]), onConfirm: async () => { if (!name.value.trim()) throw new Error('Name is required'); await U.send({ type: 'watchlist.create', name: name.value.trim(), symbols: [symbol] }); U.toast(plain + ' added to ' + name.value.trim(), 'success'); } }), 0);
          return true;
        }
        const res = await U.send({ type: 'watchlist.add', id: isNaN(Number(v)) ? v : Number(v), symbols: [symbol] });
        U.toast(((res.added || []).length ? plain + ' added to ' : plain + ' already in ') + (res.watchlist || {}).name, 'success');
      } });
  }
  async function playAreaAdd(symbol) {
    if (needToken('PlayArea')) return;
    try { const r = await U.send({ type: 'playarea.add', symbol }); U.toast(S.toPlain(symbol) + (r.already_member ? ' is already in PlayArea' : ' added to PlayArea — Plutus data arrives on the next sync'), 'success'); await loadPlutus(); removeCard(); run(); }
    catch (e) { U.toast(e.message, 'error'); }
  }
  async function playAreaRemove(symbol) {
    if (needToken('PlayArea')) return;
    try { await U.send({ type: 'playarea.remove', symbol }); U.toast(S.toPlain(symbol) + ' removed from PlayArea', 'success'); await loadPlutus(); removeCard(); run(); }
    catch (e) { U.toast(e.message, 'error'); }
  }
  function opportunityDialog(data) {
    if (needToken('Opportunities')) return;
    const sm = data.summary || {}, close = num((data.snapshot || {}).close);
    const price = el('input', { type: 'number', step: '0.05', value: close != null ? String(close) : '' });
    const qty = el('input', { type: 'number', step: '1', placeholder: 'optional' });
    const target = el('input', { type: 'number', step: '0.05', placeholder: 'optional' });
    const strategy = el('select', {});
    ['', 'Envelope (200 DMA)', '52-Week Low', '20% Rally', 'Fundamental', 'Other'].forEach((s) => strategy.appendChild(el('option', { value: s, text: s || '— strategy —' })));
    const action = el('select', {});
    ['Analyse Now', 'Buy Now', 'GTT', 'Later'].forEach((s) => action.appendChild(el('option', { value: s, text: s })));
    const notes = el('textarea', { placeholder: 'Why now?', style: 'min-height:70px' });
    U.dialog({ title: 'Add opportunity · ' + data.plain, actionLabel: 'Add to journal',
      body: el('div', {}, [el('label', {}, ['Buy / reference price (₹)', price]), el('label', {}, ['Qty', qty]), el('label', {}, ['Target (₹)', target]), el('label', {}, ['Strategy', strategy]), el('label', {}, ['Action', action]), el('label', {}, ['Notes', notes])]),
      onConfirm: async () => {
        const body = { symbol: data.symbol, opp_date: new Date().toISOString().slice(0, 10), buy_price: price.value || null, qty: qty.value ? Number(qty.value) : null, target_price: target.value || null,
          strategy: strategy.value || null, action_filter: action.value, notes: notes.value.trim() || null, cap_bucket: sm.cap || null, status: 'ACTIVE' };
        await U.send({ type: 'opportunity.create', body });
        U.toast('Opportunity added to the Plutus journal', 'success');
      } });
  }

  // ---- go ----------------------------------------------------------------------
  if (document.body) start(); else window.addEventListener('DOMContentLoaded', start);
})();
