/**
 * Plutus Companion — tiny DOM helpers shared by both content scripts.
 * Toasts, a modal dialog, HTML escaping, number formatting and the
 * message bridge to the service worker.
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  /** Parse a money-string / number from the API ("3500.50" -> 3500.5). */
  function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function fmt(v, nd) {
    const n = num(v);
    if (n == null) return '—';
    return n.toLocaleString('en-IN', { minimumFractionDigits: nd == null ? 1 : nd, maximumFractionDigits: nd == null ? 1 : nd });
  }

  function fmtPct(v, nd) {
    const n = num(v);
    return n == null ? '—' : (n >= 0 ? '' : '') + n.toFixed(nd == null ? 1 : nd) + '%';
  }

  function fmtCr(v) {
    const n = num(v);
    if (n == null) return '—';
    return '₹' + Math.round(n / 1e7).toLocaleString('en-IN') + ' Cr';
  }

  // ---- toasts ---------------------------------------------------------------
  let toastBox = null;
  function toast(msg, kind, ms) {
    try {
      if (!toastBox || !toastBox.isConnected) {
        toastBox = el('div', { id: 'px-toasts' });
        document.body.appendChild(toastBox);
      }
      const t = el('div', { class: 'px-toast px-toast-' + (kind || 'info'), text: msg });
      toastBox.appendChild(t);
      setTimeout(function () { t.classList.add('px-toast-out'); }, (ms || 3200) - 300);
      setTimeout(function () { t.remove(); }, ms || 3200);
    } catch (e) { /* page without body yet */ }
  }

  // ---- modal dialog ----------------------------------------------------------
  /**
   * dialog({title, body: HTMLElement|string, actionLabel, danger, onConfirm})
   * onConfirm(dialogRoot) may return false to keep the dialog open, or a
   * Promise; resolves when closed.
   */
  function dialog(opts) {
    return new Promise(function (resolve) {
      const overlay = el('div', { class: 'px-dialog-overlay' });
      const card = el('div', { class: 'px-dialog' });
      const title = el('div', { class: 'px-dialog-title', text: opts.title || '' });
      const body = el('div', { class: 'px-dialog-body' });
      if (typeof opts.body === 'string') body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
      const err = el('div', { class: 'px-dialog-error' });
      const footer = el('div', { class: 'px-dialog-footer' });
      const cancel = el('button', { class: 'px-btn px-btn-secondary', type: 'button', text: opts.cancelLabel || 'Cancel' });
      const action = el('button', { class: 'px-btn ' + (opts.danger ? 'px-btn-danger' : 'px-btn-primary'), type: 'button', text: opts.actionLabel || 'OK' });
      footer.appendChild(cancel);
      // Secondary actions (e.g. "Save as plan") close the dialog on success, like the primary.
      (opts.extraActions || []).forEach(function (x) {
        const b = el('button', { class: 'px-btn px-btn-secondary', type: 'button', text: x.label });
        b.addEventListener('click', function () {
          err.textContent = ''; b.disabled = true;
          Promise.resolve().then(function () { return x.onClick(card); }).then(function (r) {
            b.disabled = false;
            if (r !== false) close(true);
          }).catch(function (e) { b.disabled = false; err.textContent = (e && e.message) || String(e); });
        });
        footer.appendChild(b);
      });
      if (opts.onConfirm) footer.appendChild(action);
      card.appendChild(title); card.appendChild(body); card.appendChild(err); card.appendChild(footer);
      overlay.appendChild(card);
      (opts.container || document.body).appendChild(overlay);

      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(false); }
        if (e.key === 'Enter' && opts.onConfirm && !(e.target && e.target.tagName === 'TEXTAREA')) { e.stopPropagation(); confirm(); }
      }
      function confirm() {
        err.textContent = '';
        action.disabled = true;
        Promise.resolve().then(function () { return opts.onConfirm(card); }).then(function (r) {
          action.disabled = false;
          if (r === false) return;
          close(true);
        }).catch(function (e) {
          action.disabled = false;
          err.textContent = (e && e.message) || String(e);
        });
      }
      cancel.addEventListener('click', function () { close(false); });
      action.addEventListener('click', confirm);
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', onKey, true);
      setTimeout(function () {
        const first = card.querySelector('input, textarea, select');
        if (first) first.focus();
      }, 0);
    });
  }

  // ---- service-worker bridge ------------------------------------------------
  function contextAlive() {
    try { return !!(root.chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  /** send({type, ...}) -> Promise(response). Rejects with Error on failure. */
  function send(msg, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!contextAlive()) return reject(new Error('extension reloaded — refresh the page'));
      let done = false;
      const timer = setTimeout(function () { if (!done) { done = true; reject(new Error('extension timeout')); } }, timeoutMs || 45000);
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (done) return;
          done = true; clearTimeout(timer);
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error('no response from extension'));
          if (res.ok === false) return reject(Object.assign(new Error(res.error || 'request failed'), { status: res.status }));
          resolve(res.data !== undefined ? res.data : res);
        });
      } catch (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } }
    });
  }

  // ---- brand mark ------------------------------------------------------------
  // Same mark as the web app (frontend_v2/public/favicon.svg): teal gradient
  // tile with a white serif "P". Inline SVG so no web_accessible_resources are
  // needed; each copy gets its own gradient id so several can share a page.
  let logoSeq = 0;
  function logo(size, extraClass) {
    const id = 'px-logo-g' + (++logoSeq);
    const span = document.createElement('span');
    span.className = 'px-logo' + (extraClass ? ' ' + extraClass : '');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="' + size + '" height="' + size + '">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#0f766e"/><stop offset="1" stop-color="#14b8a6"/></linearGradient></defs>' +
      '<rect x="1" y="1" width="62" height="62" rx="14" fill="url(#' + id + ')"/>' +
      '<text x="32" y="33.5" text-anchor="middle" dominant-baseline="central" ' +
      'font-family="Fraunces, Georgia, \'Times New Roman\', serif" font-weight="700" font-size="40" fill="#ffffff">P</text></svg>';
    return span;
  }

  // ---- small line icons (24-unit viewBox, stroke = currentColor) -------------
  const ICONS = {
    note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    external: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
    bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  function icon(name, size) {
    const span = document.createElement('span');
    span.className = 'px-ico';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 24 24" width="' + (size || 14) + '" height="' + (size || 14) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
    return span;
  }

  root.PlutusUI = { esc: esc, el: el, num: num, fmt: fmt, fmtPct: fmtPct, fmtCr: fmtCr, toast: toast, dialog: dialog, send: send, contextAlive: contextAlive, logo: logo, icon: icon };
})(typeof self !== 'undefined' ? self : this);
