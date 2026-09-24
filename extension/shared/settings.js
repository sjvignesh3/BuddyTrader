/**
 * Plutus Companion — settings (chrome.storage.local) with defaults.
 *
 * Everything user-tunable lives under ONE key (`plutus_settings`) so the
 * popup can save it atomically and content scripts can react to a single
 * onChanged event. Thresholds default to the values the Plutus scan engine
 * runs with; the bootstrap payload carries the live server defaults and the
 * content scripts prefer those unless the user has overridden a field
 * (`thresholdOverrides`).
 */
(function (root) {
  'use strict';

  const KEY = 'plutus_settings';

  const DEFAULTS = Object.freeze({
    apiUrl: 'http://127.0.0.1:8787',
    webAppUrl: 'http://localhost:5173',
    token: '',                       // X-Plutus-Auth owner/viewer token (optional)
    adminToken: '',                  // X-Plutus-Admin-Token for sync triggers (optional)

    // TradingView panel
    tvEnabled: true,
    tvPanelOpen: true,
    tvSpaceKeyNavigates: false,      // Space advances to the next stock (steals TradingView's shortcut)
    tvFocusMode: true,               // hide TradingView upsell dialogs
    tvShowChips: true,               // signal / score / held chips on rows
    tvSort: 'default',               // default | conviction | dma | ath | score | name

    // Screener.in
    scrEnabled: true,
    scrAutoConsolidated: true,
    scrHighlightTables: true,
    scrPlutusCard: true,
    scrPageRules: true,              // the on-page rule checks (TTM vs peak, OPM trend, ...)

    // Screener tile colouring thresholds the scan engine does not own.
    // (PE / ROCE / ROE / D-E / pledge / ATH-fall come from the server.)
    tiles: {
      high52RedPct: 10,              // within 10 % of the 52w high -> red
      high52YellowPct: 30,           // within 30 % -> yellow, else green
      smaGreenPct: 10,               // >= 10 % below 200 SMA -> green
      athYellowPct: 20,              // > 20 % off ATH -> yellow
      athGreenPct: 30,               // > 30 % off ATH -> green
      publicHoldingMaxPct: 30,
    },

    // Per-field overrides of the server thresholds (blank = use server).
    thresholdOverrides: {},

    cacheTtlMinutes: 720,            // bootstrap cache: 12 h (data changes once a day)
  });

  function merge(base, patch) {
    const out = Object.assign({}, base);
    Object.keys(patch || {}).forEach(function (k) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
        out[k] = Object.assign({}, base[k], v);
      } else if (v !== undefined) {
        out[k] = v;
      }
    });
    return out;
  }

  function storageAvailable() {
    try { return !!(root.chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local); }
    catch (e) { return false; }
  }

  function get() {
    return new Promise(function (resolve) {
      if (!storageAvailable()) return resolve(merge(DEFAULTS, {}));
      try {
        chrome.storage.local.get([KEY], function (data) {
          resolve(merge(DEFAULTS, (data && data[KEY]) || {}));
        });
      } catch (e) { resolve(merge(DEFAULTS, {})); }
    });
  }

  function save(patch) {
    return get().then(function (current) {
      const next = merge(current, patch);
      return new Promise(function (resolve) {
        if (!storageAvailable()) return resolve(next);
        const obj = {}; obj[KEY] = next;
        chrome.storage.local.set(obj, function () { resolve(next); });
      });
    });
  }

  function reset() {
    return new Promise(function (resolve) {
      if (!storageAvailable()) return resolve(merge(DEFAULTS, {}));
      const obj = {}; obj[KEY] = merge(DEFAULTS, {});
      chrome.storage.local.set(obj, function () { resolve(obj[KEY]); });
    });
  }

  /** Fire cb(newSettings) whenever the settings blob changes. Returns unsubscribe. */
  function onChange(cb) {
    if (!storageAvailable() || !chrome.storage.onChanged) return function () {};
    const handler = function (changes, area) {
      if (area === 'local' && changes && changes[KEY]) {
        cb(merge(DEFAULTS, changes[KEY].newValue || {}));
      }
    };
    chrome.storage.onChanged.addListener(handler);
    return function () { try { chrome.storage.onChanged.removeListener(handler); } catch (e) {} };
  }

  root.PlutusSettings = { KEY: KEY, DEFAULTS: DEFAULTS, get: get, save: save, reset: reset, onChange: onChange, merge: merge };
})(typeof self !== 'undefined' ? self : this);
