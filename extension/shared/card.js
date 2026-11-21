/**
 * Plutus Companion — the Plutus stock card, shared by the Screener overlay
 * (above the ratios) and the TradingView drawer (Stock tab).
 *
 * Input is the `/api/extension/stock/{symbol}` payload; thresholds come from
 * the bootstrap (server defaults) with the popup's per-field overrides. The
 * card only formats what the server computed — no money math beyond display.
 */
(function (root) {
  'use strict';

  const U = root.PlutusUI;
  const el = (...a) => U.el(...a), num = (v) => U.num(v);

  const SIGNAL_CHIP = { BUY_ZONE: ['BUY ZONE', 'px-chip-buy'], OPPORTUNITY: ['OPPORTUNITY', 'px-chip-opp'], VALID: ['20% RALLY', 'px-chip-rally'] };
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

  /** Effective thresholds: server defaults from the bootstrap, popup overrides on top, hard fallbacks last. */
  function thresholds(boot, settings) {
    const t = (boot && boot.thresholds) || {};
    const o = (settings && settings.thresholdOverrides) || {};
    const f = t.fundamental || {};
    const pick = (k, v, d) => (o[k] !== undefined && o[k] !== '' ? Number(o[k]) : (num(v) != null ? num(v) : d));
    const DEF_TILES = (root.PlutusSettings && root.PlutusSettings.DEFAULTS.tiles) || {};
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
      tiles: (settings && settings.tiles) || DEF_TILES,
      groups: lenderGroups(f.groups),
    };
  }

  /** 'Banks' | 'NBFC' when the stock is scored on a lender list, else null. */
  function lenderGroup(data) {
    const g = data && data.summary && data.summary.sector_group;
    return g === 'Banks' || g === 'NBFC' ? g : null;
  }

  /** Effective bars for one stock: its lender group block or the Normal list. */
  function barsFor(T, group) {
    const G = group ? T.groups[group] : null;
    return {
      group: group || null,
      peMax: G ? G.pe_max : T.peMax,
      roeMin: G ? G.roe_min : T.roeMin,
      roaMin: G ? G.roa_min : null,
      gnpaMax: G ? G.gross_npa_max : null,
      nnpaMax: G ? G.net_npa_max : null,
      npTtmMinCr: G ? G.net_profit_ttm_min_cr : T.pointers.ttm_net_profit_min_cr,
    };
  }

  function kv(k, v) { return el('div', { class: 'px-kv' }, [el('span', { text: k }), el('span', { text: v })]); }

  /**
   * build(opts) -> HTMLElement (#px-card)
   *   ticker     plain symbol for the title
   *   data       stock payload, or null while loading / on error
   *   error      {status, message} when data is null and the fetch failed
   *   boot, settings
   *   held       {qty, invested} or null
   *   actions    {note, size, opportunity, playAreaAdd, playAreaRemove, retry} — callbacks; missing ones hide the button
   *   extra      an element appended after the technical box (Screener's page rules)
   *   compact    true in the drawer: one column, no pools chips
   */
  function build(opts) {
    const T = thresholds(opts.boot, opts.settings);
    const data = opts.data || null;
    const A = opts.actions || {};
    const head = el('div', { class: 'px-card-head' }, [
      el('span', { class: 'px-card-title' }, [U.logo(18), 'Plutus · ' + (opts.ticker || '')]),
    ]);
    const body = el('div', { class: 'px-card-body' + (opts.compact ? ' px-card-compact' : '') });
    const card = el('div', { id: 'px-card' }, [head, body]);

    if (!data) {
      const err = opts.error;
      head.appendChild(el('span', { class: 'px-card-meta', text: err && err.status === 404 ? 'not in the Plutus universe' : (err ? err.message : 'loading…') }));
      head.appendChild(el('span', { class: 'px-card-spacer' }));
      const actions = el('div', { class: 'px-card-actions' });
      if (err && err.status === 404 && A.playAreaAdd) actions.appendChild(el('button', { class: 'px-btn px-btn-primary', text: '⚡ Add to PlayArea', onclick: () => A.playAreaAdd() }));
      if (A.retry) actions.appendChild(el('button', { class: 'px-btn', text: '↻', title: 'Retry', onclick: () => A.retry() }));
      head.appendChild(actions);
      if (opts.extra) body.appendChild(opts.extra);
      return card;
    }

    const sm = data.summary || {}, snap = data.snapshot || {}, fund = data.fundamentals || {};
    const results = data.scan_results || [];
    const fundaRes = results.find((r) => r.strategy_id === 'fundamental_screener');
    const ms = (fundaRes && fundaRes.metrics_snapshot) || {};
    const checks = ms.checks || [];
    const points = sm.funda_points, status = sm.best_status;
    const held = opts.held || null;
    const cur = (data.market || sm.market) === 'US' ? '$' : '₹';

    // header chips
    if (sm.cap) head.appendChild(el('span', { class: 'px-chip px-chip-cap', text: sm.cap + ' cap' }));
    if (status && SIGNAL_CHIP[status]) head.appendChild(el('span', { class: 'px-chip ' + SIGNAL_CHIP[status][1], text: SIGNAL_CHIP[status][0] }));
    else head.appendChild(el('span', { class: 'px-chip px-chip-none', text: 'no technical signal' }));
    if (status === 'BUY_ZONE' && points != null && points >= 8) head.appendChild(el('span', { class: 'px-chip px-chip-prime', text: 'PRIME' }));
    if (held) head.appendChild(el('span', { class: 'px-chip px-chip-held', text: 'HELD ' + held.qty + ' @ ' + cur + U.fmt(held.invested / Math.max(1, Number(held.qty) || 1), 0) }));
    if (!opts.compact) (sm.pools || []).forEach((p) => head.appendChild(el('span', { class: 'px-chip px-chip-none', text: p })));
    head.appendChild(el('span', { class: 'px-card-meta', text: 'snapshot ' + (data.snapshot_date || '—') + (fund.quarter_label ? ' · Q ' + fund.quarter_label : '') }));
    head.appendChild(el('span', { class: 'px-card-spacer' }));
    const inPlay = (sm.pools || []).includes('PlayArea');
    const actions = el('div', { class: 'px-card-actions' });
    if (A.note) actions.appendChild(el('button', { class: 'px-btn', text: '✎ Note', onclick: () => A.note(data) }));
    if (A.size) actions.appendChild(el('button', { class: 'px-btn', text: '⚖ Size', title: 'Position sizer: risk-based qty, cap-allocation check, then opportunity or plan', onclick: () => A.size(data) }));
    if (A.opportunity) actions.appendChild(el('button', { class: 'px-btn', text: '＋ Opportunity', onclick: () => A.opportunity(data) }));
    if (A.playAreaAdd && A.playAreaRemove) actions.appendChild(el('button', { class: 'px-btn', text: inPlay ? '⚡ Remove from PlayArea' : '⚡ PlayArea', onclick: () => (inPlay ? A.playAreaRemove(data) : A.playAreaAdd(data)) }));
    if (actions.children.length) head.appendChild(actions);

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
    const tech = el('div', { class: 'px-box' }, [el('div', { class: 'px-box-title' }, ['Technical read', el('span', { class: 'px-muted', text: close != null ? cur + U.fmt(close, 2) : '' })])]);
    if (dma != null && below != null) {
      const MIN = -20, MAX = 25, x = Math.max(0, Math.min(100, ((Math.max(MIN, Math.min(MAX, below)) - MIN) / (MAX - MIN)) * 100));
      tech.appendChild(kv('200 DMA', cur + U.fmt(dma, 0) + ' · ' + (below >= 0 ? below.toFixed(1) + '% below' : Math.abs(below).toFixed(1) + '% above')));
      tech.appendChild(el('div', { class: 'px-gauge' }, [el('i', { style: 'left:' + x.toFixed(1) + '%' })]));
      tech.appendChild(el('div', { class: 'px-gauge-labels', html: '<span>premium</span><span>' + T.oppZone + '% opp</span><span>' + T.buyZone + '% buy</span>' }));
      tech.appendChild(kv('Entry levels', cur + U.fmt(dma * (1 - T.oppZone / 100), 0) + ' / ' + cur + U.fmt(dma * (1 - T.buyZone / 100), 0)));
    } else tech.appendChild(el('div', { class: 'px-muted', text: 'No 200 DMA yet.' }));
    if (athFall != null) tech.appendChild(kv('Off ATH (' + (sm.cap || '?') + ' rule > ' + capRule + '%)', athFall.toFixed(1) + '% ' + (athFall > capRule ? '✓' : '✗') + ' · ATH ' + cur + U.fmt(snap.ath, 0)));
    if (snap.high_52w) tech.appendChild(kv('52-week', cur + U.fmt(snap.low_52w, 0) + ' – ' + cur + U.fmt(snap.high_52w, 0) + ' · ' + U.fmtPct(snap.distance_from_52w_high_pct) + ' off high'));
    if (snap.has_valid_20pct_rally != null) tech.appendChild(kv('20% rally', snap.has_valid_20pct_rally ? 'valid · ' + U.fmtPct(snap.last_rally_pct) + ' · ' + (snap.days_since_last_rally || 0) + 'd ago' : 'none'));
    if (snap.pe_current) tech.appendChild(kv('PE / PB' + (cur === '₹' ? ' (Screener weekly)' : ''), U.fmt(snap.pe_current, 1) + ' / ' + U.fmt(snap.pb_current, 2)));
    body.appendChild(tech);

    // box 3: valuation vs history (display only — nothing here is a scan rule)
    const val = valuationBox(data, T, cur);
    if (val) body.appendChild(val);

    if (opts.extra) body.appendChild(opts.extra);
    return card;
  }

  /** Current P/E against its 3Y / 5Y / 10Y medians and the 10Y range, plus P/S and Mcap/EBITDA. */
  function valuationBox(data, T, cur) {
    const snap = data.snapshot || {}, fund = data.fundamentals || {}, d = data.derived || {};
    const V = Object.assign({ ps_max: 3, mcap_ebitda_max: 15, pe_vs_median_good: 0.9, pe_vs_median_warn: 1.1 },
      Object.fromEntries(Object.entries(((data.thresholds || {}).valuation) || {}).map(([k, v]) => [k, num(v)]).filter(([, v]) => v != null)));
    const pe = num(snap.pe_current);
    const meds = [['3Y', num(fund.pe_median_3y), num(d.pe_vs_median_3y)], ['5Y', num(fund.pe_median_5y), num(d.pe_vs_median_5y)], ['10Y', num(fund.pe_median_10y), num(d.pe_vs_median_10y)]].filter((m) => m[1] != null);
    const low = num(fund.pe_low_10y), high = num(fund.pe_high_10y), pos = num(d.pe_range_position_pct);
    const ps = num(d.ps), me = num(d.mcap_to_ebitda), pb5 = num(d.pb_vs_5y_avg);
    if (!meds.length && low == null && ps == null && me == null) return null;
    const cls = (ratio) => (ratio == null ? '' : ratio <= V.pe_vs_median_good ? 'px-val-good' : ratio <= V.pe_vs_median_warn ? 'px-val-warn' : 'px-val-bad');
    const box = el('div', { class: 'px-box' }, [el('div', { class: 'px-box-title' }, ['Valuation vs history', el('span', { class: 'px-muted', text: pe != null ? 'P/E ' + U.fmt(pe, 1) : '' })])]);
    if (meds.length) {
      const row = el('div', { class: 'px-val-meds' });
      meds.forEach(([label, med, ratio]) => row.appendChild(el('div', { class: 'px-val-med ' + cls(ratio), title: ratio == null ? '' : 'current P/E is ' + Math.round(ratio * 100) + '% of the ' + label + ' median' }, [
        el('span', { class: 'px-val-k', text: label + ' median' }), el('span', { class: 'px-val-v', text: U.fmt(med, 1) }),
        el('span', { class: 'px-val-r', text: ratio == null ? '' : (ratio <= 1 ? '−' : '+') + Math.abs(Math.round((ratio - 1) * 100)) + '%' }),
      ])));
      box.appendChild(row);
    }
    if (low != null && high != null && high > low) {
      box.appendChild(kv('10Y P/E range', U.fmt(low, 1) + ' – ' + U.fmt(high, 1) + (pos == null ? '' : ' · now at ' + Math.round(pos) + '%')));
      const bar = el('div', { class: 'px-range' }, [el('i', { style: 'left:' + (pos == null ? 0 : pos).toFixed(1) + '%' + (pos == null ? ';display:none' : '') })]);
      box.appendChild(bar);
      box.appendChild(el('div', { class: 'px-gauge-labels', html: '<span>10Y low</span><span>10Y high</span>' }));
    }
    if (ps != null) box.appendChild(kv('Market cap / sales' + (ps > V.ps_max ? ' (> ' + V.ps_max + ')' : ''), U.fmt(ps, 2) + (ps > V.ps_max ? ' ✗' : ' ✓')));
    if (me != null) box.appendChild(kv('Market cap / EBITDA' + (me > V.mcap_ebitda_max ? ' (> ' + V.mcap_ebitda_max + ')' : ''), U.fmt(me, 1) + (me > V.mcap_ebitda_max ? ' ✗' : ' ✓')));
    if (pb5 != null) box.appendChild(kv('P/B vs 5Y avg', U.fmt(snap.pb_current, 2) + ' · ' + (pb5 <= 1 ? '−' : '+') + Math.abs(Math.round((pb5 - 1) * 100)) + '%'));
    box.appendChild(el('div', { class: 'px-muted px-val-note', text: 'Medians from Screener’s weekly P/E (quarterly sync). Display only — not part of the score.' }));
    return box;
  }

  root.PlutusCard = { SIGNAL_CHIP, LENDER_DEFAULTS, lenderGroups, thresholds, lenderGroup, barsFor, kv, build };
})(typeof self !== 'undefined' ? self : this);
