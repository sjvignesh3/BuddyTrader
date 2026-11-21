/**
 * Plutus Companion — TradingView content script.
 *
 * A floating panel over the chart that lists Plutus pools and custom
 * watchlists, switches the chart symbol instantly, follows the chart's
 * active symbol, and shows Plutus signals per row. A side drawer follows the
 * selected stock (Filters · Stock · Trades · Notes). Hot-keys make the whole
 * analysis loop keyboard-driven.
 *
 * Data comes only from the service worker (background.js); this file never
 * fetches anything itself. Pure list logic lives in shared/panel_logic.js.
 */
(function () {
  'use strict';
  if (window.__plutusTvLoaded) { if (typeof window.__plutusTvReload === 'function') window.__plutusTvReload(); return; }
  window.__plutusTvLoaded = true;

  const S = window.PlutusSymbols, U = window.PlutusUI, SET = window.PlutusSettings, L = window.PlutusPanelLogic, C = window.PlutusCard;
  const el = U.el, esc = U.esc, num = U.num;

  // ---- TradingView selectors (one place to fix after a TradingView redeploy) ----
  const TV = {
    // Verified against the live chart on 2026-09-24: button text = ticker, dialog data-name =
    // "symbol-search-items-dialog", the input has no data-role (placeholder "Symbol, ISIN, or CUSIP"),
    // Enter alone applies the symbol.
    searchButton: ['#header-toolbar-symbol-search', '[data-name="header-toolbar-symbol-search"]', 'button[aria-label*="Symbol Search" i]', '[class*="symbolSearch-"]'],
    dialog: ['div[data-name="symbol-search-items-dialog"]', 'div[data-name="symbol-search-dialog"]', 'div[data-dialog-name="symbol-search"]', '#overlap-manager-root [role="dialog"]', '#overlap-manager-root'],
    input: ['input[data-role="search"]', 'input[type="text"]', 'input'],
    firstResult: ['[data-role="list-item"]', '[class*="item-"][class*="withEllipsis"]'],
    close: ['button[data-name="close"]', '[class*="closeButton-"]'],
    legend: ['[data-name="legend-series-item"]', '[class*="legendMainSourceTitle-"]', '[class*="legendMainSourceWrapper-"]'],
  };
  const q1 = (sels, root) => { for (const s of sels) { const n = (root || document).querySelector(s); if (n) return n; } return null; };

  const SIGNAL_WEIGHT = { BUY_ZONE: 3, OPPORTUNITY: 2, VALID: 1.5 };
  const SIGNAL_CHIP = { BUY_ZONE: ['BUY', 'px-chip-buy'], OPPORTUNITY: ['OPP', 'px-chip-opp'], VALID: ['RALLY', 'px-chip-rally'] };
  const CAP_LETTER = { Mega: 'XL', Large: 'L', Mid: 'M', Small: 'S', Micro: 'S' };

  const LS_LAYOUT = 'plutus_tv_layout_v1';
  const LS_ACTIVE = 'plutus_tv_active_list_v1';
  // Shared with the Screener walk-through pill (chrome.storage.local, not page storage).
  const NAV_KEY = 'plutus_nav';
  const DRAWER_W = 320;
  const DRAWER_TABS = [['filters', 'Filters'], ['stock', 'Stock'], ['trades', 'Trades'], ['notes', 'Notes']];

  // ---- state ------------------------------------------------------------------
  const st = {
    settings: null,
    boot: null,                 // bootstrap payload
    stocks: new Map(),          // "TCS.NS" -> entry
    watchlists: [],             // custom lists [{id,name,symbols}]
    wlSource: 'local',
    positions: new Map(),       // "TCS" -> {qty, invested}
    active: null,               // {kind:'pool'|'wl'|'sector', id, name}
    activeSymbol: null,         // Plutus form of what the chart shows
    region: 'IN',               // IN | US (F1)
    capFilter: 'All',
    sectorFilter: 'All',        // F2
    filter: '',
    sort: { key: 'default', dir: 'asc' },
    switchTimer: null,
    lastSwitchAt: 0,
    loading: false,
    error: null,
    notes: { symbol: null, items: [], loading: false, error: null, editing: null },
    live: new Map(),            // "TCS.NS" -> {close, chgPct, chg, at, stale?}  (F7, display only)
    liveTimer: null,
    liveState: 'off',           // off | live | paused
    chips: {},                  // check id -> 'pass' | 'nofail'  (F8)
    allPass: false,
    stockCache: new Map(),      // "TCS.NS" -> {data|null, error, at}  for the Stock tab / hover card
    trades: { symbol: null, data: null, loading: false, error: null },
  };
  let panel, toggleBtn, listEl, headerEl, selectEl, slicerEl, regionEl, filterInput, sectorSelect, asofEl, liveEl, bannerEl, addRow, addInput, hintEl, focusBtn, linkBtn, heldEl, wideBtn, drawerBtn;
  let drawer, drawerBody, drawerTabsEl, drawerTitleEl, hoverEl;

  // =============================================================================
  // Boot
  // =============================================================================
  async function start() {
    st.settings = await SET.get();
    st.region = st.settings.tvRegion === 'US' ? 'US' : 'IN';
    st.sort = { key: st.settings.tvSort || 'default', dir: st.settings.tvSortDir || (L.SORT_KEYS[st.settings.tvSort] || L.SORT_KEYS.default).dir };
    buildUI();
    if (!st.settings.tvEnabled) panel.classList.add('px-collapsed');
    if (!st.settings.tvPanelOpen) panel.classList.add('px-collapsed');
    applyFocusMode();
    restoreActiveList();
    await loadAll();
    syncActiveSymbol();
    [400, 1200, 2500, 5000].forEach((ms) => setTimeout(syncActiveSymbol, ms));
    window.addEventListener('focus', syncActiveSymbol);
    observeTitle();
    SET.onChange((s) => {
      const regionChanged = (s.tvRegion || 'IN') !== st.region;
      st.settings = s;
      if (s.tvSort && (s.tvSort !== st.sort.key || (s.tvSortDir && s.tvSortDir !== st.sort.dir))) st.sort = { key: s.tvSort, dir: s.tvSortDir || (L.SORT_KEYS[s.tvSort] || L.SORT_KEYS.default).dir };
      if (regionChanged) setRegion(s.tvRegion === 'US' ? 'US' : 'IN', { silent: true });
      applyFocusMode(); renderAll(); scheduleLive(true);
    });
    document.addEventListener('visibilitychange', () => scheduleLive(true));
    scheduleLive(true);
    if (U.contextAlive()) {
      chrome.runtime.onMessage.addListener((m) => {
        if (!m) return;
        if (m.type === 'plutus:bootstrap-updated') loadAll();
        if (m.type === 'plutus:switch-symbol') followLinkedSymbol(m.symbol);
        if (m.type === 'plutus:token-state') { st.tokenRejected = !!m.rejected; renderBanner(); if (!m.rejected) loadAll(); }
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[NAV_KEY]) adoptNavFromScreener(changes[NAV_KEY].newValue);
      });
    }
  }
  window.__plutusTvReload = () => loadAll();

  async function loadAll() {
    st.loading = true; st.error = null; renderBanner();
    try {
      const [boot, wl, pos, lots] = await Promise.all([
        U.send({ type: 'bootstrap' }, 95000),
        U.send({ type: 'watchlists' }).catch((e) => ({ source: 'local', watchlists: [], _error: e.message })),
        U.send({ type: 'positions' }).catch(() => ({ positions: [] })),
        U.send({ type: 'trades.open' }).catch(() => ({ trades: [] })),
      ]);
      // US tickers have no suffix: tell the converter which bare tickers are
      // US and where they list, so the chart opens NASDAQ:NVDA, not NSE:NVDA.
      S.registerUs(boot.stocks || []);
      (wl.watchlists || []).forEach((w) => S.registerUs((w.symbols || []).filter((x) => S.isUs(x))));
      st.boot = boot;
      st.stocks = new Map((boot.stocks || []).map((s) => [s.symbol, s]));
      st.watchlists = wl.watchlists || [];
      st.wlSource = wl.source || 'local';
      st.positions = new Map((pos.positions || []).map((p) => [String(p.symbol).toUpperCase(), p]));
      st.lots = new Map();
      (lots.trades || []).forEach((t) => {
        const k = String(t.symbol || '').toUpperCase();
        if (!st.lots.has(k)) st.lots.set(k, []);
        st.lots.get(k).push(t);
      });
      if (boot._stale) st.error = 'Plutus API unreachable — showing cached data (' + (boot._error || '') + ')';
      U.send({ type: 'token.state' }).then((t) => { st.tokenRejected = !!(t && t.rejected); renderBanner(); }).catch(() => {});
    } catch (e) {
      st.error = e.message;
    }
    st.loading = false;
    if (!st.active || !listExists(st.active)) st.active = defaultList();
    renderAll();
  }

  // =============================================================================
  // Lists (pools · watchlists · sector views), per region
  // =============================================================================
  function allStocks() { return Array.from(st.stocks.values()); }
  function hasUs() { return allStocks().some((s) => L.marketOfEntry(s) === 'US') || pools().some((p) => p.market === 'US'); }
  function pools() { return (st.boot && st.boot.pools) || []; }
  function poolsInRegion() { const all = allStocks(); return pools().filter((p) => L.poolMarket(p, all) === st.region); }
  function watchlistsInRegion() { return st.watchlists.filter((w) => L.listVisibleIn(st.region, L.listMarket(w.symbols, st.stocks))); }
  function regionStocks() { return allStocks().filter((s) => L.marketOfEntry(s) === st.region); }
  function sectorsInRegion() { return L.sectorCounts(regionStocks()).sectors; }

  function listExists(a) {
    if (!a) return false;
    if (a.kind === 'pool') return pools().some((p) => p.code === a.id);
    if (a.kind === 'sector') return sectorsInRegion().some(([name]) => name === a.id);
    return st.watchlists.some((w) => String(w.id) === String(a.id));
  }
  function listInRegion(a) {
    if (!a) return false;
    if (a.kind === 'pool') return poolsInRegion().some((p) => p.code === a.id);
    if (a.kind === 'sector') return sectorsInRegion().some(([name]) => name === a.id);
    return watchlistsInRegion().some((w) => String(w.id) === String(a.id));
  }
  function defaultList() {
    const p = poolsInRegion()[0];
    if (p) return { kind: 'pool', id: p.code, name: p.name };
    const w = watchlistsInRegion()[0];
    if (w) return { kind: 'wl', id: w.id, name: w.name };
    const anyPool = pools()[0];
    return anyPool ? { kind: 'pool', id: anyPool.code, name: anyPool.name } : null;
  }
  function restoreActiveList() {
    try { const raw = localStorage.getItem(LS_ACTIVE); if (raw) st.active = JSON.parse(raw); } catch (e) { /* ignore */ }
  }
  function saveActiveList() { try { localStorage.setItem(LS_ACTIVE, JSON.stringify(st.active)); } catch (e) { /* ignore */ } }

  /** Symbols (Plutus form) of the active list, in list order. */
  function activeSymbols() {
    if (!st.active) return [];
    if (st.active.kind === 'pool') {
      return allStocks().filter((s) => (s.pools || []).includes(st.active.id)).map((s) => s.symbol).sort();
    }
    if (st.active.kind === 'sector') {
      return regionStocks().filter((s) => L.sectorOf(s) === st.active.id).map((s) => s.symbol).sort();
    }
    const w = st.watchlists.find((x) => String(x.id) === String(st.active.id));
    return w ? (w.symbols || []).slice() : [];
  }
  function activeWatchlist() {
    return st.active && st.active.kind === 'wl' ? st.watchlists.find((x) => String(x.id) === String(st.active.id)) : null;
  }

  /**
   * One row. Nightly numbers come from the bootstrap; when a live quote is
   * known the distances are recomputed against the Plutus levels (200 DMA,
   * 52-week high, ATH), so the levels stay Plutus' and only the price moves.
   */
  function rowFor(symbol) {
    const e = st.stocks.get(symbol);
    const plain = S.toPlain(symbol);
    const q = st.live.get(symbol) || null;
    const close = e ? num(e.close) : null;
    const last = q ? q.close : close;
    const dma = e ? num(e.dma_200) : null, hi52 = e ? num(e.high_52w) : null, ath = e ? num(e.ath) : null;
    const below = q && dma ? (dma - q.close) / dma * 100 : (e ? num(e.below_200dma_pct) : null);
    const off52 = q && hi52 ? (q.close / hi52 - 1) * 100 : (e ? num(e.distance_from_52w_high_pct) : null);
    const athFall = q && ath ? (1 - q.close / ath) * 100 : (e ? num(e.fall_from_ath_pct) : null);
    return {
      symbol, plain,
      entry: e || null,
      name: e ? e.name : null,
      market: L.marketOfEntry(e, symbol),
      cap: L.capLabel(e),
      sector: L.sectorOf(e),
      status: e ? e.best_status : null,
      points: e ? e.funda_points : null,
      checks: e ? e.checks || null : null,
      below, athFall, off52,
      chgPct: q && q.chgPct != null ? q.chgPct : (e ? num(e.price_change_1d_pct) : null),
      mcap: e ? num(e.market_cap) : null,
      close, last,
      live: !!q && !q.stale,
      held: st.positions.get(plain) || null,
    };
  }

  /** Per-rule chip filter (F8): 'pass' needs true, 'nofail' allows n/a; n/a never counts as a pass. */
  function passesChips(r) {
    const ids = Object.keys(st.chips);
    if (st.allPass) {
      if (!r.checks) return false;
      return Object.values(r.checks).length > 0 && Object.values(r.checks).every((v) => v === true);
    }
    if (!ids.length) return true;
    if (!r.checks) return false;
    return ids.every((id) => {
      const v = r.checks[id];
      return st.chips[id] === 'pass' ? v === true : v !== false;
    });
  }
  function chipsActive() { return st.allPass || Object.keys(st.chips).length > 0; }

  function conviction(r) {
    const sig = r.status ? (SIGNAL_WEIGHT[r.status] || 0) : 0;
    const score = r.points == null ? -1 : r.points;
    if (sig >= 3 && score >= 8) return 'PRIME';
    if (sig >= 3 || (sig >= 2 && score >= 8)) return 'STRONG';
    if (sig >= 1.5 || score >= 8) return 'WATCH';
    return null;
  }

  function visibleRows() {
    let rows = activeSymbols().map(rowFor);
    if (st.capFilter !== 'All') rows = rows.filter((r) => L.capMatches(st.capFilter, r.cap || 'Unknown'));
    if (st.sectorFilter !== 'All') rows = rows.filter((r) => st.sectorFilter === '__none__' ? !r.sector : r.sector === st.sectorFilter);
    const f = st.filter.trim().toUpperCase();
    if (f) rows = rows.filter((r) => r.plain.includes(f) || (r.name || '').toUpperCase().includes(f));
    if (chipsActive()) rows = rows.filter(passesChips);
    rows.sort(L.comparator(st.sort.key, st.sort.dir));
    return rows;
  }

  // =============================================================================
  // UI
  // =============================================================================
  function buildUI() {
    toggleBtn = el('button', { id: 'px-tv-toggle', title: 'Plutus panel (Alt+W)', 'aria-label': 'Plutus panel', onclick: togglePanel }, [U.logo(34)]);
    document.body.appendChild(toggleBtn);

    panel = el('div', { id: 'px-tv-panel' });
    // header
    asofEl = el('span', { class: 'px-asof' });
    liveEl = el('span', { class: 'px-live', style: 'display:none', title: '', onclick: () => SET.save({ tvLivePrices: !st.settings.tvLivePrices }) });
    focusBtn = el('button', { class: 'px-icon-btn', title: 'Focus mode: hide TradingView upsell dialogs', text: '◐', onclick: () => SET.save({ tvFocusMode: !st.settings.tvFocusMode }) });
    linkBtn = el('button', { class: 'px-icon-btn', title: 'Link tabs: an open Screener company tab follows this chart, and the chart follows Screener', text: '⇄', onclick: () => SET.save({ linkTabs: !st.settings.linkTabs }) });
    drawerBtn = el('button', { class: 'px-icon-btn', title: 'Drawer: filters, stock, trades, notes (Alt+D)', text: '☰', onclick: () => toggleDrawer() });
    const header = el('div', { class: 'px-header' }, [
      el('span', { class: 'px-title' }, [U.logo(18), 'Plutus']),
      asofEl,
      liveEl,
      el('span', { class: 'px-header-spacer' }),
      drawerBtn,
      el('button', { class: 'px-icon-btn', title: 'Size a position for the active stock (Z)', text: '⚖', onclick: () => sizerDialog(currentSymbol()) }),
      linkBtn,
      el('button', { class: 'px-icon-btn', title: 'Refresh Plutus data', text: '↻', onclick: () => refresh(true) }),
      focusBtn,
      el('button', { class: 'px-icon-btn', title: 'Open Plutus', text: '⌂', onclick: () => window.open(st.settings.webAppUrl, '_blank') }),
      wideBtn = el('button', { class: 'px-icon-btn', title: 'Expand the panel (Alt+E)', text: '⤢', onclick: toggleWide }),
      el('button', { class: 'px-icon-btn', title: 'Hide (Alt+W)', text: '✕', onclick: togglePanel }),
    ]);
    makeDraggable(header);
    panel.appendChild(header);

    bannerEl = el('div', { class: 'px-banner', style: 'display:none' });
    panel.appendChild(bannerEl);

    // region switch (F1) — rendered only when the universe has US stocks
    regionEl = el('div', { class: 'px-region', style: 'display:none' });
    panel.appendChild(regionEl);

    // list selector row
    selectEl = el('select', { class: 'px-select', title: 'Pool / watchlist / sector (← → to cycle)', onchange: onSelectList });
    panel.appendChild(el('div', { class: 'px-row' }, [
      selectEl,
      el('button', { class: 'px-small-btn', title: 'New watchlist', text: '＋', onclick: () => newListDialog() }),
    ]));

    // cap slicer
    slicerEl = el('div', { class: 'px-slicer' });
    panel.appendChild(slicerEl);

    // filter + sector (F2)
    filterInput = el('input', { class: 'px-input', type: 'text', placeholder: 'Filter…  ( / )', oninput: () => { st.filter = filterInput.value; renderList(); } });
    filterInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { filterInput.value = ''; st.filter = ''; renderList(); filterInput.blur(); } if (e.key === 'Enter') { const first = listEl.querySelector('.px-item'); if (first) first.click(); } e.stopPropagation(); });
    sectorSelect = el('select', { class: 'px-select px-sector-select', title: 'Sector / industry group', onchange: () => { st.sectorFilter = sectorSelect.value; renderSlicer(); renderList(); } });
    panel.appendChild(el('div', { class: 'px-row' }, [filterInput, sectorSelect]));

    // sortable column header (F3)
    headerEl = el('div', { class: 'px-cols' });
    panel.appendChild(headerEl);

    // list
    listEl = el('div', { class: 'px-list' });
    panel.appendChild(listEl);

    // footer
    addInput = el('input', { class: 'px-input', type: 'text', placeholder: 'Add symbols: TCS, INFY, M&M…' });
    addInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') addSymbolsToActive(); if (e.key === 'Escape') addInput.blur(); });
    addRow = el('div', { style: 'display:flex;gap:6px' }, [addInput, el('button', { class: 'px-small-btn px-primary', text: 'Add', onclick: addSymbolsToActive })]);
    hintEl = el('div', { class: 'px-hint' });
    heldEl = el('div', { class: 'px-held', style: 'display:none' });
    panel.appendChild(el('div', { class: 'px-footer' }, [heldEl, addRow, hintEl]));

    document.body.appendChild(panel);
    buildDrawer();
    hoverEl = el('div', { id: 'px-hover', class: 'px-collapsed' });
    document.body.appendChild(hoverEl);
    listEl.addEventListener('mouseleave', hideHover);
    restoreLayout();
    panel.addEventListener('mouseup', () => { saveLayout(); positionDrawer(); });
    window.addEventListener('resize', positionDrawer);
    if (window.ResizeObserver) new ResizeObserver(positionDrawer).observe(panel);
    window.addEventListener('keydown', onKeyDown, true);
  }

  function renderAll() { renderBanner(); renderRegion(); renderSelect(); renderSlicer(); renderSectors(); renderCols(); renderList(); renderHint(); renderAsOf(); renderHeld(); renderDrawer(); }

  function renderBanner() {
    if (!bannerEl) return;
    if (st.loading && !st.boot) { bannerEl.style.display = ''; bannerEl.className = 'px-banner px-info'; bannerEl.textContent = 'Loading Plutus universe…'; return; }
    if (st.error) { bannerEl.style.display = ''; bannerEl.className = 'px-banner'; bannerEl.textContent = st.error; return; }
    if (st.boot && st.settings && st.settings.token && st.tokenRejected) {
      bannerEl.style.display = ''; bannerEl.className = 'px-banner';
      bannerEl.innerHTML = '';
      bannerEl.appendChild(el('span', { text: 'Plutus rejected the saved token (expired, or from another Plutus API) — notes, positions and trades are off. ' }));
      bannerEl.appendChild(el('a', { text: 'Sign in on the web app', onclick: () => window.open(st.settings.webAppUrl, '_blank') }));
      bannerEl.appendChild(el('span', { text: ' and the bridge replaces it, or paste a fresh token in the popup.' }));
      return;
    }
    if (st.boot && !(st.settings && st.settings.token)) {
      bannerEl.style.display = ''; bannerEl.className = 'px-banner px-info';
      bannerEl.innerHTML = 'No Plutus token — watchlists are stored in this browser only; notes / PlayArea / held badges need a token (extension popup).';
      return;
    }
    bannerEl.style.display = 'none';
  }

  function renderAsOf() {
    if (!st.boot) { asofEl.textContent = ''; return; }
    const d = st.boot.snapshot_date;
    if (!d) { asofEl.textContent = 'no snapshots'; return; }
    const age = Math.round((Date.now() - new Date(d + 'T18:00:00+05:30').getTime()) / 86400000);
    asofEl.textContent = 'as of ' + d.slice(5).replace('-', '/');
    asofEl.title = 'Plutus snapshot date ' + d + (st.boot._cached ? ' (cached)' : '');
    asofEl.classList.toggle('px-stale', age > 4);
    renderLiveBadge();
  }
  function renderLiveBadge() {
    if (!liveEl) return;
    const on = !!(st.settings && st.settings.tvLivePrices);
    liveEl.style.display = st.boot ? '' : 'none';
    liveEl.className = 'px-live ' + (!on ? 'px-live-off' : st.liveState === 'paused' ? 'px-live-paused' : st.liveState === 'live' ? 'px-live-on' : '');
    liveEl.textContent = !on ? 'live off' : st.liveState === 'paused' ? 'live ⏸' : st.liveState === 'live' ? '● live' : '○ live';
    liveEl.title = !on ? 'Live prices are off (click to turn on)'
      : st.liveState === 'paused' ? 'TradingView quotes paused after an error — rows show the nightly close until they come back (click to turn off)'
      : 'Live Last / Chg% from TradingView, every ' + (st.settings.tvLiveIntervalSec || 15) + ' s while this tab is visible. Display only (click to turn off)';
  }

  // ---- live prices (F7): poll the visible rows only ---------------------------
  function scheduleLive(now) {
    clearTimeout(st.liveTimer);
    const on = st.settings && st.settings.tvLivePrices && !panel.classList.contains('px-collapsed') && document.visibilityState === 'visible';
    if (!on) { if (st.liveState !== 'off') { st.liveState = 'off'; renderLiveBadge(); } return; }
    const ms = Math.max(10, Number(st.settings.tvLiveIntervalSec) || 15) * 1000;
    st.liveTimer = setTimeout(pollLive, now ? 50 : ms);
  }
  async function pollLive() {
    if (!st.boot || !listEl) { scheduleLive(); return; }
    const symbols = Array.from(listEl.querySelectorAll('.px-item')).map((n) => n.getAttribute('data-symbol')).filter(Boolean);
    if (st.activeSymbol && !symbols.includes(st.activeSymbol)) symbols.push(st.activeSymbol);
    if (!symbols.length) { scheduleLive(); return; }
    try {
      const r = await U.send({ type: 'live.quotes', symbols }, 20000);
      if (r.off) { st.liveState = 'off'; renderLiveBadge(); return; }
      const changed = [];
      Object.keys(r.quotes || {}).forEach((sym) => {
        const q = r.quotes[sym], prev = st.live.get(sym);
        st.live.set(sym, q);
        if (!prev || prev.close !== q.close) changed.push([sym, prev ? Math.sign(q.close - prev.close) : 0]);
      });
      st.liveState = r.degraded ? 'paused' : 'live';
      renderLiveBadge();
      if (changed.length) applyLive(changed);
    } catch (e) {
      st.liveState = 'paused'; renderLiveBadge();
    }
    scheduleLive();
  }
  /** Patch the cells in place; a live-dependent sort re-renders the whole list instead. */
  function applyLive(changed) {
    const liveSort = st.sort.key === 'chg' || st.sort.key === 'dma' || st.sort.key === 'high52' || st.sort.key === 'ath';
    if (liveSort) { renderList(); renderHeld(); return; }
    changed.forEach(([sym, dir]) => {
      const item = listEl.querySelector('.px-item[data-symbol="' + CSS.escape(sym) + '"]');
      if (!item) return;
      fillCells(item, rowFor(sym));
      if (dir) { item.classList.remove('px-flash-up', 'px-flash-down'); void item.offsetWidth; item.classList.add(dir > 0 ? 'px-flash-up' : 'px-flash-down'); }
    });
    renderHeld();
  }

  // ---- region (F1) ------------------------------------------------------------
  function renderRegion() {
    if (!regionEl) return;
    if (!st.boot || !hasUs()) { regionEl.style.display = 'none'; return; }
    regionEl.style.display = '';
    regionEl.innerHTML = '';
    [['IN', '🇮🇳 India'], ['US', '🇺🇸 US']].forEach(([code, label]) => {
      regionEl.appendChild(el('button', { class: code === st.region ? 'px-active' : '', text: label, onclick: () => setRegion(code) }));
    });
  }
  /** Switch region: reset the slicers, keep the active list if it belongs here, else the first list of the region. */
  function setRegion(region, opts) {
    if (region !== 'IN' && region !== 'US') return;
    st.region = region;
    st.capFilter = 'All'; st.sectorFilter = 'All'; st.filter = ''; if (filterInput) filterInput.value = '';
    if (!listInRegion(st.active)) { st.active = defaultList(); saveActiveList(); }
    if (!(opts && opts.silent)) SET.save({ tvRegion: region });
    renderRegion(); renderSelect(); renderSlicer(); renderSectors(); renderList();
  }

  function renderSelect() {
    selectEl.innerHTML = '';
    const og1 = el('optgroup', { label: 'Plutus pools' + (st.region === 'US' ? ' · US' : '') });
    poolsInRegion().forEach((p) => og1.appendChild(el('option', { value: 'pool:' + p.code, text: p.name + ' (' + p.count + ')' })));
    const og2 = el('optgroup', { label: 'Watchlists' + (st.wlSource === 'local' ? ' (this browser)' : '') });
    watchlistsInRegion().forEach((w) => og2.appendChild(el('option', { value: 'wl:' + w.id, text: w.name + ' (' + (w.symbols || []).length + ')' })));
    const og3 = el('optgroup', { label: 'Sectors' });
    sectorsInRegion().forEach(([name, n]) => og3.appendChild(el('option', { value: 'sector:' + name, text: name + ' (' + n + ')' })));
    selectEl.appendChild(og1); selectEl.appendChild(og2);
    if (og3.children.length) selectEl.appendChild(og3);
    if (st.active) {
      const v = st.active.kind + ':' + st.active.id;
      if (!Array.from(selectEl.options).some((o) => o.value === v)) {
        // Active list from the other region: show it anyway so nothing is hidden by surprise.
        const og = el('optgroup', { label: 'Other region' });
        og.appendChild(el('option', { value: v, text: st.active.name || String(st.active.id) }));
        selectEl.appendChild(og);
      }
      selectEl.value = v;
    }
    addRow.style.display = activeWatchlist() ? '' : 'none';
  }

  function renderSlicer() {
    slicerEl.innerHTML = '';
    let rows = activeSymbols().map(rowFor);
    if (st.sectorFilter !== 'All') rows = rows.filter((r) => st.sectorFilter === '__none__' ? !r.sector : r.sector === st.sectorFilter);
    const buckets = L.capBuckets(st.region);
    const counts = { All: rows.length };
    buckets.forEach((b) => { counts[b] = 0; });
    rows.forEach((r) => { buckets.forEach((b) => { if (L.capMatches(b, r.cap) ) counts[b]++; }); });
    if (!buckets.includes(st.capFilter) && st.capFilter !== 'All') st.capFilter = 'All';
    ['All'].concat(buckets).forEach((c) => {
      slicerEl.appendChild(el('button', { class: c === st.capFilter ? 'px-active' : '', onclick: () => { st.capFilter = c; renderSlicer(); renderList(); } }, [
        c, el('span', { class: 'px-count', text: String(counts[c]) }),
      ]));
    });
  }

  // ---- sector slicer (F2) ----------------------------------------------------
  function renderSectors() {
    if (!sectorSelect) return;
    const entries = activeSymbols().map((s) => st.stocks.get(s)).filter(Boolean);
    const { sectors, none } = L.sectorCounts(entries);
    sectorSelect.innerHTML = '';
    sectorSelect.appendChild(el('option', { value: 'All', text: 'All sectors (' + entries.length + ')' }));
    sectors.forEach(([name, n]) => sectorSelect.appendChild(el('option', { value: name, text: name + ' (' + n + ')' })));
    if (none) sectorSelect.appendChild(el('option', { value: '__none__', text: 'No sector (' + none + ')' }));
    if (!Array.from(sectorSelect.options).some((o) => o.value === st.sectorFilter)) st.sectorFilter = 'All';
    sectorSelect.value = st.sectorFilter;
    sectorSelect.disabled = st.active && st.active.kind === 'sector';
  }

  // ---- sortable column header (F3) -------------------------------------------
  const COLS = [
    ['default', 'Symbol', 'A → Z', 'px-col-sym'],
    ['mcap', 'Last', 'market cap (the Last column shows the price)', 'px-col-num px-col-last'],
    ['chg', 'Chg%', "today's change %", 'px-col-num'],
    ['dma', '200D', '% from the 200 DMA (− = below)', 'px-col-num'],
    ['high52', '52wH', '% off the 52-week high', 'px-col-num'],
    ['ath', 'ATH', '% off the all-time high', 'px-col-num'],
    ['score', 'n/11', 'Fundamental score', 'px-col-score'],
  ];
  function renderCols() {
    if (!headerEl) return;
    headerEl.innerHTML = '';
    COLS.forEach(([key, label, title, cls]) => {
      const on = st.sort.key === key || (key === 'default' && st.sort.key === 'name');
      headerEl.appendChild(el('button', { class: 'px-col ' + cls + (on ? ' px-on' : ''), title: 'Sort by ' + title, onclick: () => setSort(key) }, [
        label, on ? el('span', { class: 'px-col-dir', text: st.sort.dir === 'asc' ? '▲' : '▼' }) : null,
      ]));
    });
  }
  function setSort(key, dir) {
    st.sort = dir ? { key, dir } : L.nextSort(st.sort, key);
    SET.save({ tvSort: st.sort.key, tvSortDir: st.sort.dir });
    renderCols(); renderList(); renderDrawer();
  }

  const pct = (v, nd) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(nd == null ? 1 : nd));
  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = '';
    const rows = visibleRows();
    publishNav(rows);
    if (!rows.length) {
      listEl.appendChild(el('div', { class: 'px-empty', text: st.boot ? (activeWatchlist() ? 'Empty list — add symbols below or bookmark from any row.' : 'No stocks match.') : (st.error ? 'Plutus data unavailable.' : 'Loading…') }));
      return;
    }
    const isWl = !!activeWatchlist();
    const showChips = st.settings.tvShowChips;
    rows.forEach((r) => {
      const chips = [];
      if (showChips) {
        const conv = conviction(r);
        if (conv === 'PRIME') chips.push(el('span', { class: 'px-chip px-chip-prime', text: 'PRIME', title: 'Strong signal + fundamentals ≥ 8/11' }));
        if (r.status && SIGNAL_CHIP[r.status]) chips.push(el('span', { class: 'px-chip ' + SIGNAL_CHIP[r.status][1], text: SIGNAL_CHIP[r.status][0], title: r.status }));
        if (r.held) chips.push(el('span', { class: 'px-chip px-chip-held', text: 'HELD ' + r.held.qty, title: 'Open position: ' + r.held.qty + ' × ' + (r.market === 'US' ? '$' : '₹') + U.fmt(r.held.invested / Math.max(1, r.held.qty), 0) }));
      }
      const capL = r.cap ? (CAP_LETTER[r.cap] || 'U') : 'U';
      const item = el('div', { class: 'px-item' + (r.symbol === st.activeSymbol ? ' px-active' : '') + (r.entry ? '' : ' px-missing'), 'data-symbol': r.symbol, title: r.entry ? '' : 'Not in the Plutus universe' }, [
        el('span', { class: 'px-chip px-chip-cap-' + capL, text: capL, title: r.cap || 'Cap unknown' }),
        el('div', { class: 'px-item-main' }, [
          el('div', { class: 'px-sym', text: r.plain }),
          showChips && chips.length ? el('div', { class: 'px-chips' }, chips) : (r.name ? el('div', { class: 'px-name', text: r.name }) : null),
        ]),
        el('span', { class: 'px-cell px-col-num px-col-last', 'data-cell': 'last' }),
        el('span', { class: 'px-cell px-col-num', 'data-cell': 'chg' }),
        el('span', { class: 'px-cell px-col-num', 'data-cell': 'dma' }),
        el('span', { class: 'px-cell px-col-num', 'data-cell': 'h52' }),
        el('span', { class: 'px-cell px-col-num', 'data-cell': 'ath' }),
        el('span', { class: 'px-cell px-col-score ' + (r.points == null ? 'px-muted' : r.points >= 8 ? 'px-strong' : r.points <= 5 ? 'px-weak' : ''), text: r.points == null ? '—' : r.points + '/11', title: 'Fundamental score' }),
        el('div', { class: 'px-actions' }, [
          el('button', { class: 'px-act', title: 'Size a position (Z)', text: '⚖', onclick: (e) => { e.stopPropagation(); sizerDialog(r.symbol); } }),
          el('button', { class: 'px-act', title: 'Note (N)', text: '✎', onclick: (e) => { e.stopPropagation(); noteDialog(r.symbol); } }),
          el('button', { class: 'px-act', title: 'Bookmark to a watchlist (B)', text: '🔖', onclick: (e) => { e.stopPropagation(); bookmarkDialog(r.symbol); } }),
          r.market === 'US' ? null : el('button', { class: 'px-act', title: 'Screener.in (S)', text: '⧉', onclick: (e) => { e.stopPropagation(); openScreener(r.symbol); } }),
          el('button', { class: 'px-act', title: 'Open in Plutus (P)', text: '⌂', onclick: (e) => { e.stopPropagation(); openPlutus(r.symbol); } }),
          isWl ? el('button', { class: 'px-act px-act-del', title: 'Remove from this watchlist', text: '✕', onclick: (e) => { e.stopPropagation(); removeFromActive(r.symbol); } }) : null,
        ]),
      ]);
      fillCells(item, r);
      item.addEventListener('click', () => switchTo(r.symbol));
      item.addEventListener('mouseenter', () => showHover(item, r.symbol));
      item.addEventListener('mouseleave', hideHover);
      listEl.appendChild(item);
    });
    scrollActiveIntoView();
  }
  /** Numeric cells of one row (also used by the live patcher). */
  function fillCells(item, r) {
    const set = (key, text, v, title, extra) => {
      const c = item.querySelector('[data-cell="' + key + '"]');
      if (!c) return;
      c.textContent = text;
      c.title = title || '';
      c.classList.remove('px-up', 'px-down', 'px-muted', 'px-live-cell');
      if (v == null) c.classList.add('px-muted'); else if (v < 0) c.classList.add('px-down'); else if (v > 0) c.classList.add('px-up');
      if (extra) c.classList.add(extra);
    };
    const priceTxt = r.last == null ? '—' : (r.last >= 1000 ? Math.round(r.last).toLocaleString('en-US') : r.last.toFixed(r.last >= 100 ? 1 : 2));
    set('last', priceTxt, 0, r.live ? 'Live price (TradingView)' : 'Nightly close', r.live ? 'px-live-cell' : '');
    set('chg', r.chgPct == null ? '—' : pct(r.chgPct), r.chgPct, r.live ? "Today's change (live)" : 'Last session change');
    // 200D is stored as "% below" (positive = below the DMA); show it signed like the chart reads it.
    set('dma', pct(r.below == null ? null : -r.below), r.below == null ? null : -r.below, 'Distance from the 200 DMA');
    set('h52', pct(r.off52 == null ? null : -Math.abs(r.off52)), r.off52 == null ? null : -Math.abs(r.off52), '% off the 52-week high');
    set('ath', pct(r.athFall == null ? null : -Math.abs(r.athFall)), r.athFall == null ? null : -Math.abs(r.athFall), '% off the all-time high');
  }

  // ---- row hover card (F17): Plutus checks without leaving the list ------------
  let hoverTimer = null, hoverSym = null;
  function showHover(item, symbol) {
    if (!st.settings.tvHoverCard) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hoverSym = symbol;
      renderHover(item, symbol);
      // Detail strings (the actual values) need the per-stock payload; fill them in when it arrives.
      stockFor(symbol).then(() => { if (hoverSym === symbol && !hoverEl.classList.contains('px-collapsed')) renderHover(item, symbol); }).catch(() => {});
    }, 400);
  }
  function hideHover() { clearTimeout(hoverTimer); hoverSym = null; if (hoverEl) hoverEl.classList.add('px-collapsed'); }
  function renderHover(item, symbol) {
    const r = rowFor(symbol);
    if (!r.entry) { hoverEl.classList.add('px-collapsed'); return; }
    const cur = r.market === 'US' ? '$' : '₹';
    const labels = (st.boot && st.boot.check_labels) || {};
    const cached = st.stockCache.get(symbol);
    const detail = {};
    if (cached && cached.data) {
      const fr = (cached.data.scan_results || []).find((x) => x.strategy_id === 'fundamental_screener');
      ((fr && fr.metrics_snapshot && fr.metrics_snapshot.checks) || []).forEach((c) => { detail[c.id] = c.detail; });
    }
    hoverEl.innerHTML = '';
    hoverEl.appendChild(el('div', { class: 'px-hover-head' }, [
      el('b', { text: r.plain }), el('span', { class: 'px-muted', text: r.name || '' }), el('span', { class: 'px-header-spacer' }),
      el('span', { class: 'px-chip px-chip-score ' + (r.points == null ? '' : r.points >= 8 ? 'px-strong' : r.points <= 5 ? 'px-weak' : ''), text: r.points == null ? '— /11' : r.points + '/11' }),
    ]));
    const chips = [];
    if (r.status && SIGNAL_CHIP[r.status]) chips.push(el('span', { class: 'px-chip ' + SIGNAL_CHIP[r.status][1], text: SIGNAL_CHIP[r.status][0] }));
    if (conviction(r) === 'PRIME') chips.push(el('span', { class: 'px-chip px-chip-prime', text: 'PRIME' }));
    if (r.held) chips.push(el('span', { class: 'px-chip px-chip-held', text: 'HELD ' + r.held.qty }));
    chips.push(el('span', { class: 'px-chip px-chip-cap-' + (CAP_LETTER[r.cap] || 'U'), text: (r.cap || 'cap ?') + (r.sector ? ' · ' + r.sector : '') }));
    hoverEl.appendChild(el('div', { class: 'px-chips' }, chips));
    hoverEl.appendChild(el('div', { class: 'px-hover-tech' }, [
      el('span', { text: (r.live ? 'Live ' : 'Close ') + cur + (r.last == null ? '—' : U.fmt(r.last, 2)) }),
      el('span', { text: 'Chg ' + pct(r.chgPct) + '%' }),
      el('span', { text: '200D ' + pct(r.below == null ? null : -r.below) + '%' }),
      el('span', { text: '52wH ' + pct(r.off52 == null ? null : -Math.abs(r.off52)) + '%' }),
      el('span', { text: 'ATH ' + pct(r.athFall == null ? null : -Math.abs(r.athFall)) + '%' }),
    ]));
    const ids = Object.keys(r.checks || {});
    if (ids.length) {
      const grid = el('div', { class: 'px-hover-checks' });
      ids.forEach((id) => {
        const v = r.checks[id];
        grid.appendChild(el('div', { class: 'px-check ' + (v === true ? 'px-pass' : v === false ? 'px-fail' : 'px-na') }, [
          el('b', { text: v === true ? '✓' : v === false ? '✗' : '·' }),
          el('span', { text: labels[id] || id }),
          detail[id] ? el('span', { class: 'px-hover-detail', text: detail[id] }) : null,
        ]));
      });
      hoverEl.appendChild(grid);
    } else hoverEl.appendChild(el('div', { class: 'px-muted', text: r.market === 'US' ? 'No fundamental score for US stocks yet.' : 'No fundamental scan yet.' }));
    hoverEl.classList.remove('px-collapsed');
    // position: left of the panel, aligned with the row; fall back to the right
    const pr = panel.getBoundingClientRect(), ir = item.getBoundingClientRect();
    const w = 300, h = hoverEl.offsetHeight || 200;
    const drawerOpen = st.settings.tvDrawerOpen && drawer && !drawer.classList.contains('px-collapsed');
    const leftEdge = drawerOpen ? drawer.getBoundingClientRect().left : pr.left;
    let left = leftEdge - w - 8;
    if (left < 4) left = Math.min(window.innerWidth - w - 4, pr.right + 8);
    hoverEl.style.left = Math.max(4, left) + 'px';
    hoverEl.style.top = Math.max(4, Math.min(window.innerHeight - h - 8, ir.top)) + 'px';
    hoverEl.style.width = w + 'px';
  }

  /** Per-stock payload via the worker (10-min cache there, 2-min memo here); never throws. */
  async function stockFor(symbol, force) {
    const hit = st.stockCache.get(symbol);
    if (!force && hit && Date.now() - hit.at < 120000) return hit;
    try {
      const data = await U.send({ type: 'stock', symbol, force: !!force });
      const rec = { data, error: null, at: Date.now() };
      st.stockCache.set(symbol, rec);
      return rec;
    } catch (e) {
      const rec = { data: null, error: { status: e.status || 0, message: e.message }, at: Date.now() };
      st.stockCache.set(symbol, rec);
      return rec;
    }
  }

  function renderHint() {
    const space = st.settings.tvSpaceKeyNavigates;
    hintEl.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd>' + (space ? '<kbd>Space</kbd>' : '') + ' stock</span><span><kbd>←</kbd><kbd>→</kbd> list</span>' +
      '<span><kbd>Z</kbd> size</span><span><kbd>N</kbd> note</span><span><kbd>B</kbd> bookmark</span><span><kbd>O</kbd> opportunity</span><span><kbd>S</kbd> screener</span><span><kbd>P</kbd> plutus</span><span><kbd>A</kbd> play area</span><span><kbd>Alt</kbd>+<kbd>D</kbd> drawer</span><span><kbd>Alt</kbd>+<kbd>W</kbd> panel</span><span><kbd>Alt</kbd>+<kbd>E</kbd> expand</span>';
    focusBtn.classList.toggle('px-on', !!st.settings.tvFocusMode);
    linkBtn.classList.toggle('px-on', !!st.settings.linkTabs);
    linkBtn.title = st.settings.linkTabs ? 'Tabs linked: Screener follows this chart and the chart follows Screener (click to unlink)' : 'Tabs not linked (click to link TradingView and Screener)';
    drawerBtn.classList.toggle('px-on', !!st.settings.tvDrawerOpen);
  }

  function togglePanel() {
    const collapsed = panel.classList.toggle('px-collapsed');
    SET.save({ tvPanelOpen: !collapsed });
    positionDrawer();
    scheduleLive(true);
  }

  function onSelectList() {
    const [kind, ...rest] = selectEl.value.split(':');
    const id = rest.join(':');
    let name;
    if (kind === 'pool') name = (pools().find((p) => p.code === id) || {}).name;
    else if (kind === 'sector') name = id;
    else name = (st.watchlists.find((w) => String(w.id) === id) || {}).name;
    st.active = { kind, id: kind === 'wl' ? (isNaN(Number(id)) ? id : Number(id)) : id, name };
    if (kind === 'sector') st.sectorFilter = 'All';
    saveActiveList();
    renderSelect(); renderSlicer(); renderSectors(); renderList(); renderDrawer();
  }

  async function refresh(force) {
    U.toast('Refreshing Plutus data…');
    try { await U.send({ type: 'cache.clear' }); } catch (e) { /* ignore */ }
    await loadAll();
    if (!st.error) U.toast('Plutus data refreshed', 'success');
  }

  // ---- layout persistence (drag + resize) ----------------------------------
  function makeDraggable(handle) {
    let sx, sy, sl, stp, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); sl = r.left; stp = r.top;
      panel.style.right = 'auto'; panel.style.left = sl + 'px'; panel.style.top = stp + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const l = Math.max(0, Math.min(window.innerWidth - 80, sl + e.clientX - sx));
      const t = Math.max(0, Math.min(window.innerHeight - 60, stp + e.clientY - sy));
      panel.style.left = l + 'px'; panel.style.top = t + 'px';
      positionDrawer();
    });
    window.addEventListener('mouseup', () => { if (dragging) { dragging = false; saveLayout(); positionDrawer(); } });
    handle.addEventListener('dblclick', () => { panel.style.cssText = ''; panel.classList.remove('px-wide'); syncWideBtn(); try { localStorage.removeItem(LS_LAYOUT); } catch (e) { /* ignore */ } renderHeld(); positionDrawer(); });
  }
  function saveLayout() {
    try {
      const r = panel.getBoundingClientRect();
      const prev = JSON.parse(localStorage.getItem(LS_LAYOUT) || 'null') || {};
      const wide = panel.classList.contains('px-wide');
      // In wide mode keep the remembered normal size so collapsing restores it.
      const normal = wide ? prev.normal : { width: r.width, height: r.height };
      localStorage.setItem(LS_LAYOUT, JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height, wide, normal }));
    } catch (e) { /* ignore */ }
  }
  function restoreLayout() {
    try {
      const l = JSON.parse(localStorage.getItem(LS_LAYOUT) || 'null');
      if (!l) return;
      panel.style.right = 'auto';
      // v0.4 added two columns: a layout saved by an older build may be too narrow for them.
      const w = Math.max(390, Number(l.width) || 0);
      panel.style.width = w + 'px'; panel.style.height = l.height + 'px';
      panel.style.left = Math.max(0, Math.min(window.innerWidth - w - 8, l.left - (w - l.width))) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 100, l.top)) + 'px';
      if (l.wide) panel.classList.add('px-wide');
      syncWideBtn();
    } catch (e) { /* ignore */ }
    positionDrawer();
  }
  /**
   * Expand: a tall, wide panel (room for every chip, the held strip in four
   * columns and the lot list). The panel grows toward the chart from its right
   * edge, and the previous size comes back on collapse.
   */
  function toggleWide() {
    const r = panel.getBoundingClientRect();
    const wide = !panel.classList.contains('px-wide');
    let w, h;
    if (wide) {
      saveLayout();                                   // remember the normal size first
      w = Math.min(520, window.innerWidth - 60);
      h = Math.max(320, window.innerHeight - 70);
    } else {
      let normal = null;
      try { normal = (JSON.parse(localStorage.getItem(LS_LAYOUT) || 'null') || {}).normal; } catch (e) { /* ignore */ }
      w = Math.max(390, (normal && normal.width) || 400);
      h = (normal && normal.height) || Math.min(window.innerHeight * 0.78, 760);
    }
    const right = r.right;                            // keep the right edge where it is
    panel.classList.toggle('px-wide', wide);
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
    panel.style.right = 'auto';
    panel.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, right - w)) + 'px';
    panel.style.top = (wide ? Math.max(8, Math.min(r.top, window.innerHeight - h - 8)) : r.top) + 'px';
    saveLayout();
    syncWideBtn();
    renderHeld();
    positionDrawer();
  }
  function syncWideBtn() {
    if (!wideBtn) return;
    const wide = panel.classList.contains('px-wide');
    wideBtn.textContent = wide ? '⤡' : '⤢';
    wideBtn.title = wide ? 'Restore the panel size (Alt+E)' : 'Expand the panel (Alt+E)';
    wideBtn.classList.toggle('px-on', wide);
  }

  // =============================================================================
  // Drawer (F18): Filters · Stock · Trades · Notes — follows the selected stock
  // =============================================================================
  function buildDrawer() {
    drawerTitleEl = el('span', { class: 'px-drawer-sym', text: '' });
    drawerTabsEl = el('div', { class: 'px-drawer-tabs' });
    drawerBody = el('div', { class: 'px-drawer-body' });
    drawer = el('div', { id: 'px-tv-drawer', class: 'px-collapsed' }, [
      el('div', { class: 'px-drawer-head' }, [
        drawerTabsEl,
        el('span', { class: 'px-header-spacer' }),
        drawerTitleEl,
        el('button', { class: 'px-icon-btn', title: 'Close the drawer (Alt+D)', text: '✕', onclick: () => toggleDrawer(false) }),
      ]),
      drawerBody,
    ]);
    document.body.appendChild(drawer);
  }
  function drawerTab() { return (st.settings && st.settings.tvDrawerTab) || 'notes'; }
  function toggleDrawer(open) {
    const next = open == null ? !st.settings.tvDrawerOpen : !!open;
    st.settings.tvDrawerOpen = next;
    SET.save({ tvDrawerOpen: next });
    renderDrawer();
  }
  function setDrawerTab(tab) {
    st.settings.tvDrawerTab = tab;
    SET.save({ tvDrawerTab: tab, tvDrawerOpen: true });
    st.settings.tvDrawerOpen = true;
    renderDrawer();
  }
  /** The drawer is a sibling of the panel (the panel clips its children): keep it glued to the panel's left edge. */
  function positionDrawer() {
    if (!drawer || !panel) return;
    const open = !!(st.settings && st.settings.tvDrawerOpen) && !panel.classList.contains('px-collapsed');
    drawer.classList.toggle('px-collapsed', !open);
    if (!open) return;
    const r = panel.getBoundingClientRect();
    const w = Math.min(DRAWER_W, Math.max(240, window.innerWidth - 40));
    let left = r.left - w - 8;
    if (left < 4) left = Math.min(window.innerWidth - w - 4, r.right + 8);   // no room on the left: sit on the right
    drawer.style.left = Math.max(4, left) + 'px';
    drawer.style.top = r.top + 'px';
    drawer.style.width = w + 'px';
    drawer.style.height = r.height + 'px';
  }
  function renderDrawer() {
    if (!drawer) return;
    positionDrawer();
    drawerBtn.classList.toggle('px-on', !!st.settings.tvDrawerOpen);
    drawerBtn.classList.toggle('px-dot', chipsActive());
    if (!st.settings.tvDrawerOpen) return;
    const tab = drawerTab();
    drawerTabsEl.innerHTML = '';
    DRAWER_TABS.forEach(([id, label]) => drawerTabsEl.appendChild(el('button', { class: 'px-drawer-tab' + (tab === id ? ' px-on' : ''), text: label, onclick: () => setDrawerTab(id) })));
    const sym = currentSymbol();
    drawerTitleEl.textContent = sym ? S.toPlain(sym) : '';
    drawerBody.innerHTML = '';
    if (tab === 'filters') renderFiltersTab(drawerBody);
    else if (tab === 'stock') renderStockTab(drawerBody, sym);
    else if (tab === 'trades') renderTradesTab(drawerBody, sym);
    else renderNotesTab(drawerBody, sym);
  }

  function section(title, children) {
    return el('div', { class: 'px-dsec' }, [el('div', { class: 'px-dsec-title', text: title })].concat(children || []));
  }

  // ---- Filters tab: sort, region, watchlist admin ------------------------------
  function renderFiltersTab(body) {
    const sortSel = el('select', { class: 'px-select', onchange: () => setSort(sortSel.value, (L.SORT_KEYS[sortSel.value] || L.SORT_KEYS.default).dir) });
    Object.keys(L.SORT_KEYS).filter((k) => k !== 'name').forEach((k) => sortSel.appendChild(el('option', { value: k, text: L.SORT_KEYS[k].label })));
    sortSel.value = L.SORT_KEYS[st.sort.key] ? (st.sort.key === 'name' ? 'default' : st.sort.key) : 'default';
    const quick = el('div', { class: 'px-drow' }, [
      el('button', { class: 'px-small-btn', text: '▲ Top gainers', onclick: () => setSort('chg', 'desc') }),
      el('button', { class: 'px-small-btn', text: '▼ Top losers', onclick: () => setSort('chg', 'asc') }),
      el('button', { class: 'px-small-btn', text: 'Deepest below 200D', onclick: () => setSort('dma', 'desc') }),
    ]);
    const dirBtn = el('button', { class: 'px-small-btn', text: st.sort.dir === 'asc' ? '▲ asc' : '▼ desc', title: 'Flip the sort direction', onclick: () => setSort(st.sort.key, st.sort.dir === 'asc' ? 'desc' : 'asc') });
    body.appendChild(section('Sort', [el('div', { class: 'px-drow' }, [sortSel, dirBtn]), quick]));

    if (hasUs()) {
      const seg = el('div', { class: 'px-region px-region-inline' });
      [['IN', '🇮🇳 India'], ['US', '🇺🇸 US']].forEach(([code, label]) => seg.appendChild(el('button', { class: code === st.region ? 'px-active' : '', text: label, onclick: () => setRegion(code) })));
      body.appendChild(section('Region', [seg]));
    }

    const w = activeWatchlist();
    body.appendChild(section('Watchlists' + (st.wlSource === 'local' ? ' (this browser)' : ''), [
      el('div', { class: 'px-drow' }, [
        el('button', { class: 'px-small-btn px-primary', text: '＋ New', onclick: () => newListDialog() }),
        el('button', { class: 'px-small-btn', text: '✎ Rename', disabled: w ? null : 'disabled', onclick: renameListDialog }),
        el('button', { class: 'px-small-btn px-danger', text: '🗑 Delete', disabled: w ? null : 'disabled', onclick: deleteListDialog }),
      ]),
      el('div', { class: 'px-muted', text: w ? 'Active: ' + w.name + ' (' + (w.symbols || []).length + ')' : 'Pick a watchlist in the panel to rename or delete it.' }),
    ]));

    // F8: per-rule chips. Three states per rule — off → must pass → must not fail (n/a allowed) → off.
    const labels = (st.boot && st.boot.check_labels) || {};
    const present = new Set();
    activeSymbols().forEach((sym) => { const e = st.stocks.get(sym); Object.keys((e && e.checks) || {}).forEach((id) => present.add(id)); });
    const ids = Object.keys(labels).filter((id) => present.has(id));
    const chipRow = el('div', { class: 'px-fchips' });
    chipRow.appendChild(el('button', { class: 'px-fchip px-fchip-star' + (st.allPass ? ' px-on' : ''), title: 'Only stocks that pass every check (n/a counts as not passed)', text: '⭐ All pass',
      onclick: () => { st.allPass = !st.allPass; if (st.allPass) st.chips = {}; renderAll(); } }));
    ids.forEach((id) => {
      const state = st.chips[id];
      chipRow.appendChild(el('button', { class: 'px-fchip' + (state === 'pass' ? ' px-on' : state === 'nofail' ? ' px-soft' : ''), text: labels[id],
        title: state === 'pass' ? 'Must pass (click: allow n/a)' : state === 'nofail' ? 'Must not fail — n/a allowed (click: off)' : 'Click: must pass',
        onclick: () => {
          st.allPass = false;
          if (!state) st.chips[id] = 'pass'; else if (state === 'pass') st.chips[id] = 'nofail'; else delete st.chips[id];
          renderAll();
        } }));
    });
    const shown = visibleRows().length;
    body.appendChild(section('Fundamental filters' + (chipsActive() ? ' · ' + shown + ' shown' : ''), [
      ids.length ? chipRow : el('div', { class: 'px-muted', text: 'No scored stocks in this list yet.' }),
      el('div', { class: 'px-drow' }, [
        chipsActive() ? el('button', { class: 'px-small-btn', text: 'Clear filters', onclick: () => { st.chips = {}; st.allPass = false; renderAll(); } }) : null,
        el('span', { class: 'px-muted', text: 'Solid = must pass · outlined = must not fail (n/a allowed). Stocks without a scan are hidden while a filter is on.' }),
      ]),
    ]));

    const liveSel = el('select', { class: 'px-select', onchange: () => SET.save({ tvLiveIntervalSec: Number(liveSel.value) }) });
    [[15, 'every 15 s'], [30, 'every 30 s'], [60, 'every 60 s']].forEach(([v, t]) => liveSel.appendChild(el('option', { value: String(v), text: t })));
    liveSel.value = String([15, 30, 60].includes(Number(st.settings.tvLiveIntervalSec)) ? st.settings.tvLiveIntervalSec : 15);
    body.appendChild(section('Live prices', [
      el('div', { class: 'px-drow' }, [
        el('label', { class: 'px-check-inline' }, [el('input', { type: 'checkbox', ...(st.settings.tvLivePrices ? { checked: 'checked' } : {}), onchange: (e) => SET.save({ tvLivePrices: !!e.target.checked }) }), ' Live Last / Chg% from TradingView']),
        liveSel,
      ]),
      el('div', { class: 'px-muted', text: 'Display only — nothing is written to Plutus. 200D / 52wH / ATH move with the live price against the Plutus levels.' }),
    ]));

    body.appendChild(section('Data', [
      el('div', { class: 'px-drow' }, [
        el('button', { class: 'px-small-btn', text: '↻ Refresh Plutus data', onclick: () => refresh(true) }),
      ]),
      el('div', { class: 'px-muted', text: st.boot ? 'Snapshot ' + (st.boot.snapshot_date || '—') + ' · ' + st.stocks.size + ' stocks' + (st.boot._cached ? ' · cached' : '') : '' }),
    ]));
  }

  // ---- Stock tab (F9): the same Plutus card Screener shows, via shared/card.js --
  function renderStockTab(body, sym) {
    if (!sym) { body.appendChild(el('div', { class: 'px-empty', text: 'Pick a stock.' })); return; }
    const r = rowFor(sym);
    const cached = st.stockCache.get(sym);
    if (!cached || Date.now() - cached.at > 120000) {
      stockFor(sym).then(() => { if (drawerTab() === 'stock' && currentSymbol() === sym) renderDrawer(); });
    }
    const card = C.build({
      ticker: r.plain, data: cached ? cached.data : null, error: cached ? cached.error : null,
      boot: st.boot, settings: st.settings, held: r.held, compact: true,
      actions: {
        note: () => noteDialog(sym),
        size: () => sizerDialog(sym),
        opportunity: () => opportunityDialog(sym),
        playAreaAdd: () => togglePlayArea(sym, true),
        playAreaRemove: () => togglePlayArea(sym),
        retry: () => stockFor(sym, true).then(() => renderDrawer()),
      },
    });
    body.appendChild(card);
    const links = el('div', { class: 'px-drow' }, [
      r.market === 'US' ? null : el('button', { class: 'px-small-btn', text: '⧉ Screener', onclick: () => openScreener(sym) }),
      el('button', { class: 'px-small-btn', text: '⌂ Plutus', onclick: () => openPlutus(sym) }),
      el('button', { class: 'px-small-btn', text: '↻', title: 'Reload this stock', onclick: () => stockFor(sym, true).then(() => renderDrawer()) }),
    ]);
    body.appendChild(links);
    if (r.live && r.last != null) body.appendChild(el('div', { class: 'px-muted', text: 'Live ' + (r.market === 'US' ? '$' : '₹') + U.fmt(r.last, 2) + ' · ' + pct(r.chgPct) + '% today (TradingView). The card above uses the nightly snapshot.' }));
  }

  // ---- Trades tab (F19): everything the journal knows about this stock -------
  async function loadTrades(sym, force) {
    if (!sym || !st.settings.token) return;
    if (!force && st.trades.symbol === sym && !st.trades.error && !st.trades.loading) return;
    st.trades = { symbol: sym, data: null, loading: true, error: null };
    renderDrawer();
    try {
      const data = await U.send({ type: 'trades.forSymbol', symbol: sym });
      if (st.trades.symbol !== sym) return;
      st.trades.data = data;
    } catch (e) { st.trades.error = e.message; }
    st.trades.loading = false;
    renderDrawer();
  }
  function renderTradesTab(body, sym) {
    if (!sym) { body.appendChild(el('div', { class: 'px-empty', text: 'Pick a stock.' })); return; }
    if (!st.settings.token) { body.appendChild(el('div', { class: 'px-empty', text: 'Trades need a Plutus token (extension popup).' })); return; }
    if (st.trades.symbol !== sym) loadTrades(sym);
    const r = rowFor(sym);
    const cur = r.market === 'US' ? '$' : '₹';
    const lp = livePrice(sym);
    const sign = (v, nd) => (v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(nd == null ? 1 : nd));
    const money = (v) => (v == null ? '—' : (v < 0 ? '−' : '') + cur + Math.round(Math.abs(v)).toLocaleString(cur === '$' ? 'en-US' : 'en-IN'));

    body.appendChild(el('div', { class: 'px-drow' }, [
      el('button', { class: 'px-small-btn px-primary', text: '⚖ Size a position', onclick: () => sizerDialog(sym) }),
      el('button', { class: 'px-small-btn', text: '⚡ Add opportunity', onclick: () => opportunityDialog(sym) }),
      el('button', { class: 'px-small-btn', text: '↻', title: 'Reload', onclick: () => loadTrades(sym, true) }),
    ]));
    if (st.trades.loading || !st.trades.data) { body.appendChild(el('div', { class: 'px-muted', text: st.trades.error || 'Loading journal…' })); return; }
    const d = st.trades.data;

    // open lots with live P&L
    const open = (d.open || []).slice().sort((a, b) => String(b.buy_date).localeCompare(String(a.buy_date)));
    if (open.length) {
      const qty = open.reduce((a, t) => a + (Number(t.qty) || 0), 0);
      const cost = open.reduce((a, t) => a + (num(t.buy_price) || 0) * (Number(t.qty) || 0), 0);
      const pnl = lp && qty ? (lp.price - cost / qty) * qty : null;
      const table = el('div', { class: 'px-held-lots px-dlots' });
      table.appendChild(el('div', { class: 'px-held-lot px-held-lot-head' }, ['Bought', 'Qty @', 'P&L', 'T / SL'].map((h) => el('span', { text: h }))));
      open.forEach((t) => {
        const bp = num(t.buy_price), q = Number(t.qty) || 0;
        const lotPct = lp && bp ? (lp.price / bp - 1) * 100 : null;
        table.appendChild(el('div', { class: 'px-held-lot', title: (t.strategy ? t.strategy + ' · ' : '') + (t.order_type || '') + (t.notes ? '\n' + t.notes : '') }, [
          el('span', { text: shortDate(t.buy_date) }),
          el('span', { text: q + ' @ ' + (bp ? U.fmt(bp, 1) : '—') }),
          el('span', { class: lotPct == null ? '' : lotPct >= 0 ? 'px-up' : 'px-down', text: lotPct == null ? '—' : sign(lotPct) + '%' }),
          el('span', { text: (num(t.target_price) ? U.fmt(t.target_price, 0) : '—') + ' / ' + (num(t.stop_price) ? U.fmt(t.stop_price, 0) : '—') }),
        ]));
      });
      body.appendChild(section('Open · ' + qty.toLocaleString() + ' @ ' + cur + U.fmt(cost / qty, 2) + (pnl == null ? '' : ' · ' + sign(pnl / cost * 100) + '% ' + money(pnl)), [table]));
    } else body.appendChild(section('Open', [el('div', { class: 'px-muted', text: 'No open position.' })]));

    // closed trades
    const closed = (d.closed || []).slice().sort((a, b) => String(b.sell_date || b.buy_date).localeCompare(String(a.sell_date || a.buy_date)));
    if (closed.length) {
      let realised = 0;
      const table = el('div', { class: 'px-held-lots px-dlots' });
      table.appendChild(el('div', { class: 'px-held-lot px-held-lot-head' }, ['Buy → Sell', 'Qty', 'P&L', 'Days'].map((h) => el('span', { text: h }))));
      closed.forEach((t) => {
        const bp = num(t.buy_price), sp = num(t.sell_price), q = Number(t.qty) || 0;
        const p = bp != null && sp != null ? (sp - bp) * q : num(t.realized_pnl);
        if (p != null) realised += p;
        const days = t.buy_date && t.sell_date ? Math.round((new Date(t.sell_date) - new Date(t.buy_date)) / 86400000) : null;
        table.appendChild(el('div', { class: 'px-held-lot', title: (t.strategy || '') + (t.exit_reason ? ' · ' + t.exit_reason : '') }, [
          el('span', { text: shortDate(t.buy_date) + ' → ' + shortDate(t.sell_date) }),
          el('span', { text: q + ' @ ' + (bp ? U.fmt(bp, 0) : '—') + '→' + (sp ? U.fmt(sp, 0) : '—') }),
          el('span', { class: p == null ? '' : p >= 0 ? 'px-up' : 'px-down', text: p == null ? '—' : (bp && sp ? sign((sp / bp - 1) * 100) + '%' : money(p)) }),
          el('span', { text: days == null ? '—' : days + 'd' }),
        ]));
      });
      body.appendChild(section('Closed (' + closed.length + ') · realised ' + money(realised), [table]));
    }

    // opportunities
    const opps = d.opportunities || [];
    if (opps.length) {
      const list = el('div', { class: 'px-notes' });
      opps.forEach((o) => list.appendChild(el('div', { class: 'px-note' }, [
        el('div', { class: 'px-note-head' }, [
          el('span', { class: 'px-note-date', text: shortDate(o.opp_date) }),
          el('span', { class: 'px-chip px-chip-none', text: o.status || '' }),
          o.strategy ? el('span', { class: 'px-muted', text: o.strategy }) : null,
          el('span', { class: 'px-header-spacer' }),
          el('span', { class: 'px-muted', text: (num(o.buy_price) ? cur + U.fmt(o.buy_price, 0) : '') + (num(o.target_price) ? ' → ' + cur + U.fmt(o.target_price, 0) : '') }),
        ]),
        o.notes ? el('div', { class: 'px-note-body', text: o.notes }) : null,
      ])));
      body.appendChild(section('Opportunities (' + opps.length + ')', [list]));
    }

    // sizing plans
    const plans = d.plans || [];
    if (plans.length) {
      const list = el('div', { class: 'px-notes' });
      plans.slice(0, 5).forEach((p) => list.appendChild(el('div', { class: 'px-note' }, [
        el('div', { class: 'px-note-head' }, [
          el('span', { class: 'px-note-date', text: shortDate(p.created_at || p.plan_date) }),
          el('span', { class: 'px-muted', text: (p.qty != null ? p.qty + ' × ' : '') + (num(p.entry_price) ? cur + U.fmt(p.entry_price, 0) : '') + (num(p.stop_price) ? ' · SL ' + cur + U.fmt(p.stop_price, 0) : '') + (num(p.target_price) ? ' · T ' + cur + U.fmt(p.target_price, 0) : '') }),
        ]),
        p.notes || p.risk_note ? el('div', { class: 'px-note-body', text: p.notes || p.risk_note }) : null,
      ])));
      body.appendChild(section('Sizing plans (' + plans.length + ')', [list]));
    }
    if (!open.length && !closed.length && !opps.length && !plans.length) body.appendChild(el('div', { class: 'px-muted', text: 'Nothing in the journal for ' + r.plain + ' yet.' }));
  }

  // ---- Notes tab (F4): full timeline with add / edit / delete ----------------
  async function loadNotes(sym, force) {
    if (!sym || !st.settings.token) return;
    if (!force && st.notes.symbol === sym && !st.notes.error && !st.notes.loading) return;
    st.notes = { symbol: sym, items: [], loading: true, error: null, editing: null };
    renderDrawer();
    try {
      const r = await U.send({ type: 'notes.list', symbol: sym, limit: 200 });
      if (st.notes.symbol !== sym) return;                 // the chart moved on meanwhile
      st.notes.items = r.notes || [];
    } catch (e) { st.notes.error = e.message; }
    st.notes.loading = false;
    renderDrawer();
  }
  function renderNotesTab(body, sym) {
    if (!sym) { body.appendChild(el('div', { class: 'px-empty', text: 'Pick a stock.' })); return; }
    if (!st.settings.token) { body.appendChild(el('div', { class: 'px-empty', text: 'Notes need a Plutus token (extension popup).' })); return; }
    const plain = S.toPlain(sym);
    if (st.notes.symbol !== sym) { loadNotes(sym); }

    // add form
    const date = el('input', { type: 'date', class: 'px-input', value: new Date().toISOString().slice(0, 10) });
    const text = el('textarea', { class: 'px-input px-note-text', placeholder: 'Your view on ' + plain + ' today… (Ctrl+Enter saves)' });
    const save = el('button', { class: 'px-small-btn px-primary', text: 'Save note' });
    const submit = async () => {
      if (!text.value.trim()) { U.toast('Write something first', 'error'); return; }
      save.disabled = true;
      try {
        await U.send({ type: 'notes.create', symbol: sym, content: text.value.trim(), note_date: date.value });
        U.toast('Note saved to Plutus', 'success');
        text.value = '';
        await loadNotes(sym, true);
      } catch (e) { U.toast(e.message, 'error'); }
      save.disabled = false;
    };
    save.addEventListener('click', submit);
    [date, text].forEach((n) => n.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }));
    body.appendChild(section('New note · ' + plain, [el('div', { class: 'px-drow' }, [date, save]), text]));

    // timeline
    const list = el('div', { class: 'px-notes' });
    if (st.notes.loading) list.appendChild(el('div', { class: 'px-muted', text: 'Loading notes…' }));
    else if (st.notes.error) list.appendChild(el('div', { class: 'px-muted px-down', text: st.notes.error }));
    else if (!st.notes.items.length) list.appendChild(el('div', { class: 'px-muted', text: 'No notes yet for ' + plain + '.' }));
    st.notes.items.forEach((n) => list.appendChild(noteItem(n, sym)));
    body.appendChild(section('Timeline (' + st.notes.items.length + ')', [list]));
  }
  function noteItem(n, sym) {
    const editing = st.notes.editing === n.id;
    const head = el('div', { class: 'px-note-head' }, [
      el('span', { class: 'px-note-date', text: shortDate(n.note_date) }),
      el('span', { class: 'px-header-spacer' }),
      editing ? null : el('button', { class: 'px-act', title: 'Edit', text: '✎', onclick: () => { st.notes.editing = n.id; renderDrawer(); } }),
      editing ? null : el('button', { class: 'px-act px-act-del', title: 'Delete', text: '🗑', onclick: () => deleteNote(n, sym) }),
    ]);
    if (!editing) return el('div', { class: 'px-note' }, [head, el('div', { class: 'px-note-body', text: n.content })]);
    const date = el('input', { type: 'date', class: 'px-input', value: String(n.note_date || '').slice(0, 10) });
    const text = el('textarea', { class: 'px-input px-note-text', value: '' });
    text.value = n.content || '';
    const saveBtn = el('button', { class: 'px-small-btn px-primary', text: 'Save' });
    const cancel = el('button', { class: 'px-small-btn', text: 'Cancel', onclick: () => { st.notes.editing = null; renderDrawer(); } });
    const submit = async () => {
      if (!text.value.trim()) { U.toast('Write something first', 'error'); return; }
      saveBtn.disabled = true;
      try {
        await U.send({ type: 'notes.update', id: n.id, patch: { content: text.value.trim(), note_date: date.value } });
        st.notes.editing = null;
        U.toast('Note updated', 'success', 1500);
        await loadNotes(sym, true);
      } catch (e) { U.toast(e.message, 'error'); saveBtn.disabled = false; }
    };
    saveBtn.addEventListener('click', submit);
    [date, text].forEach((x) => x.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } if (e.key === 'Escape') cancel.click(); }));
    return el('div', { class: 'px-note px-note-editing' }, [head, el('div', { class: 'px-drow' }, [date, saveBtn, cancel]), text]);
  }
  function deleteNote(n, sym) {
    U.dialog({ title: 'Delete note', actionLabel: 'Delete', danger: true,
      body: el('div', { html: 'Delete the note of <b>' + esc(shortDate(n.note_date)) + '</b>?<br><span class="px-muted">' + esc(String(n.content).slice(0, 160)) + '</span>' }),
      onConfirm: async () => { await U.send({ type: 'notes.delete', id: n.id }); U.toast('Note deleted', 'success', 1500); await loadNotes(sym, true); } });
  }

  // =============================================================================
  // Symbol switching — drive TradingView's own symbol search
  // =============================================================================
  function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function keyEnter(target) {
    ['keydown', 'keypress', 'keyup'].forEach((t) => target.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })));
  }

  function switchTo(symbol) {
    const tvSym = S.toTradingView(symbol);
    if (!tvSym) return;
    st.activeSymbol = symbol;
    highlightActive();
    renderHeld();
    renderDrawer();
    hideHover();
    document.body.classList.add('px-switching');
    const btn = q1(TV.searchButton);
    if (!btn) { document.body.classList.remove('px-switching'); U.toast('TradingView symbol search button not found — selectors need updating', 'error'); return; }
    btn.click();
    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      const dlg = q1(TV.dialog);
      let input = dlg ? q1(TV.input, dlg) : null;
      if (!input) input = Array.from(document.querySelectorAll('input[data-role="search"]')).find((i) => !panel.contains(i) && !drawer.contains(i)) || null;
      if (input) {
        clearInterval(poll);
        setNativeValue(input, tvSym);
        setTimeout(() => {
          keyEnter(input);
          setTimeout(() => {
            if (document.body.contains(input)) {
              const first = q1(TV.firstResult, dlg || document);
              if (first) first.click();
            }
            setTimeout(() => {
              const still = q1(TV.dialog);
              if (still && document.body.contains(still) && q1(TV.input, still)) {
                const close = q1(TV.close, still);
                if (close) close.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
              }
              document.body.classList.remove('px-switching');
              st.lastSwitchAt = Date.now();
              setTimeout(syncActiveSymbol, 600);
            }, 60);
          }, 40);
        }, 30);
      } else if (tries > 60) {
        clearInterval(poll);
        document.body.classList.remove('px-switching');
        U.toast('Could not open TradingView symbol search', 'error');
      }
    }, 10);
  }

  // ---- active symbol detection ----------------------------------------------
  function detectChartSymbol() {
    const bad = /^(TRADINGVIEW|CHART|UNTITLED|ADVANCED|TECHNICAL|STOCK)$/;
    const cand = [];
    const btn = q1(TV.searchButton);
    if (btn && btn.innerText) cand.push(btn.innerText.trim().split(/\s+/)[0]);
    const t = (document.title || '').trim();
    if (t) cand.push(t.split(/\s+/)[0]);
    const leg = q1(TV.legend);
    if (leg && leg.innerText) cand.push(leg.innerText.trim().split(/\s+/)[0]);
    try { const u = new URL(location.href).searchParams.get('symbol'); if (u) cand.push(u); } catch (e) { /* ignore */ }
    for (const c of cand) {
      const tok = String(c || '').replace(/[,]/g, '').toUpperCase();
      if (!tok || bad.test(tok) || !/^[A-Z0-9_&\-:.]{2,25}$/.test(tok)) continue;
      const p = S.toPlutus(tok);
      if (p) return p;
    }
    return null;
  }
  function syncActiveSymbol() {
    if (Date.now() - st.lastSwitchAt < 500) return;
    const sym = detectChartSymbol();
    if (sym) announce(sym);             // what the chart really shows -> linked Screener tab
    renderHeld();                       // title ticks carry the live price
    if (!sym || sym === st.activeSymbol) { highlightActive(); return; }
    st.activeSymbol = sym;
    renderDrawer();
    // Follow the chart into whichever list holds the symbol, if the current one does not.
    if (!activeSymbols().includes(sym)) {
      const e = st.stocks.get(sym);
      const mkt = L.marketOfEntry(e, sym);
      if (e && mkt !== st.region && hasUs()) setRegion(mkt);
      const pool = poolsInRegion().find((p) => (e || { pools: [] }).pools.includes(p.code));
      const wl = st.watchlists.find((w) => (w.symbols || []).includes(sym));
      if (pool) st.active = { kind: 'pool', id: pool.code, name: pool.name };
      else if (wl) st.active = { kind: 'wl', id: wl.id, name: wl.name };
      renderSelect(); renderSlicer(); renderSectors(); renderList();
      return;
    }
    highlightActive();
  }
  function highlightActive() {
    listEl.querySelectorAll('.px-item').forEach((n) => n.classList.toggle('px-active', n.getAttribute('data-symbol') === st.activeSymbol));
    scrollActiveIntoView();
  }

  // =============================================================================
  // Linked tabs (idea 1) — chart <-> Screener company tab
  // =============================================================================
  /** Tell the worker which symbol the chart confirms, once per change. */
  function announce(sym) {
    if (!st.settings.linkTabs || sym === st.announced) return;
    st.announced = sym;
    U.send({ type: 'link.symbol', from: 'tv', symbol: sym }).catch(() => {});
  }
  /** A Screener tab opened a company: bring the chart to it (no echo back). */
  function followLinkedSymbol(symbol) {
    const sym = S.toPlutus(symbol);
    if (!sym || !st.settings.linkTabs) return;
    st.announced = sym;
    if (detectChartSymbol() === sym) return;
    switchTo(sym);
  }

  // =============================================================================
  // Walk-through list shared with Screener (idea 2)
  // =============================================================================
  /** Publish the visible list (after filter + sort) so ← / → on Screener walks the same stocks. */
  function publishNav(rows) {
    if (!st.active || !U.contextAlive()) return;
    const nav = { kind: st.active.kind, id: st.active.id, name: st.active.name || String(st.active.id), symbols: rows.map((r) => r.symbol), source: 'tv' };
    const json = JSON.stringify(nav);
    if (json === st.navJson) return;
    st.navJson = json;
    clearTimeout(st.navTimer);
    st.navTimer = setTimeout(() => { try { chrome.storage.local.set({ [NAV_KEY]: Object.assign({ at: Date.now() }, nav) }); } catch (e) { /* ignore */ } }, 250);
  }
  /** Screener picked a different list in its pill: show the same list here. */
  function adoptNavFromScreener(nav) {
    if (!nav || nav.source !== 'screener' || !st.boot) return;
    const same = st.active && st.active.kind === nav.kind && String(st.active.id) === String(nav.id);
    if (same) return;
    const target = { kind: nav.kind, id: nav.kind === 'wl' ? (isNaN(Number(nav.id)) ? nav.id : Number(nav.id)) : nav.id, name: nav.name };
    if (!listExists(target)) return;
    st.active = target; st.capFilter = 'All'; st.sectorFilter = 'All'; st.filter = ''; if (filterInput) filterInput.value = '';
    saveActiveList();
    renderSelect(); renderSlicer(); renderSectors(); renderList();
  }

  // =============================================================================
  // Held-position strip (idea 4)
  // =============================================================================
  /** Live price: the scanner quote, else the tab title ("INFY 1,020.5 ▼ −0.86%") when it names the symbol, else the nightly close. */
  function livePrice(symbol) {
    const q = st.live.get(symbol);
    if (q && !q.stale && q.close > 0) return { price: q.close, live: true };
    const m = /^(\S+)\s+([\d,]+(?:\.\d+)?)/.exec((document.title || '').trim());
    if (m && S.toPlutus(m[1]) === symbol) { const n = Number(m[2].replace(/,/g, '')); if (Number.isFinite(n) && n > 0) return { price: n, live: true }; }
    const e = st.stocks.get(symbol);
    const c = e ? num(e.close) : null;
    return c ? { price: c, live: false } : null;
  }
  function renderHeld() {
    if (!heldEl) return;
    const sym = st.activeSymbol;
    const lots = sym && st.lots ? (st.lots.get(S.toPlain(sym)) || []) : [];
    if (!st.settings.tvHeldStrip || !lots.length) { heldEl.style.display = 'none'; return; }
    const qty = lots.reduce((a, t) => a + (Number(t.qty) || 0), 0);
    const cost = lots.reduce((a, t) => a + (num(t.buy_price) || 0) * (Number(t.qty) || 0), 0);
    if (!(qty > 0)) { heldEl.style.display = 'none'; return; }
    const avg = cost / qty;
    const lp = livePrice(sym);
    const first = lots.map((t) => t.buy_date).filter(Boolean).sort()[0];
    const days = first ? Math.max(0, Math.floor((Date.now() - new Date(first + 'T00:00:00').getTime()) / 86400000)) : null;
    // Newest lot that carries a target / stop is the plan in force.
    const newest = lots.slice().sort((a, b) => String(b.buy_date).localeCompare(String(a.buy_date)));
    const target = (newest.find((t) => num(t.target_price)) || {}).target_price;
    const stopP = (newest.find((t) => num(t.stop_price)) || {}).stop_price;
    const pnl = lp ? (lp.price - avg) * qty : null;
    const pnlPct = lp ? (lp.price / avg - 1) * 100 : null;
    const dist = (p) => (lp && num(p) ? ((num(p) / lp.price - 1) * 100) : null);
    const sign = (v, nd) => (v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(nd == null ? 1 : nd));
    const cur = L.marketOfEntry(st.stocks.get(sym), sym) === 'US' ? '$' : '₹';
    const locale = cur === '$' ? 'en-US' : 'en-IN';
    const rupee = (v) => (v < 0 ? '−' : '') + cur + Math.round(Math.abs(v)).toLocaleString(locale);
    const signedRupee = (v) => (v >= 0 ? '+' : '−') + cur + Math.round(Math.abs(v)).toLocaleString(locale);
    const openRisk = num(stopP) && lp ? Math.max(0, lp.price - num(stopP)) * qty : null;
    const expanded = heldExpanded();

    heldEl.innerHTML = '';
    heldEl.style.display = '';
    heldEl.classList.toggle('px-held-open', expanded);

    // 1. who / how much — the toggle opens the per-lot breakdown
    const toggle = el('button', { class: 'px-held-toggle', type: 'button', title: expanded ? 'Hide lots' : 'Show each lot', onclick: () => setHeldExpanded(!expanded) },
      [(lots.length > 1 ? lots.length + ' lots' : '1 lot') + (expanded ? ' ▴' : ' ▾')]);
    heldEl.appendChild(el('div', { class: 'px-held-head' }, [
      el('span', { class: 'px-chip px-chip-held', text: 'HELD' }),
      el('span', { class: 'px-held-qty', text: qty.toLocaleString(locale) + ' @ ' + cur + U.fmt(avg, 2) }),
      el('span', { class: 'px-header-spacer' }),
      toggle,
    ]));

    // 2. the number that matters, big
    heldEl.appendChild(el('div', { class: 'px-held-pnl ' + (pnl == null ? '' : pnl >= 0 ? 'px-up' : 'px-down') }, [
      el('span', { class: 'px-held-pnl-pct', text: pnl == null ? '—' : sign(pnlPct) + '%' }),
      el('span', { class: 'px-held-pnl-amt', text: pnl == null ? '' : signedRupee(pnl) }),
      el('span', { class: 'px-header-spacer' }),
      el('span', { class: 'px-muted', text: lp ? (lp.live ? 'live ' : 'close ') + cur + U.fmt(lp.price, 2) : '' }),
    ]));

    // 3. plan in force, two columns so nothing truncates at the default width
    const cell = (label, value, cls, title) => el('div', { class: 'px-held-cell' + (cls ? ' ' + cls : ''), title: title || '' }, [el('span', { class: 'px-held-k', text: label }), el('span', { class: 'px-held-v', text: value })]);
    heldEl.appendChild(el('div', { class: 'px-held-grid' }, [
      cell('Target', num(target) ? cur + U.fmt(target, 0) + '  ' + sign(dist(target)) + '%' : '—', num(target) && lp && lp.price >= num(target) ? 'px-up' : '', 'Newest lot with a target · distance from the current price'),
      cell('Stop', num(stopP) ? cur + U.fmt(stopP, 0) + '  ' + sign(dist(stopP)) + '%' : '—', num(stopP) && lp && lp.price <= num(stopP) ? 'px-down' : '', 'Newest lot with a stop · distance from the current price'),
      cell('Invested → value', rupee(cost) + (lp ? ' → ' + rupee(lp.price * qty) : ''), ''),
      cell('Held · risk to stop', (days == null ? '—' : days + 'd') + ' · ' + (openRisk == null ? 'no stop' : rupee(openRisk)), openRisk == null ? 'px-warn' : '', first ? 'First buy ' + first : ''),
    ]));

    // 4. per-lot breakdown (expanded)
    if (expanded) {
      const table = el('div', { class: 'px-held-lots' });
      table.appendChild(el('div', { class: 'px-held-lot px-held-lot-head' }, ['Bought', 'Qty @', 'P&L', 'T / SL'].map((h) => el('span', { text: h }))));
      newest.forEach((t) => {
        const bp = num(t.buy_price), q = Number(t.qty) || 0;
        const lotPct = lp && bp ? (lp.price / bp - 1) * 100 : null;
        table.appendChild(el('div', { class: 'px-held-lot', title: (t.strategy ? t.strategy + ' · ' : '') + (t.order_type || '') }, [
          el('span', { text: shortDate(t.buy_date) }),
          el('span', { text: q + ' @ ' + (bp ? U.fmt(bp, 1) : '—') }),
          el('span', { class: lotPct == null ? '' : lotPct >= 0 ? 'px-up' : 'px-down', text: lotPct == null ? '—' : sign(lotPct) + '%' }),
          el('span', { text: (num(t.target_price) ? U.fmt(t.target_price, 0) : '—') + ' / ' + (num(t.stop_price) ? U.fmt(t.stop_price, 0) : '—') }),
        ]));
      });
      heldEl.appendChild(table);
    }
    heldEl.removeAttribute('title');
  }
  /** '2026-09-10' -> '10 Sep 26' (unambiguous, short enough for the lot table). */
  function shortDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return '—';
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return Number(m[3]) + ' ' + MON[Number(m[2]) - 1] + ' ' + m[1].slice(2);
  }
  const LS_HELD_OPEN = 'plutus_tv_held_open_v1';
  function heldExpanded() {
    try { return localStorage.getItem(LS_HELD_OPEN) === '1'; } catch (e) { return false; }
  }
  function setHeldExpanded(on) {
    try { localStorage.setItem(LS_HELD_OPEN, on ? '1' : '0'); } catch (e) { /* ignore */ }
    renderHeld();
  }

  // =============================================================================
  // Position sizer (idea 3)
  // =============================================================================
  function sizerDialog(symbol) {
    if (!symbol) return;
    if (!st.settings.token) { U.toast('The sizer needs a Plutus token (capital and journal) — extension popup', 'error'); return; }
    const e = st.stocks.get(symbol) || {};
    const lp = livePrice(symbol);
    const pos = st.positions.get(S.toPlain(symbol));
    window.PlutusSizer.open({
      symbol, cap: e.cap || null,
      entry: lp ? lp.price : null, entryLabel: lp ? (lp.live ? 'live' : 'last close') : '',
      snapshot: e, heldValue: pos ? Number(pos.invested) || 0 : 0, settings: st.settings,
    }).then((done) => { if (done) U.send({ type: 'trades.open', force: true }).catch(() => {}); });
  }
  function scrollActiveIntoView() {
    const a = listEl.querySelector('.px-item.px-active');
    if (a) a.scrollIntoView({ block: 'nearest' });
  }
  function observeTitle() {
    const t = document.querySelector('title');
    if (!t) return;
    new MutationObserver(() => syncActiveSymbol()).observe(t, { childList: true, characterData: true, subtree: true });
  }

  // =============================================================================
  // Keyboard
  // =============================================================================
  function inTextField(e) {
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }
  function onKeyDown(e) {
    if (e.altKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); e.stopImmediatePropagation(); togglePanel(); return; }
    if (e.altKey && (e.key === 'e' || e.key === 'E') && !panel.classList.contains('px-collapsed')) { e.preventDefault(); e.stopImmediatePropagation(); toggleWide(); return; }
    if (e.altKey && (e.key === 'd' || e.key === 'D') && !panel.classList.contains('px-collapsed')) { e.preventDefault(); e.stopImmediatePropagation(); toggleDrawer(); return; }
    if (panel.classList.contains('px-collapsed')) return;
    if (document.querySelector('.px-dialog-overlay')) return;
    if (inTextField(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (k === 'ArrowDown' || (k === ' ' && st.settings.tvSpaceKeyNavigates)) { stop(); navigate(1); }
    else if (k === 'ArrowUp') { stop(); navigate(-1); }
    else if (k === 'ArrowRight') { stop(); cycleList(1); }
    else if (k === 'ArrowLeft') { stop(); cycleList(-1); }
    else if (k === '/') { stop(); filterInput.focus(); filterInput.select(); }
    else if (k === 'n' || k === 'N') { stop(); noteDialog(currentSymbol()); }
    else if (k === 'b' || k === 'B') { stop(); bookmarkDialog(currentSymbol()); }
    else if (k === 'o' || k === 'O') { stop(); opportunityDialog(currentSymbol()); }
    else if (k === 's' || k === 'S') { stop(); openScreener(currentSymbol()); }
    else if (k === 'p' || k === 'P') { stop(); openPlutus(currentSymbol()); }
    else if (k === 'a' || k === 'A') { stop(); togglePlayArea(currentSymbol()); }
    else if (k === 'z' || k === 'Z') { stop(); sizerDialog(currentSymbol()); }
  }
  function currentSymbol() {
    return st.activeSymbol || (listEl.querySelector('.px-item') || {}).getAttribute?.('data-symbol') || null;
  }
  function navigate(dir) {
    const items = Array.from(listEl.querySelectorAll('.px-item'));
    if (!items.length) return;
    let idx = items.findIndex((n) => n.getAttribute('data-symbol') === st.activeSymbol);
    idx = idx < 0 ? (dir > 0 ? 0 : items.length - 1) : (idx + dir + items.length) % items.length;
    const sym = items[idx].getAttribute('data-symbol');
    st.activeSymbol = sym;
    highlightActive();
    clearTimeout(st.switchTimer);
    st.switchTimer = setTimeout(() => switchTo(sym), 70);
  }
  function cycleList(dir) {
    const opts = Array.from(selectEl.querySelectorAll('option'));
    if (!opts.length) return;
    let idx = opts.findIndex((o) => o.value === selectEl.value);
    idx = (idx + dir + opts.length) % opts.length;
    selectEl.value = opts[idx].value;
    onSelectList();
    U.toast(st.active.name, 'info', 1200);
  }

  // =============================================================================
  // Actions
  // =============================================================================
  function openScreener(symbol) { const u = symbol && S.toScreenerUrl(symbol); if (u) window.open(u, '_blank'); else if (symbol) U.toast('Screener.in has no US pages', 'info', 1500); }
  function openPlutus(symbol) { const u = symbol && S.toPlutusUrl(st.settings.webAppUrl, symbol); if (u) window.open(u, '_blank'); }

  async function addSymbolsToActive() {
    const w = activeWatchlist();
    if (!w) return;
    const syms = S.parseList(addInput.value);
    if (!syms.length) { U.toast('No valid symbols', 'error'); return; }
    try {
      const res = await U.send({ type: 'watchlist.add', id: w.id, symbols: syms });
      addInput.value = '';
      await reloadWatchlists();
      U.toast((res.added || []).length + ' added to ' + w.name, 'success');
    } catch (e) { U.toast(e.message, 'error'); }
  }
  async function removeFromActive(symbol) {
    const w = activeWatchlist();
    if (!w) return;
    try { await U.send({ type: 'watchlist.remove', id: w.id, symbol }); await reloadWatchlists(); U.toast(S.toPlain(symbol) + ' removed', 'success', 1500); }
    catch (e) { U.toast(e.message, 'error'); }
  }
  async function reloadWatchlists() {
    const wl = await U.send({ type: 'watchlists' });
    st.watchlists = wl.watchlists || []; st.wlSource = wl.source || 'local';
    if (!listExists(st.active)) st.active = defaultList();
    renderSelect(); renderSlicer(); renderSectors(); renderList(); renderDrawer();
  }

  function newListDialog(prefill) {
    const name = el('input', { type: 'text', placeholder: 'e.g. Banks to watch', maxlength: '60' });
    const syms = el('input', { type: 'text', placeholder: 'Optional: TCS, INFY, M&M', value: prefill ? S.toPlain(prefill) : '' });
    return U.dialog({
      title: 'New watchlist', actionLabel: 'Create',
      body: el('div', {}, [el('label', {}, ['Name', name]), el('label', {}, ['Symbols', syms])]),
      onConfirm: async () => {
        if (!name.value.trim()) throw new Error('Name is required');
        const w = await U.send({ type: 'watchlist.create', name: name.value.trim(), symbols: S.parseList(syms.value) });
        await reloadWatchlists();
        st.active = { kind: 'wl', id: w.id, name: w.name }; saveActiveList(); renderSelect(); renderSlicer(); renderSectors(); renderList(); renderDrawer();
        U.toast('Watchlist ' + w.name + ' created', 'success');
      },
    });
  }
  function renameListDialog() {
    const w = activeWatchlist(); if (!w) return;
    const name = el('input', { type: 'text', value: w.name, maxlength: '60' });
    U.dialog({ title: 'Rename watchlist', actionLabel: 'Rename', body: el('label', {}, ['Name', name]),
      onConfirm: async () => {
        if (!name.value.trim()) throw new Error('Name is required');
        await U.send({ type: 'watchlist.update', id: w.id, patch: { name: name.value.trim() } });
        st.active.name = name.value.trim(); saveActiveList();
        await reloadWatchlists(); U.toast('Renamed', 'success', 1500);
      } });
  }
  function deleteListDialog() {
    const w = activeWatchlist(); if (!w) return;
    U.dialog({ title: 'Delete watchlist', actionLabel: 'Delete', danger: true,
      body: el('div', { html: 'Delete <b>' + esc(w.name) + '</b> (' + (w.symbols || []).length + ' symbols)? This cannot be undone.' }),
      onConfirm: async () => { await U.send({ type: 'watchlist.delete', id: w.id }); st.active = null; await reloadWatchlists(); saveActiveList(); U.toast('Deleted', 'success', 1500); } });
  }

  function bookmarkDialog(symbol) {
    if (!symbol) return;
    const plain = S.toPlain(symbol);
    const list = el('div', { class: 'px-radio-list' });
    const mkt = L.marketOfEntry(st.stocks.get(symbol), symbol);
    const lists = st.watchlists.filter((w) => L.listVisibleIn(mkt, L.listMarket(w.symbols, st.stocks)));
    lists.forEach((w, i) => {
      const has = (w.symbols || []).includes(symbol);
      list.appendChild(el('label', {}, [el('input', { type: 'radio', name: 'px-wl', value: String(w.id), ...(i === 0 ? { checked: 'checked' } : {}) }), w.name + ' (' + (w.symbols || []).length + ')' + (has ? ' — already in' : '')]));
    });
    list.appendChild(el('label', {}, [el('input', { type: 'radio', name: 'px-wl', value: '__new__' }), '＋ New watchlist…']));
    if (st.settings.token) list.appendChild(el('label', {}, [el('input', { type: 'radio', name: 'px-wl', value: '__playarea__' }), '⚡ PlayArea pool (Plutus universe)']));
    U.dialog({ title: 'Bookmark ' + plain, actionLabel: 'Add', body: list,
      onConfirm: async (card) => {
        const v = (card.querySelector('input[name=px-wl]:checked') || {}).value;
        if (!v) throw new Error('Pick a list');
        if (v === '__new__') { setTimeout(() => newListDialog(symbol), 0); return true; }
        if (v === '__playarea__') { await togglePlayArea(symbol, true); return true; }
        const res = await U.send({ type: 'watchlist.add', id: isNaN(Number(v)) ? v : Number(v), symbols: [symbol] });
        await reloadWatchlists();
        U.toast(((res.added || []).length ? plain + ' added to ' : plain + ' already in ') + (res.watchlist || {}).name, 'success');
      } });
  }

  async function togglePlayArea(symbol, forceAdd) {
    if (!symbol) return;
    if (!st.settings.token) { U.toast('PlayArea needs a Plutus token (extension popup)', 'error'); return; }
    const e = st.stocks.get(symbol);
    const inPlay = !!(e && (e.pools || []).includes('PlayArea'));
    try {
      if (inPlay && !forceAdd) {
        await U.send({ type: 'playarea.remove', symbol });
        U.toast(S.toPlain(symbol) + ' removed from PlayArea', 'success');
      } else {
        const res = await U.send({ type: 'playarea.add', symbol });
        U.toast(S.toPlain(symbol) + (res.already_member ? ' is already in PlayArea' : ' added to PlayArea — data arrives on the next sync'), 'success');
      }
      await loadAll();
    } catch (err) { U.toast(err.message, 'error'); }
  }

  function noteDialog(symbol) {
    if (!symbol) return;
    if (!st.settings.token) { U.toast('Notes need a Plutus token (extension popup)', 'error'); return; }
    const plain = S.toPlain(symbol);
    const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const text = el('textarea', { placeholder: 'Your view on ' + plain + ' today — thesis, results read, valuation, risks, triggers…' });
    const recent = el('div', { class: 'px-muted', text: 'Loading recent notes…' });
    U.send({ type: 'notes.list', symbol, limit: 3 }).then((r) => {
      const notes = r.notes || [];
      recent.innerHTML = notes.length ? '<b>Recent:</b> ' + notes.map((n) => esc(n.note_date) + ' — ' + esc(String(n.content).slice(0, 90)) + (n.content.length > 90 ? '…' : '')).join('<br>') : 'No notes yet for ' + esc(plain) + '.';
      recent.appendChild(el('a', { href: '#', text: ' See all in the drawer', onclick: (ev) => {
        ev.preventDefault();
        const overlay = document.querySelector('.px-dialog-overlay'); if (overlay) overlay.remove();
        if (!st.activeSymbol) st.activeSymbol = symbol;
        setDrawerTab('notes');
      } }));
    }).catch((e) => { recent.textContent = e.message; });
    U.dialog({ title: 'Note · ' + plain, actionLabel: 'Save note',
      body: el('div', {}, [el('label', {}, ['View as of', date]), el('label', {}, ['Note', text]), recent]),
      onConfirm: async () => {
        if (!text.value.trim()) throw new Error('Write something first');
        await U.send({ type: 'notes.create', symbol, content: text.value.trim(), note_date: date.value });
        U.toast('Note saved to Plutus', 'success');
        if (st.notes.symbol === symbol) loadNotes(symbol, true);
      } });
  }

  function opportunityDialog(symbol) {
    if (!symbol) return;
    if (!st.settings.token) { U.toast('Opportunities need a Plutus token (extension popup)', 'error'); return; }
    const r = rowFor(symbol);
    const close = r.entry ? num(r.entry.close) : null;
    const cur = r.market === 'US' ? '$' : '₹';
    const price = el('input', { type: 'number', step: '0.05', value: close != null ? String(close) : '' });
    const qty = el('input', { type: 'number', step: r.market === 'US' ? '0.0001' : '1', placeholder: 'optional' });
    const target = el('input', { type: 'number', step: '0.05', placeholder: 'optional' });
    const strategy = el('select', {});
    ['', 'Envelope (200 DMA)', '52-Week Low', '20% Rally', 'Fundamental', 'Other'].forEach((s) => strategy.appendChild(el('option', { value: s, text: s || '— strategy —' })));
    const action = el('select', {});
    ['Analyse Now', 'Buy Now', 'GTT', 'Later'].forEach((s) => action.appendChild(el('option', { value: s, text: s })));
    const notes = el('textarea', { placeholder: 'Why now?', style: 'min-height:70px' });
    U.dialog({ title: 'Add opportunity · ' + r.plain, actionLabel: 'Add to journal',
      body: el('div', {}, [
        el('label', {}, ['Buy / reference price (' + cur + ')', price]), el('label', {}, ['Qty', qty]), el('label', {}, ['Target (' + cur + ')', target]),
        el('label', {}, ['Strategy', strategy]), el('label', {}, ['Action', action]), el('label', {}, ['Notes', notes]),
      ]),
      onConfirm: async () => {
        const body = { symbol, opp_date: new Date().toISOString().slice(0, 10), buy_price: price.value || null, qty: qty.value ? Number(qty.value) : null,
          target_price: target.value || null, strategy: strategy.value || null, action_filter: action.value, notes: notes.value.trim() || null, cap_bucket: (r.entry && r.entry.cap) || null, status: 'ACTIVE' };
        await U.send({ type: 'opportunity.create', body });
        U.toast('Opportunity added to the Plutus journal', 'success');
      } });
  }

  // =============================================================================
  // Focus mode — hide TradingView's upsell dialogs (narrow: only known upsell markers)
  // =============================================================================
  let focusObserver = null;
  function applyFocusMode() {
    const on = !!(st.settings && st.settings.tvFocusMode);
    document.body.classList.toggle('px-focus', on);
    if (on && !focusObserver) {
      focusObserver = new MutationObserver((muts) => {
        muts.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) sweep(n); }));
      });
      focusObserver.observe(document.body, { childList: true, subtree: true });
    } else if (!on && focusObserver) { focusObserver.disconnect(); focusObserver = null; }
  }
  function sweep(node) {
    const attrs = ((node.getAttribute && (node.getAttribute('data-dialog-name') || '') + ' ' + (node.getAttribute('data-name') || '') + ' ' + (node.className || '')) || '').toLowerCase();
    if (!/gopro|go-pro|upgrade|black-friday|cyber-monday|promo/.test(attrs)) return;
    if (/px-|plutus|symbol-search|properties|settings|alert|indicator/.test(attrs)) return;
    const close = node.querySelector && (node.querySelector('button[data-name="close"]') || node.querySelector('button[aria-label*="close" i]') || node.querySelector('[class*="closeButton-"]'));
    if (close) close.click(); else node.remove();
  }

  // ---- go ----------------------------------------------------------------------
  if (document.body) start(); else window.addEventListener('DOMContentLoaded', start);
})();
