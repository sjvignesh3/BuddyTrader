/**
 * Plutus Companion — TradingView content script.
 *
 * A floating panel over the chart that lists Plutus pools and custom
 * watchlists, switches the chart symbol instantly, follows the chart's
 * active symbol, and shows Plutus signals per row. Hot-keys make the
 * whole analysis loop keyboard-driven.
 *
 * Data comes only from the service worker (background.js); this file never
 * fetches anything itself.
 */
(function () {
  'use strict';
  if (window.__plutusTvLoaded) { if (typeof window.__plutusTvReload === 'function') window.__plutusTvReload(); return; }
  window.__plutusTvLoaded = true;

  const S = window.PlutusSymbols, U = window.PlutusUI, SET = window.PlutusSettings;
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
  const CAP_LETTER = { Large: 'L', Mid: 'M', Small: 'S', Micro: 'S' };

  const LS_LAYOUT = 'plutus_tv_layout_v1';
  const LS_ACTIVE = 'plutus_tv_active_list_v1';

  // ---- state ------------------------------------------------------------------
  const st = {
    settings: null,
    boot: null,                 // bootstrap payload
    stocks: new Map(),          // "TCS.NS" -> entry
    watchlists: [],             // custom lists [{id,name,symbols}]
    wlSource: 'local',
    positions: new Map(),       // "TCS" -> {qty, invested}
    active: null,               // {kind:'pool'|'wl', id, name}
    activeSymbol: null,         // Plutus form of what the chart shows
    capFilter: 'All',
    filter: '',
    switchTimer: null,
    lastSwitchAt: 0,
    loading: false,
    error: null,
  };
  let panel, toggleBtn, listEl, selectEl, slicerEl, filterInput, sortSelect, asofEl, bannerEl, addRow, addInput, hintEl, focusBtn;

  // =============================================================================
  // Boot
  // =============================================================================
  async function start() {
    st.settings = await SET.get();
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
    SET.onChange((s) => { st.settings = s; applyFocusMode(); renderList(); renderHint(); });
    if (U.contextAlive()) chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'plutus:bootstrap-updated') loadAll(); });
  }
  window.__plutusTvReload = () => loadAll();

  async function loadAll() {
    st.loading = true; st.error = null; renderBanner();
    try {
      const [boot, wl, pos] = await Promise.all([
        U.send({ type: 'bootstrap' }, 95000),
        U.send({ type: 'watchlists' }).catch((e) => ({ source: 'local', watchlists: [], _error: e.message })),
        U.send({ type: 'positions' }).catch(() => ({ positions: [] })),
      ]);
      st.boot = boot;
      st.stocks = new Map((boot.stocks || []).map((s) => [s.symbol, s]));
      st.watchlists = wl.watchlists || [];
      st.wlSource = wl.source || 'local';
      st.positions = new Map((pos.positions || []).map((p) => [String(p.symbol).toUpperCase(), p]));
      if (boot._stale) st.error = 'Plutus API unreachable — showing cached data (' + (boot._error || '') + ')';
    } catch (e) {
      st.error = e.message;
    }
    st.loading = false;
    if (!st.active || !listExists(st.active)) st.active = defaultList();
    renderAll();
  }

  // =============================================================================
  // Lists
  // =============================================================================
  function pools() { return (st.boot && st.boot.pools) || []; }
  function listExists(a) {
    if (!a) return false;
    if (a.kind === 'pool') return pools().some((p) => p.code === a.id);
    return st.watchlists.some((w) => String(w.id) === String(a.id));
  }
  function defaultList() {
    const p = pools()[0];
    if (p) return { kind: 'pool', id: p.code, name: p.name };
    const w = st.watchlists[0];
    return w ? { kind: 'wl', id: w.id, name: w.name } : null;
  }
  function restoreActiveList() {
    try { const raw = localStorage.getItem(LS_ACTIVE); if (raw) st.active = JSON.parse(raw); } catch (e) { /* ignore */ }
  }
  function saveActiveList() { try { localStorage.setItem(LS_ACTIVE, JSON.stringify(st.active)); } catch (e) { /* ignore */ } }

  /** Symbols (Plutus form) of the active list, in list order. */
  function activeSymbols() {
    if (!st.active) return [];
    if (st.active.kind === 'pool') {
      return Array.from(st.stocks.values()).filter((s) => (s.pools || []).includes(st.active.id)).map((s) => s.symbol).sort();
    }
    const w = st.watchlists.find((x) => String(x.id) === String(st.active.id));
    return w ? (w.symbols || []).slice() : [];
  }
  function activeWatchlist() {
    return st.active && st.active.kind === 'wl' ? st.watchlists.find((x) => String(x.id) === String(st.active.id)) : null;
  }

  function rowFor(symbol) {
    const e = st.stocks.get(symbol);
    const plain = S.toPlain(symbol);
    return {
      symbol, plain,
      entry: e || null,
      name: e ? e.name : null,
      cap: e ? e.cap : null,
      status: e ? e.best_status : null,
      points: e ? e.funda_points : null,
      below: e ? num(e.below_200dma_pct) : null,
      athFall: e ? num(e.fall_from_ath_pct) : null,
      held: st.positions.get(plain) || null,
    };
  }

  function conviction(r) {
    const sig = r.status ? (SIGNAL_WEIGHT[r.status] || 0) : 0;
    const score = r.points == null ? -1 : r.points;
    if (sig >= 3 && score >= 8) return 'PRIME';
    if (sig >= 3 || (sig >= 2 && score >= 8)) return 'STRONG';
    if (sig >= 1.5 || score >= 8) return 'WATCH';
    return null;
  }
  function rankValue(r) {
    const sig = r.status ? (SIGNAL_WEIGHT[r.status] || 0) : 0;
    const score = (r.points || 0) / 11;
    const depth = Math.min(Math.max(r.below || 0, 0), 30) / 100;
    return sig * 10 + score * 5 + depth;
  }

  function visibleRows() {
    let rows = activeSymbols().map(rowFor);
    if (st.capFilter !== 'All') rows = rows.filter((r) => (r.cap || 'Unknown') === st.capFilter || (st.capFilter === 'Small' && r.cap === 'Micro'));
    const f = st.filter.trim().toUpperCase();
    if (f) rows = rows.filter((r) => r.plain.includes(f) || (r.name || '').toUpperCase().includes(f));
    const sort = (st.settings && st.settings.tvSort) || 'default';
    const desc = (get) => (a, b) => ((get(b) == null ? -1e9 : get(b)) - (get(a) == null ? -1e9 : get(a)));
    if (sort === 'conviction') rows.sort((a, b) => rankValue(b) - rankValue(a));
    else if (sort === 'dma') rows.sort(desc((r) => r.below));
    else if (sort === 'ath') rows.sort(desc((r) => r.athFall));
    else if (sort === 'score') rows.sort(desc((r) => r.points));
    else if (sort === 'name') rows.sort((a, b) => a.plain.localeCompare(b.plain));
    return rows;
  }

  // =============================================================================
  // UI
  // =============================================================================
  function buildUI() {
    toggleBtn = el('button', { id: 'px-tv-toggle', title: 'Plutus panel (Alt+W)', text: 'P', onclick: togglePanel });
    document.body.appendChild(toggleBtn);

    panel = el('div', { id: 'px-tv-panel' });
    // header
    asofEl = el('span', { class: 'px-asof' });
    focusBtn = el('button', { class: 'px-icon-btn', title: 'Focus mode: hide TradingView upsell dialogs', text: '◐', onclick: () => SET.save({ tvFocusMode: !st.settings.tvFocusMode }) });
    const header = el('div', { class: 'px-header' }, [
      el('span', { class: 'px-title', html: '<span class="px-dot"></span>Plutus' }),
      asofEl,
      el('span', { class: 'px-header-spacer' }),
      el('button', { class: 'px-icon-btn', title: 'Refresh Plutus data', text: '↻', onclick: () => refresh(true) }),
      focusBtn,
      el('button', { class: 'px-icon-btn', title: 'Open Plutus', text: '⌂', onclick: () => window.open(st.settings.webAppUrl, '_blank') }),
      el('button', { class: 'px-icon-btn', title: 'Hide (Alt+W)', text: '✕', onclick: togglePanel }),
    ]);
    makeDraggable(header);
    panel.appendChild(header);

    bannerEl = el('div', { class: 'px-banner', style: 'display:none' });
    panel.appendChild(bannerEl);

    // list selector row
    selectEl = el('select', { class: 'px-select', title: 'Pool / watchlist (← → to cycle)', onchange: onSelectList });
    panel.appendChild(el('div', { class: 'px-row' }, [
      selectEl,
      el('button', { class: 'px-small-btn', title: 'New watchlist', text: '＋', onclick: newListDialog }),
      el('button', { class: 'px-small-btn', id: 'px-btn-rename', title: 'Rename watchlist', text: '✎', onclick: renameListDialog }),
      el('button', { class: 'px-small-btn px-danger', id: 'px-btn-delete', title: 'Delete watchlist', text: '🗑', onclick: deleteListDialog }),
    ]));

    // cap slicer
    slicerEl = el('div', { class: 'px-slicer' });
    panel.appendChild(slicerEl);

    // filter + sort
    filterInput = el('input', { class: 'px-input', type: 'text', placeholder: 'Filter…  ( / )', oninput: () => { st.filter = filterInput.value; renderList(); } });
    filterInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { filterInput.value = ''; st.filter = ''; renderList(); filterInput.blur(); } if (e.key === 'Enter') { const first = listEl.querySelector('.px-item'); if (first) first.click(); } e.stopPropagation(); });
    sortSelect = el('select', { class: 'px-select', style: 'flex:0 0 auto;max-width:120px', title: 'Sort', onchange: () => SET.save({ tvSort: sortSelect.value }) });
    [['default', 'A → Z'], ['conviction', 'Conviction'], ['dma', '% below DMA'], ['ath', '% off ATH'], ['score', 'Funda score']].forEach(([v, t]) => sortSelect.appendChild(el('option', { value: v, text: t })));
    panel.appendChild(el('div', { class: 'px-row' }, [filterInput, sortSelect]));

    // list
    listEl = el('div', { class: 'px-list' });
    panel.appendChild(listEl);

    // footer
    addInput = el('input', { class: 'px-input', type: 'text', placeholder: 'Add symbols: TCS, INFY, M&M…' });
    addInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') addSymbolsToActive(); if (e.key === 'Escape') addInput.blur(); });
    addRow = el('div', { style: 'display:flex;gap:6px' }, [addInput, el('button', { class: 'px-small-btn px-primary', text: 'Add', onclick: addSymbolsToActive })]);
    hintEl = el('div', { class: 'px-hint' });
    panel.appendChild(el('div', { class: 'px-footer' }, [addRow, hintEl]));

    document.body.appendChild(panel);
    restoreLayout();
    panel.addEventListener('mouseup', saveLayout);
    window.addEventListener('keydown', onKeyDown, true);
  }

  function renderAll() { renderBanner(); renderSelect(); renderSlicer(); renderList(); renderHint(); renderAsOf(); }

  function renderBanner() {
    if (!bannerEl) return;
    if (st.loading && !st.boot) { bannerEl.style.display = ''; bannerEl.className = 'px-banner px-info'; bannerEl.textContent = 'Loading Plutus universe…'; return; }
    if (st.error) { bannerEl.style.display = ''; bannerEl.className = 'px-banner'; bannerEl.textContent = st.error; return; }
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
  }

  function renderSelect() {
    selectEl.innerHTML = '';
    const og1 = el('optgroup', { label: 'Plutus pools' });
    pools().forEach((p) => og1.appendChild(el('option', { value: 'pool:' + p.code, text: p.name + ' (' + p.count + ')' })));
    const og2 = el('optgroup', { label: 'Watchlists' + (st.wlSource === 'local' ? ' (this browser)' : '') });
    st.watchlists.forEach((w) => og2.appendChild(el('option', { value: 'wl:' + w.id, text: w.name + ' (' + (w.symbols || []).length + ')' })));
    selectEl.appendChild(og1); selectEl.appendChild(og2);
    if (st.active) selectEl.value = st.active.kind + ':' + st.active.id;
    const isWl = !!activeWatchlist();
    panel.querySelector('#px-btn-rename').disabled = !isWl;
    panel.querySelector('#px-btn-delete').disabled = !isWl;
    addRow.style.display = isWl ? '' : 'none';
  }

  function renderSlicer() {
    slicerEl.innerHTML = '';
    const rows = activeSymbols().map(rowFor);
    const counts = { All: rows.length, Large: 0, Mid: 0, Small: 0 };
    rows.forEach((r) => { if (r.cap === 'Large') counts.Large++; else if (r.cap === 'Mid') counts.Mid++; else if (r.cap === 'Small' || r.cap === 'Micro') counts.Small++; });
    ['All', 'Large', 'Mid', 'Small'].forEach((c) => {
      slicerEl.appendChild(el('button', { class: c === st.capFilter ? 'px-active' : '', onclick: () => { st.capFilter = c; renderSlicer(); renderList(); } }, [
        c, el('span', { class: 'px-count', text: String(counts[c]) }),
      ]));
    });
  }

  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = '';
    const rows = visibleRows();
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
        if (r.points != null) chips.push(el('span', { class: 'px-chip px-chip-score ' + (r.points >= 8 ? 'px-strong' : r.points <= 5 ? 'px-weak' : ''), text: r.points + '/11', title: 'Fundamental score' }));
        if (r.held) chips.push(el('span', { class: 'px-chip px-chip-held', text: 'HELD ' + r.held.qty, title: 'Open position: ' + r.held.qty + ' × ₹' + U.fmt(r.held.invested / Math.max(1, r.held.qty), 0) }));
        if (r.below != null) chips.push(el('span', { class: 'px-chip px-chip-dma ' + (r.below > 0 ? 'px-pos' : ''), text: (r.below > 0 ? '−' : '+') + Math.abs(r.below).toFixed(1) + '% DMA', title: 'Distance from 200 DMA (− = below)' }));
      }
      const capL = r.cap ? (CAP_LETTER[r.cap] || 'U') : 'U';
      const item = el('div', { class: 'px-item' + (r.symbol === st.activeSymbol ? ' px-active' : '') + (r.entry ? '' : ' px-missing'), 'data-symbol': r.symbol, title: r.entry ? '' : 'Not in the Plutus universe' }, [
        el('span', { class: 'px-chip px-chip-cap-' + capL, text: capL, title: r.cap || 'Cap unknown' }),
        el('div', { class: 'px-item-main' }, [
          el('div', { class: 'px-sym', text: r.plain }),
          showChips && chips.length ? el('div', { class: 'px-chips' }, chips) : (r.name ? el('div', { class: 'px-name', text: r.name }) : null),
        ]),
        el('div', { class: 'px-actions' }, [
          el('button', { class: 'px-act', title: 'Note (N)', text: '✎', onclick: (e) => { e.stopPropagation(); noteDialog(r.symbol); } }),
          el('button', { class: 'px-act', title: 'Bookmark to a watchlist (B)', text: '🔖', onclick: (e) => { e.stopPropagation(); bookmarkDialog(r.symbol); } }),
          el('button', { class: 'px-act', title: 'Screener.in (S)', text: '⧉', onclick: (e) => { e.stopPropagation(); openScreener(r.symbol); } }),
          el('button', { class: 'px-act', title: 'Open in Plutus (P)', text: '⌂', onclick: (e) => { e.stopPropagation(); openPlutus(r.symbol); } }),
          isWl ? el('button', { class: 'px-act px-act-del', title: 'Remove from this watchlist', text: '✕', onclick: (e) => { e.stopPropagation(); removeFromActive(r.symbol); } }) : null,
        ]),
      ]);
      item.addEventListener('click', () => switchTo(r.symbol));
      listEl.appendChild(item);
    });
    scrollActiveIntoView();
  }

  function renderHint() {
    const space = st.settings.tvSpaceKeyNavigates;
    hintEl.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd>' + (space ? '<kbd>Space</kbd>' : '') + ' stock</span><span><kbd>←</kbd><kbd>→</kbd> list</span>' +
      '<span><kbd>N</kbd> note</span><span><kbd>B</kbd> bookmark</span><span><kbd>O</kbd> opportunity</span><span><kbd>S</kbd> screener</span><span><kbd>P</kbd> plutus</span><span><kbd>A</kbd> play area</span><span><kbd>Alt</kbd>+<kbd>W</kbd> panel</span>';
    focusBtn.classList.toggle('px-on', !!st.settings.tvFocusMode);
    sortSelect.value = st.settings.tvSort || 'default';
  }

  function togglePanel() {
    const collapsed = panel.classList.toggle('px-collapsed');
    SET.save({ tvPanelOpen: !collapsed });
  }

  function onSelectList() {
    const [kind, id] = selectEl.value.split(':');
    const name = kind === 'pool' ? (pools().find((p) => p.code === id) || {}).name : (st.watchlists.find((w) => String(w.id) === id) || {}).name;
    st.active = { kind, id: kind === 'pool' ? id : (isNaN(Number(id)) ? id : Number(id)), name };
    saveActiveList();
    renderSelect(); renderSlicer(); renderList();
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
    });
    window.addEventListener('mouseup', () => { if (dragging) { dragging = false; saveLayout(); } });
    handle.addEventListener('dblclick', () => { panel.style.cssText = ''; try { localStorage.removeItem(LS_LAYOUT); } catch (e) { /* ignore */ } });
  }
  function saveLayout() {
    try {
      const r = panel.getBoundingClientRect();
      localStorage.setItem(LS_LAYOUT, JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height }));
    } catch (e) { /* ignore */ }
  }
  function restoreLayout() {
    try {
      const l = JSON.parse(localStorage.getItem(LS_LAYOUT) || 'null');
      if (!l) return;
      panel.style.right = 'auto';
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 100, l.left)) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 100, l.top)) + 'px';
      panel.style.width = l.width + 'px'; panel.style.height = l.height + 'px';
    } catch (e) { /* ignore */ }
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
    document.body.classList.add('px-switching');
    const btn = q1(TV.searchButton);
    if (!btn) { document.body.classList.remove('px-switching'); U.toast('TradingView symbol search button not found — selectors need updating', 'error'); return; }
    btn.click();
    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      const dlg = q1(TV.dialog);
      let input = dlg ? q1(TV.input, dlg) : null;
      if (!input) input = Array.from(document.querySelectorAll('input[data-role="search"]')).find((i) => !panel.contains(i)) || null;
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
    if (!sym || sym === st.activeSymbol) { highlightActive(); return; }
    st.activeSymbol = sym;
    // Follow the chart into whichever list holds the symbol, if the current one does not.
    if (!activeSymbols().includes(sym)) {
      const pool = pools().find((p) => (st.stocks.get(sym) || { pools: [] }).pools.includes(p.code));
      const wl = st.watchlists.find((w) => (w.symbols || []).includes(sym));
      if (pool) st.active = { kind: 'pool', id: pool.code, name: pool.name };
      else if (wl) st.active = { kind: 'wl', id: wl.id, name: wl.name };
      renderSelect(); renderSlicer(); renderList();
      return;
    }
    highlightActive();
  }
  function highlightActive() {
    listEl.querySelectorAll('.px-item').forEach((n) => n.classList.toggle('px-active', n.getAttribute('data-symbol') === st.activeSymbol));
    scrollActiveIntoView();
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
  function openScreener(symbol) { const u = symbol && S.toScreenerUrl(symbol); if (u) window.open(u, '_blank'); }
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
    renderSelect(); renderSlicer(); renderList();
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
        st.active = { kind: 'wl', id: w.id, name: w.name }; saveActiveList(); renderSelect(); renderSlicer(); renderList();
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
    st.watchlists.forEach((w, i) => {
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
    }).catch((e) => { recent.textContent = e.message; });
    U.dialog({ title: 'Note · ' + plain, actionLabel: 'Save note',
      body: el('div', {}, [el('label', {}, ['View as of', date]), el('label', {}, ['Note', text]), recent]),
      onConfirm: async () => {
        if (!text.value.trim()) throw new Error('Write something first');
        await U.send({ type: 'notes.create', symbol, content: text.value.trim(), note_date: date.value });
        U.toast('Note saved to Plutus', 'success');
      } });
  }

  function opportunityDialog(symbol) {
    if (!symbol) return;
    if (!st.settings.token) { U.toast('Opportunities need a Plutus token (extension popup)', 'error'); return; }
    const r = rowFor(symbol);
    const close = r.entry ? num(r.entry.close) : null;
    const price = el('input', { type: 'number', step: '0.05', value: close != null ? String(close) : '' });
    const qty = el('input', { type: 'number', step: '1', placeholder: 'optional' });
    const target = el('input', { type: 'number', step: '0.05', placeholder: 'optional' });
    const strategy = el('select', {});
    ['', 'Envelope (200 DMA)', '52-Week Low', '20% Rally', 'Fundamental', 'Other'].forEach((s) => strategy.appendChild(el('option', { value: s, text: s || '— strategy —' })));
    const action = el('select', {});
    ['Analyse Now', 'Buy Now', 'GTT', 'Later'].forEach((s) => action.appendChild(el('option', { value: s, text: s })));
    const notes = el('textarea', { placeholder: 'Why now?', style: 'min-height:70px' });
    U.dialog({ title: 'Add opportunity · ' + r.plain, actionLabel: 'Add to journal',
      body: el('div', {}, [
        el('label', {}, ['Buy / reference price (₹)', price]), el('label', {}, ['Qty', qty]), el('label', {}, ['Target (₹)', target]),
        el('label', {}, ['Strategy', strategy]), el('label', {}, ['Action', action]), el('label', {}, ['Notes', notes]),
      ]),
      onConfirm: async () => {
        const body = { symbol, opp_date: new Date().toISOString().slice(0, 10), buy_price: price.value || null, qty: qty.value ? Number(qty.value) : null,
          target_price: target.value || null, strategy: strategy.value || null, action_filter: action.value, notes: notes.value.trim() || null, cap_bucket: r.cap || null, status: 'ACTIVE' };
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
