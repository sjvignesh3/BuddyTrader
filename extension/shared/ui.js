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

  root.PlutusUI = { esc: esc, el: el, num: num, fmt: fmt, fmtPct: fmtPct, fmtCr: fmtCr, toast: toast, dialog: dialog, send: send, contextAlive: contextAlive };
})(typeof self !== 'undefined' ? self : this);
