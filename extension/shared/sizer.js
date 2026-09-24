/**
 * Plutus Companion — position sizing (math + dialog), shared by the
 * TradingView and Screener content scripts.
 *
 * The math is a line-for-line port of the web app so the extension and the
 * Position Sizer page can never disagree:
 *   sizeByRisk      <- frontend_v2/src/lib/sizing.ts  sizeByRisk
 *   allocation      <- frontend_v2/src/lib/journal.ts planAllocation / allocState
 *   CAP_LIMITS      <- frontend_v2/src/lib/journal.ts CAP_LIMITS (% of capital per stock)
 * Display math only: nothing computed here is stored as a monetary fact; the
 * API receives the raw inputs (entry, stop, qty, risk %) exactly as typed.
 */
(function (root) {
  'use strict';

  const CAP_LIMITS = { Large: 5, Mid: 3, Small: 2, Micro: 1.5 };

  const rupees = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

  /** qty = floor((capital × risk%) ÷ (entry − stop)); every invalid case is named. */
  function sizeByRisk(i) {
    const capital = i.capital, riskPct = i.riskPct, entry = i.entry, stop = i.stop;
    const EMPTY = { problem: null, message: null, riskPerShare: null, stopDistancePct: null, riskBudget: null, qty: 0,
      deployed: 0, deployedPct: null, riskAmount: 0, riskPctOfCapital: null, remainingCapital: null, exceedsCapital: false, maxAffordableQty: null };
    if (capital == null || !(capital > 0)) return Object.assign({}, EMPTY, { problem: 'capital', message: 'Capital must be greater than zero.' });
    if (riskPct == null || !(riskPct > 0)) return Object.assign({}, EMPTY, { problem: 'risk', message: 'Risk per trade must be greater than 0%.' });
    const riskBudget = (capital * riskPct) / 100;
    if (entry == null || !(entry > 0)) return Object.assign({}, EMPTY, { riskBudget, problem: 'entry', message: 'Entry price must be greater than zero.' });
    if (stop == null || !(stop > 0)) return Object.assign({}, EMPTY, { riskBudget, problem: 'stop', message: 'Stop price must be greater than zero.' });
    if (stop >= entry) return Object.assign({}, EMPTY, { riskBudget, problem: 'stop_not_below_entry', message: 'Stop (₹' + stop + ') must be below entry (₹' + entry + ') — a long trade has no risk to size otherwise.' });
    const riskPerShare = entry - stop;
    const stopDistancePct = (riskPerShare / entry) * 100;
    const qty = Math.floor(riskBudget / riskPerShare);
    const maxAffordableQty = Math.floor(capital / entry);
    if (qty <= 0) {
      return Object.assign({}, EMPTY, { riskBudget, riskPerShare, stopDistancePct, maxAffordableQty, problem: 'zero_qty',
        message: 'Risk budget ' + rupees(riskBudget) + ' is smaller than the ' + rupees(riskPerShare) + ' risked per share — widen the risk %, tighten the stop, or skip the trade.' });
    }
    const deployed = qty * entry;
    const riskAmount = qty * riskPerShare;
    return { problem: null, message: null, riskPerShare, stopDistancePct, riskBudget, qty, deployed,
      deployedPct: (deployed / capital) * 100, riskAmount, riskPctOfCapital: (riskAmount / capital) * 100,
      remainingCapital: capital - deployed, exceedsCapital: deployed > capital, maxAffordableQty };
  }

  function allocState(totalPct, cap) {
    if (totalPct == null || !cap || CAP_LIMITS[cap] == null) return null;
    const limit = CAP_LIMITS[cap];
    if (totalPct > limit) return 'over';
    if (totalPct >= limit * 0.8) return 'warn';
    return 'ok';
  }

  /** Existing OPEN value of the symbol + this plan vs the cap-bucket limit. */
  function allocation(p) {
    const capital = p.capital, cap = p.cap, buyPrice = p.entry, qty = p.qty;
    const heldValue = Math.max(0, p.heldValue || 0);
    const addValue = buyPrice != null && qty != null ? buyPrice * qty : null;
    const pct = (v) => (v == null || !capital ? null : (v / capital) * 100);
    const heldPct = pct(heldValue), addPct = pct(addValue);
    const totalPct = heldPct == null ? addPct : addPct == null ? heldPct : heldPct + addPct;
    const limitPct = cap && CAP_LIMITS[cap] != null ? CAP_LIMITS[cap] : null;
    const limitValue = limitPct != null && capital ? (capital * limitPct) / 100 : null;
    const maxQty = limitValue != null && buyPrice ? Math.max(0, Math.floor((limitValue - heldValue) / buyPrice)) : null;
    return { capital, limitPct, limitValue, heldValue, heldPct, addValue, addPct, totalPct,
      state: allocState(totalPct, cap),
      roomValue: limitValue == null ? null : limitValue - heldValue - (addValue || 0),
      maxQty, qtyDelta: maxQty != null && qty != null ? maxQty - qty : null };
  }

  const MATH = { CAP_LIMITS, sizeByRisk, allocState, allocation };

  // ---------------------------------------------------------------------------
  // Dialog (needs PlutusUI + PlutusSymbols; absent in node tests)
  // ---------------------------------------------------------------------------
  /**
   * open({symbol, cap, entry, entryLabel, snapshot, heldValue, settings})
   * snapshot: bootstrap/stock summary fields used for stop/target shortcuts.
   */
  function open(opts) {
    const U = root.PlutusUI, S = root.PlutusSymbols;
    const el = U.el, num = U.num;
    const plain = S.toPlain(opts.symbol);
    const snap = opts.snapshot || {};
    const settings = opts.settings || {};
    let manualQty = false;

    const inp = (attrs) => el('input', Object.assign({ type: 'number', step: '0.05' }, attrs));
    const capital = inp({ step: '1000', placeholder: 'loading…' });
    const risk = inp({ step: '0.25', value: String(settings.sizerRiskPct || 1) });
    const entry = inp({ value: opts.entry != null ? String(opts.entry) : '' });
    const stop = inp({ placeholder: 'required' });
    const target = inp({ placeholder: 'optional' });
    const qty = inp({ step: '1', placeholder: 'auto' });
    const capSel = el('select', {});
    ['', 'Large', 'Mid', 'Small', 'Micro'].forEach((c) => capSel.appendChild(el('option', { value: c, text: c || '— cap —' })));
    capSel.value = opts.cap || '';
    const strategy = el('select', {});
    ['', 'Envelope (200 DMA)', '52-Week Low', '20% Rally', 'Fundamental', 'Other'].forEach((s) => strategy.appendChild(el('option', { value: s, text: s || '— strategy —' })));
    const action = el('select', {});
    ['GTT', 'Buy Now', 'Analyse Now', 'Later'].forEach((s) => action.appendChild(el('option', { value: s, text: s })));

    // shortcut chips for stop / target
    const chipRow = (label, pairs, input) => {
      const row = el('div', { class: 'px-sz-chips' }, [el('span', { class: 'px-muted', text: label })]);
      pairs.filter((p) => p[1] != null && p[1] > 0).forEach(([name, v]) => {
        row.appendChild(el('button', { type: 'button', class: 'px-sz-chip', title: name, text: name + ' ₹' + U.fmt(v, 2), onclick: () => { input.value = String(Math.round(v * 20) / 20); recompute(); } }));
      });
      return row.children.length > 1 ? row : null;
    };
    const e0 = opts.entry;
    const dma = num(snap.dma_200);
    const stopChips = chipRow('Stop:', [
      ['Rally low', num(snap.last_rally_low)], ['52w low', num(snap.low_52w)],
      ['−5%', e0 ? e0 * 0.95 : null], ['−8%', e0 ? e0 * 0.92 : null], ['−10%', e0 ? e0 * 0.90 : null],
    ], stop);
    const targetChips = chipRow('Target:', [
      ['200 DMA', dma && e0 && dma > e0 ? dma : null], ['52w high', num(snap.high_52w)], ['ATH', num(snap.ath)],
      ['+20%', e0 ? e0 * 1.2 : null],
    ], target);

    const out = el('div', { class: 'px-sz-out' });
    const maxBtn = el('button', { type: 'button', class: 'px-sz-chip', style: 'display:none' });

    function values() {
      return { capital: num(capital.value), riskPct: num(risk.value), entry: num(entry.value), stop: num(stop.value), target: num(target.value), cap: capSel.value || null };
    }
    function currentQty(v, s) {
      const q = manualQty ? num(qty.value) : s.qty;
      return q != null && q > 0 ? Math.floor(q) : 0;
    }
    function recompute() {
      const v = values();
      const s = sizeByRisk(v);
      if (!manualQty) qty.value = s.qty > 0 ? String(s.qty) : '';
      const q = currentQty(v, s);
      out.innerHTML = '';
      if (s.problem && !(manualQty && q > 0 && s.problem === 'zero_qty')) {
        out.appendChild(el('div', { class: 'px-sz-problem', text: s.message }));
        maxBtn.style.display = 'none';
        return;
      }
      const riskAmt = v.entry != null && v.stop != null && v.stop < v.entry ? (v.entry - v.stop) * q : null;
      const deployed = v.entry != null ? v.entry * q : null;
      const pctOf = (x) => (x == null || !v.capital ? '—' : (x / v.capital * 100).toFixed(2) + '%');
      const rows = [
        ['Quantity', q.toLocaleString('en-IN') + (manualQty ? ' (manual)' : '')],
        ['Deployed', deployed == null ? '—' : rupees(deployed) + ' · ' + pctOf(deployed)],
        ['Risk at stop', riskAmt == null ? '—' : rupees(riskAmt) + ' · ' + pctOf(riskAmt)],
        ['Stop distance', s.stopDistancePct == null ? '—' : s.stopDistancePct.toFixed(2) + '%'],
      ];
      if (v.target != null && v.entry != null && v.stop != null && v.target > v.entry && v.stop < v.entry) {
        const r = (v.target - v.entry) / (v.entry - v.stop);
        rows.push(['Reward at target', rupees((v.target - v.entry) * q) + ' · ' + r.toFixed(2) + 'R · +' + ((v.target / v.entry - 1) * 100).toFixed(1) + '%']);
      }
      const a = allocation({ capital: v.capital, cap: v.cap, entry: v.entry, qty: q, heldValue: opts.heldValue || 0 });
      rows.forEach(([k, val]) => out.appendChild(el('div', { class: 'px-sz-kv' }, [el('span', { text: k }), el('b', { text: val })])));
      if (a.limitPct != null) {
        const state = a.state || 'ok';
        const txt = v.cap + ' limit ' + a.limitPct + '% of capital · ' + (a.heldValue ? 'held ' + rupees(a.heldValue) + ' + ' : '') + 'this ' + pctOf(a.addValue) + ' → ' + (a.totalPct == null ? '—' : a.totalPct.toFixed(2) + '%');
        out.appendChild(el('div', { class: 'px-sz-alloc px-sz-' + state, text: (state === 'over' ? '✗ Over the limit — ' : state === 'warn' ? '! Near the limit — ' : '✓ Within the limit — ') + txt }));
        if (a.maxQty === 0 && a.qtyDelta != null && a.qtyDelta < 0) {
          out.appendChild(el('div', { class: 'px-sz-problem', text: 'No room to add: the open position alone already uses the ' + v.cap + ' limit of ' + rupees(a.limitValue) + '.' }));
          maxBtn.style.display = 'none';
        } else if (a.maxQty != null && a.qtyDelta != null && a.qtyDelta < 0) {
          maxBtn.style.display = '';
          maxBtn.textContent = 'Use max qty within limit: ' + a.maxQty.toLocaleString('en-IN');
          maxBtn.onclick = () => { manualQty = true; qty.value = String(a.maxQty); recompute(); };
        } else maxBtn.style.display = 'none';
      } else {
        out.appendChild(el('div', { class: 'px-sz-alloc', text: 'Pick a cap bucket to check the per-stock allocation limit.' }));
        maxBtn.style.display = 'none';
      }
      if (s.exceedsCapital) out.appendChild(el('div', { class: 'px-sz-problem', text: 'Deployed amount exceeds capital.' }));
    }
    [capital, risk, entry, stop, target].forEach((n) => n.addEventListener('input', () => { recompute(); }));
    capSel.addEventListener('change', recompute);
    qty.addEventListener('input', () => { manualQty = qty.value.trim() !== ''; recompute(); });

    root.PlutusUI.send({ type: 'journal.settings' }).then((r) => {
      const c = num(r && r.settings && r.settings.capital);
      if (c && !capital.value) { capital.value = String(c); recompute(); }
    }).catch(() => { capital.placeholder = 'capital (₹)'; });

    const grid = (pairs) => el('div', { class: 'px-sz-grid' }, pairs.map(([l, n]) => el('label', {}, [l, n])));
    const body = el('div', { class: 'px-sz' }, [
      grid([['Capital (₹)', capital], ['Risk % of capital', risk], ['Entry (₹)' + (opts.entryLabel ? ' · ' + opts.entryLabel : ''), entry], ['Stop (₹)', stop]]),
      stopChips,
      grid([['Target (₹)', target], ['Qty', qty], ['Cap bucket', capSel], ['Strategy', strategy]]),
      targetChips,
      out, maxBtn,
      grid([['Action', action]]),
    ]);

    function payloadCommon() {
      const v = values();
      const s = sizeByRisk(v);
      const q = currentQty(v, s);
      if (!(v.entry > 0)) throw new Error('Entry is required');
      if (!(v.stop > 0) || v.stop >= v.entry) throw new Error('Stop must be above zero and below entry');
      if (!(q > 0)) throw new Error('Quantity is zero — adjust risk % or stop');
      return { v, q, riskAmt: (v.entry - v.stop) * q };
    }

    recompute();
    return U.dialog({
      title: 'Size a position · ' + plain,
      body,
      actionLabel: 'Add opportunity',
      extraActions: [{
        label: 'Save as plan',
        onClick: async () => {
          const { v, q } = payloadCommon();
          if (!(v.capital > 0) || !(v.riskPct > 0)) throw new Error('Capital and risk % are required for a plan');
          await U.send({ type: 'sizing.save', body: {
            symbol: plain, cap_bucket: v.cap, capital: capital.value, risk_pct: risk.value, entry: entry.value, stop: stop.value, qty: q,
            targets: v.target ? [{ price: target.value }] : [],
            notes: 'Sized from the Plutus extension',
          } });
          U.toast('Plan saved to the Plutus Position Sizer', 'success');
        },
      }],
      onConfirm: async () => {
        const { v, q, riskAmt } = payloadCommon();
        await U.send({ type: 'opportunity.create', body: {
          symbol: opts.symbol, opp_date: new Date().toISOString().slice(0, 10),
          buy_price: entry.value, limit_price: action.value === 'GTT' ? entry.value : null, qty: q,
          stop_price: stop.value, target_price: target.value || null, strategy: strategy.value || null,
          action_filter: action.value, cap_bucket: v.cap, status: 'ACTIVE',
          notes: 'Sized: risk ' + rupees(riskAmt) + ' (' + (v.capital ? (riskAmt / v.capital * 100).toFixed(2) : '?') + '% of capital), stop ' + ((1 - v.stop / v.entry) * 100).toFixed(1) + '% below entry',
        } });
        U.toast('Opportunity added: ' + plain + ' × ' + q, 'success');
      },
    });
  }

  root.PlutusSizer = Object.assign({ open }, MATH);
  if (typeof module !== 'undefined' && module.exports) module.exports = MATH;
})(typeof self !== 'undefined' ? self : this);
