/**
 * Plutus Companion — token bridge for the Plutus web app (local dev origin).
 *
 * The web app keeps its signed session token in localStorage under
 * "plutus.auth.v1" (frontend_v2/src/lib/auth.ts). When you sign in there,
 * this script mirrors the token into the extension settings so the
 * TradingView / Screener overlays can call the gated routes (notes,
 * positions, watchlists, PlayArea) without pasting anything.
 *
 * It never reads anything else from the page and never writes to it.
 * The production web-app origin is not matched by the manifest (it differs
 * per deployment); paste the token in the popup there, or add your origin
 * to manifest.json.
 */
(function () {
  'use strict';
  const KEY = 'plutus.auth.v1';

  function readToken() {
    try { return (localStorage.getItem(KEY) || '').trim(); } catch (e) { return ''; }
  }

  function sync() {
    if (!(window.chrome && chrome.runtime && chrome.runtime.id)) return;
    const token = readToken();
    PlutusSettings.get().then(function (s) {
      const patch = {};
      if (token && token !== s.token) patch.token = token;
      if (!token && s.token && s._bridged) patch.token = '';
      if (s.webAppUrl === PlutusSettings.DEFAULTS.webAppUrl && location.origin !== s.webAppUrl) patch.webAppUrl = location.origin;
      if (Object.keys(patch).length) {
        patch._bridged = !!token;
        PlutusSettings.save(patch).catch(function () {});
      }
    }).catch(function () {});
  }

  sync();
  window.addEventListener('storage', function (e) { if (!e || !e.key || e.key === KEY) sync(); });
  window.addEventListener('focus', sync);
  setInterval(sync, 30000);
})();
