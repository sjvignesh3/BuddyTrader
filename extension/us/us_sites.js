/**
 * Plutus Companion — US research sites (F15 / F16 / F20 / F21).
 *
 *   stockanalysis.com/stocks/*   income statement, balance sheet, cash flow, ratios
 *   roic.ai/quote/*              financials (label table + value table side by side)
 *   vcpscanner.com/stock/*       financial statements
 *   stockresearch.app/stocks/*   P/E history tiles (3Y median, 3Y and 10Y low–high)
 *
 * Page-only: nothing is fetched, nothing is written to Plutus. Tables are
 * coloured with shared/table_colour.js — the Screener rules — and every
 * pass clears its own marks first, so colours never pile up. A small pill
 * (bottom-right) toggles the colouring and links to TradingView / Plutus.
 * Nothing here touches a site's own paywalled controls.
 */
(function () {
  'use strict';
  if (window.__plutusUsLoaded) return;
  window.__plutusUsLoaded = true;

  const S = window.PlutusSymbols, U = window.PlutusUI, SET = window.PlutusSettings, TC = window.PlutusTableColour;
  const el = U.el;
  // The harness swaps in a fake location; real pages use the window's own.
  const LOC = window.__plutusLocation || location;
  const HOST = LOC.hostname.replace(/^www\./, '');
  const SITE = /stockanalysis\.com$/.test(HOST) ? 'stockanalysis' : /roic\.ai$/.test(HOST) ? 'roic' : /vcpscanner\.com$/.test(HOST) ? 'vcpscanner' : /stockresearch\.app$/.test(HOST) ? 'stockresearch' : null;
  if (!SITE) return;

  const CLASSES = ['px-c-up', 'px-c-down', 'px-c-warn', 'px-c-alert', 'px-c-best', 'px-c-worst', 'px-c-note'];
  const st = { settings: null, timer: null, lastUrl: '', pill: null };

  // ---- symbol from the URL ---------------------------------------------------------
  function ticker() {
    const p = LOC.pathname;
    let m;
    if (SITE === 'stockanalysis') m = /^\/stocks\/([a-z0-9.\-]+)/i.exec(p);
    else if (SITE === 'roic') m = /^\/quote\/([a-z0-9.\-]+)/i.exec(p);
    else if (SITE === 'vcpscanner') m = /^\/stock\/([a-z0-9.\-]+)/i.exec(p);
    else if (SITE === 'stockresearch') m = /^\/stocks\/([a-z0-9.\-]+)/i.exec(p);
    if (!m) return null;
    return decodeURIComponent(m[1]).toUpperCase().replace(/\.(NS|BO)$/i, '');
  }
  /** Plutus form of the page's stock: US unless the ticker is a known Indian one (roic.ai lists NSE tickers as e.g. TCS.NS). */
  function plutusSymbol() {
    const t = ticker();
    if (!t) return null;
    const raw = /^\/quote\/([^/]+)/i.exec(LOC.pathname);
    if (SITE === 'roic' && raw && /\.(NS|BO)$/i.test(decodeURIComponent(raw[1]))) return S.toPlutus(decodeURIComponent(raw[1]));
    return S.toPlutus(t, { market: 'US' }) || t;
  }

  // ---- table discovery -------------------------------------------------------------
  const txt = (n) => (n ? String(n.innerText || n.textContent || '').trim() : '');
  function headerCells(table) {
    const thead = table.tHead;
    let row = thead ? thead.rows[thead.rows.length - 1] : null;
    if (!row) row = table.rows[0];
    return row ? Array.from(row.cells) : [];
  }
  function bodyRows(table) {
    const rows = Array.from(table.tBodies.length ? Array.from(table.tBodies).flatMap((b) => Array.from(b.rows)) : Array.from(table.rows).slice(1));
    return rows.filter((r) => r.cells.length >= 2);
  }
  /** Tables whose header holds ≥ 3 period-like cells. */
  function candidateTables() {
    return Array.from(document.querySelectorAll('table')).filter((t) => {
      if (t.closest('#px-us-pill')) return false;
      const H = headerCells(t).map(txt);
      return H.filter((h) => TC.parsePeriod(h)).length >= 3 && bodyRows(t).length >= 2;
    });
  }
  /**
   * roic.ai prints labels in one table and numbers in the next; pair them by
   * row index when a value table has no label column.
   */
  function labelsFor(table, rows) {
    const firstCol = rows.map((r) => txt(r.cells[0]));
    const numericFirst = firstCol.filter((s) => TC.parseNumber(s) != null).length > rows.length / 2;
    if (!numericFirst) return { labels: firstCol, offset: 1 };
    let prev = table.previousElementSibling;
    for (let k = 0; k < 3 && prev; k++, prev = prev.previousElementSibling) {
      const lt = prev.tagName === 'TABLE' ? prev : prev.querySelector && prev.querySelector('table');
      if (lt && lt !== table) {
        const lrows = bodyRows(lt).concat();
        if (lrows.length === rows.length || Math.abs(lrows.length - rows.length) <= 1) return { labels: lrows.map((r) => txt(r.cells[0])), offset: 0 };
      }
    }
    return { labels: firstCol.map(() => ''), offset: 0 };
  }

  function clearTable(table) {
    table.querySelectorAll('td, th').forEach((c) => {
      c.classList.remove(...CLASSES);
      if (c.hasAttribute('data-px-title')) { const prevTitle = c.getAttribute('data-px-prev-title'); if (prevTitle) c.setAttribute('title', prevTitle); else c.removeAttribute('title'); c.removeAttribute('data-px-title'); c.removeAttribute('data-px-prev-title'); }
    });
    table.removeAttribute('data-px-sig');
  }
  function mark(cell, m) {
    if (!cell || !m || !m.cls) return;
    cell.classList.add(m.cls);
    if (!cell.hasAttribute('data-px-title') && cell.getAttribute('title')) cell.setAttribute('data-px-prev-title', cell.getAttribute('title'));
    cell.setAttribute('title', m.title || '');
    cell.setAttribute('data-px-title', '1');
  }

  function colourAll() {
    const on = st.settings && st.settings.usSitesEnabled && st.settings.usHighlight;
    const tables = candidateTables();
    tables.forEach((table) => {
      if (!on) { clearTable(table); return; }
      const H = headerCells(table);
      const rows = bodyRows(table);
      const { labels, offset } = labelsFor(table, rows);
      const headers = H.slice(offset).map(txt);
      const sig = [headers.join('|'), rows.length, labels.join('|').slice(0, 400)].join('#');
      if (table.getAttribute('data-px-sig') === sig) return;
      clearTable(table);
      const data = rows.map((r, k) => ({ label: labels[k] || '', values: Array.from(r.cells).slice(offset).map((c) => TC.parseNumber(txt(c))) }));
      const marks = TC.colourTable({ headers, rows: data });
      rows.forEach((r, k) => { const cells = Array.from(r.cells).slice(offset); (marks[k] || []).forEach((m, i) => mark(cells[i], m)); });
      table.setAttribute('data-px-sig', sig);
    });
  }

  // ---- stockresearch.app: P/E history tiles --------------------------------------------
  function peTiles() {
    if (SITE !== 'stockresearch') return;
    document.querySelectorAll('.px-pe-tile').forEach((n) => n.remove());
    if (!(st.settings && st.settings.usSitesEnabled && st.settings.usHighlight)) return;
    let series = null;
    try {
      const html = document.documentElement.innerHTML;
      const m = /"history":\{"start":"(\d{4}-\d{2}-\d{2})","scale":(\d+(?:\.\d+)?),"deltas":\[([-\d.,eE\s]*)\]/.exec(html);
      if (m) series = TC.decodeDeltaSeries(m[1], Number(m[2]), m[3].split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)));
    } catch (e) { series = null; }
    if (!series || series.length < 52) return;
    const s3 = TC.seriesStats(series, 3), s10 = TC.seriesStats(series, 10);
    if (!s3 && !s10) return;
    // the site's own tile strip is a <dl> that mentions "median"
    const dl = Array.from(document.querySelectorAll('dl')).find((d) => /median/i.test(d.innerText || ''));
    if (!dl) return;
    const tile = (k, v) => el('div', { class: 'px-pe-tile' }, [el('dt', { text: k }, []), el('dd', {}, [el('span', { text: v }), el('span', { class: 'px-pe-badge', text: 'Plutus' })])]);
    if (s3) dl.appendChild(tile('3-year median', s3.median.toFixed(1) + '×'));
    if (s3) dl.appendChild(tile('3-year low to high', s3.low.toFixed(1) + '× to ' + s3.high.toFixed(1) + '×'));
    if (s10) dl.appendChild(tile('10-year low to high', s10.low.toFixed(1) + '× to ' + s10.high.toFixed(1) + '×'));
  }

  // ---- pill -----------------------------------------------------------------------
  function buildPill() {
    if (st.pill && st.pill.isConnected) return;
    st.pill = el('div', { id: 'px-us-pill' });
    document.body.appendChild(st.pill);
    renderPill();
  }
  function renderPill() {
    if (!st.pill) return;
    const sym = plutusSymbol();
    const on = !!(st.settings.usSitesEnabled && st.settings.usHighlight);
    st.pill.innerHTML = '';
    st.pill.appendChild(el('span', { class: 'px-us-brand' }, [U.logo(16), 'Plutus']));
    if (sym) st.pill.appendChild(el('span', { class: 'px-us-sym', text: S.toPlain(sym) }));
    st.pill.appendChild(el('button', { class: 'px-us-btn' + (on ? ' px-on' : ''), title: on ? 'Colouring on (click to turn off)' : 'Colouring off (click to turn on)', text: on ? '● colours' : '○ colours', onclick: () => SET.save({ usHighlight: !st.settings.usHighlight }) }));
    if (sym) {
      const tv = S.toTradingViewUrl(sym);
      if (tv) st.pill.appendChild(el('a', { class: 'px-us-btn', href: tv, target: '_blank', rel: 'noopener', title: 'Open the TradingView chart', text: 'TradingView' }));
      st.pill.appendChild(el('a', { class: 'px-us-btn', href: S.toPlutusUrl(st.settings.webAppUrl, sym), target: '_blank', rel: 'noopener', title: 'Open the Plutus stock page', text: 'Plutus' }));
      st.pill.appendChild(el('button', { class: 'px-us-btn', title: 'Dated note in the Plutus journal (N)', text: '✎ Note', onclick: () => noteDialog(sym) }));
    }
    st.pill.appendChild(el('button', { class: 'px-us-btn px-us-x', title: 'Hide the pill until the next page load', text: '✕', onclick: () => { st.pill.style.display = 'none'; } }));
  }
  function noteDialog(symbol) {
    if (!st.settings.token) { U.toast('Notes need a Plutus token — extension popup', 'error'); return; }
    const plain = S.toPlain(symbol);
    const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const text = el('textarea', { placeholder: 'Your view on ' + plain + ' today…' });
    U.dialog({ title: 'Plutus note · ' + plain, actionLabel: 'Save note', body: el('div', {}, [el('label', {}, ['View as of', date]), el('label', {}, ['Note', text])]),
      onConfirm: async () => { if (!text.value.trim()) throw new Error('Write something first'); await U.send({ type: 'notes.create', symbol, content: text.value.trim(), note_date: date.value }); U.toast('Note saved to Plutus', 'success'); } });
  }

  // ---- run loop -------------------------------------------------------------------
  function schedule() { clearTimeout(st.timer); st.timer = setTimeout(run, 250); }
  function run() {
    if (!st.settings || !st.settings.usSitesEnabled) { document.querySelectorAll('table[data-px-sig]').forEach(clearTable); if (st.pill) st.pill.style.display = 'none'; return; }
    buildPill();
    if (LOC.href !== st.lastUrl) { st.lastUrl = LOC.href; renderPill(); }
    colourAll();
    peTiles();
  }
  async function start() {
    st.settings = await SET.get();
    run();
    SET.onChange((s) => { st.settings = s; renderPill(); document.querySelectorAll('table[data-px-sig]').forEach(clearTable); run(); });
    const mo = new MutationObserver((muts) => { if (muts.some((m) => !(m.target.closest && m.target.closest('#px-us-pill, .px-pe-tile, #px-toasts, .px-dialog-overlay')))) schedule(); });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(() => { if (LOC.href !== st.lastUrl) schedule(); }, 500);
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target, tag = (t && t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
      if ((e.key === 'n' || e.key === 'N') && plutusSymbol() && !document.querySelector('.px-dialog-overlay')) { e.preventDefault(); noteDialog(plutusSymbol()); }
    }, true);
  }
  if (document.body) start(); else window.addEventListener('DOMContentLoaded', start);
})();
