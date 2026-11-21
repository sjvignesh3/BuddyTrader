/**
 * Plutus Companion — popup: connection, feature toggles, thresholds.
 * Saves everything as one settings blob (shared/settings.js).
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const BOOLS = ['tvEnabled', 'tvShowChips', 'tvFocusMode', 'tvSpaceKeyNavigates', 'tvHeldStrip', 'tvLivePrices', 'tvHoverCard', 'scrEnabled', 'scrAutoConsolidated', 'scrPlutusCard', 'scrHighlightTables', 'scrPageRules', 'scrWalk', 'linkTabs', 'usSitesEnabled'];
  const TEXTS = ['apiUrl', 'webAppUrl', 'token', 'adminToken', 'tvSort', 'tvRegion'];
  const NUMBER_SELECTS = ['tvLiveIntervalSec'];
  const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

  /**
   * A deployed web-app URL needs a host permission before the token bridge can
   * run there. Must be called from the click handler (a user gesture).
   */
  async function ensureBridgePermission(webAppUrl) {
    const info = $('bridgeInfo');
    let origin;
    try { origin = new URL(webAppUrl).origin; } catch (e) { info.textContent = ''; return; }
    if (LOCAL_RE.test(origin)) { info.textContent = 'Local web app: the token is picked up automatically on localhost:5173.'; return; }
    if (!chrome.permissions) return;
    const match = origin + '/*';
    try {
      let ok = await chrome.permissions.contains({ origins: [match] });
      if (!ok) ok = await chrome.permissions.request({ origins: [match] });
      if (ok) {
        const r = await send({ type: 'bridge.register' });
        info.textContent = r && r.registered ? 'Token bridge active on ' + origin + ' — sign in there and the token arrives here.' : 'Could not register the token bridge: ' + ((r && r.reason) || 'unknown');
      } else {
        info.textContent = 'Permission for ' + origin + ' declined — paste the token manually.';
      }
    } catch (e) { info.textContent = e.message; }
  }
  async function showBridgeState(webAppUrl) {
    const info = $('bridgeInfo'), btn = $('allowBridge');
    btn.style.display = 'none';
    let origin;
    try { origin = new URL(webAppUrl).origin; } catch (e) { info.textContent = ''; return; }
    if (LOCAL_RE.test(origin) || !chrome.permissions) { info.textContent = LOCAL_RE.test(origin) ? 'Local web app: the token is picked up automatically.' : ''; return; }
    try {
      const ok = await chrome.permissions.contains({ origins: [origin + '/*'] });
      info.textContent = ok ? 'Token bridge active on ' + origin + ': sign in there and the token arrives here.' : 'The token bridge is not allowed on ' + origin + ' yet.';
      btn.style.display = ok ? 'none' : '';
    } catch (e) { info.textContent = ''; }
  }

  // Chrome can hold back a site the manifest asks for (site access set to "on click" /
  // "specific sites", or a new host after an update): show it and offer to grant.
  const SITES = [
    ['TradingView', ['https://*.tradingview.com/*']],
    ['Screener.in', ['https://*.screener.in/*']],
    ['stockanalysis.com', ['https://*.stockanalysis.com/*', 'https://stockanalysis.com/*']],
    ['roic.ai', ['https://*.roic.ai/*', 'https://roic.ai/*']],
    ['vcpscanner.com', ['https://*.vcpscanner.com/*', 'https://vcpscanner.com/*']],
    ['stockresearch.app', ['https://*.stockresearch.app/*', 'https://stockresearch.app/*']],
  ];
  async function showSiteAccess() {
    const box = $('siteAccess');
    if (!box || !chrome.permissions) return;
    box.innerHTML = '';
    const missing = [];
    for (const [name, origins] of SITES) {
      let ok = false;
      try { ok = await chrome.permissions.contains({ origins }); } catch (e) { ok = false; }
      if (!ok) missing.push(...origins);
      const row = document.createElement('div');
      row.textContent = (ok ? '✓ ' : '✗ ') + name + (ok ? '' : ' — not allowed');
      row.className = ok ? 'ok' : 'bad';
      box.appendChild(row);
    }
    if (missing.length) {
      const b = document.createElement('button');
      b.className = 'btn'; b.textContent = 'Allow the missing sites';
      b.addEventListener('click', async () => {
        try { await chrome.permissions.request({ origins: missing }); } catch (e) { /* user said no */ }
        showSiteAccess();
      });
      box.appendChild(b);
    } else {
      const note = document.createElement('div');
      note.textContent = 'Reload any page that was open before the extension was reloaded.';
      box.appendChild(note);
    }
  }

  /** What the stored token says about itself (`<role>.<exp>.<sig>`), without trusting it. */
  function describeToken(token, apiVerdict) {
    const info = $('tokenInfo'), clear = $('clearToken');
    clear.style.display = token ? '' : 'none';
    if (!token) { info.textContent = 'No token: notes, positions, watchlists and PlayArea are off until you sign in on the web app (or paste one).'; info.className = 'hint'; return; }
    const parts = token.split('.');
    const exp = Number(parts[1]);
    if (parts.length !== 3 || !Number.isFinite(exp)) { info.textContent = 'This is not a Plutus token (expected role.expiry.signature).'; info.className = 'hint bad'; return; }
    const when = new Date(exp * 1000);
    const expired = exp * 1000 < Date.now();
    let text = parts[0] + ' token · ' + (expired ? 'EXPIRED on ' : 'valid until ') + when.toLocaleDateString() + ' ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let bad = expired;
    if (!expired && apiVerdict && apiVerdict.authenticated === false && apiVerdict.required) {
      text += ' — but THIS API rejects it (issued by another Plutus API, e.g. local vs deployed). Sign in on the web app above, or paste a token from it.';
      bad = true;
    } else if (expired) {
      text += ' — sign in on the web app again; the bridge will replace it.';
    }
    info.textContent = text;
    info.className = 'hint' + (bad ? ' bad' : ' ok');
  }
  const OVERRIDES = ['pe_max', 'roce_min', 'roe_min', 'net_debt_to_equity_max', 'pledging_max'];
  const TILES = ['publicHoldingMaxPct', 'high52RedPct', 'high52YellowPct', 'smaGreenPct', 'athGreenPct', 'athYellowPct'];

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('no response'));
        if (res.ok === false) return reject(new Error(res.error || 'failed'));
        resolve(res.data);
      });
    });
  }

  function fill(s) {
    BOOLS.forEach((k) => { $(k).checked = !!s[k]; });
    TEXTS.forEach((k) => { $(k).value = s[k] == null ? '' : s[k]; });
    NUMBER_SELECTS.forEach((k) => { $(k).value = String(s[k]); });
    OVERRIDES.forEach((k) => { const v = (s.thresholdOverrides || {})[k]; $('ov_' + k).value = v == null || v === '' ? '' : v; });
    TILES.forEach((k) => { $('t_' + k).value = (s.tiles || {})[k]; });
    $('cacheTtlMinutes').value = s.cacheTtlMinutes;
    $('sizerRiskPct').value = s.sizerRiskPct;
  }

  function collect() {
    const out = { thresholdOverrides: {}, tiles: {} };
    BOOLS.forEach((k) => { out[k] = $(k).checked; });
    TEXTS.forEach((k) => { out[k] = $(k).value.trim(); });
    NUMBER_SELECTS.forEach((k) => { const v = Number($(k).value); if (Number.isFinite(v)) out[k] = v; });
    OVERRIDES.forEach((k) => { const v = $('ov_' + k).value.trim(); out.thresholdOverrides[k] = v === '' ? '' : Number(v); });
    TILES.forEach((k) => { const v = Number($('t_' + k).value); if (Number.isFinite(v)) out.tiles[k] = v; });
    const ttl = Number($('cacheTtlMinutes').value); if (Number.isFinite(ttl) && ttl > 0) out.cacheTtlMinutes = ttl;
    const risk = Number($('sizerRiskPct').value); if (Number.isFinite(risk) && risk > 0) out.sizerRiskPct = risk;
    return out;
  }

  async function showCacheInfo() {
    chrome.storage.local.get(['plutus_cache_bootstrap'], (d) => {
      const c = d && d.plutus_cache_bootstrap;
      $('cacheInfo').textContent = c && c.data ? 'cached ' + new Date(c.fetchedAt).toLocaleTimeString() + ' · snapshot ' + (c.data.snapshot_date || '—') + ' · ' + (c.data.stocks || []).length + ' stocks' : 'no cached data';
      if (c && c.data && c.data.thresholds) {
        const f = c.data.thresholds.fundamental || {};
        const g = f.groups || {};
        const grp = (name) => { const x = g[name]; return x ? name + ': PE < ' + x.pe_max + ' · ROE > ' + x.roe_min + ' · ROA > ' + x.roa_min + ' · GNPA < ' + x.gross_npa_max + ' · NNPA < ' + x.net_npa_max + ' · TTM NP > ' + x.net_profit_ttm_min_cr + ' Cr' : ''; };
        $('serverDefaults').textContent = 'Server: PE < ' + f.pe_max + ' · ROCE > ' + f.roce_min + ' · ROE > ' + f.roe_min + ' · D/E < ' + f.net_debt_to_equity_max + ' · pledge < ' + f.pledging_max + '% · ATH fall ' + JSON.stringify(c.data.thresholds.ath_fall_pct_by_cap || {}).replace(/"/g, '')
          + [grp('Banks'), grp('NBFC')].filter(Boolean).map((s) => ' | ' + s).join('');
        OVERRIDES.forEach((k) => { if (f[k] != null) $('ov_' + k).placeholder = f[k]; });
      }
    });
  }

  async function test() {
    const conn = $('conn'), out = $('testOut');
    conn.className = 'badge badge-muted'; conn.textContent = 'testing…'; out.className = 'out'; out.textContent = '';
    await PlutusSettings.save(collect());
    try {
      const r = await send({ type: 'ping' });
      const a = r.auth || {};
      const role = a.role || (a.required === false ? 'owner (gate off)' : 'no token');
      const rejected = a.authenticated === false && a.required;
      conn.className = 'badge ' + (rejected ? 'badge-warn' : 'badge-ok');
      conn.textContent = rejected ? (collect().token ? 'api ok · token rejected' : 'api ok · sign in') : 'connected';
      out.className = 'out ' + (rejected && collect().token ? 'bad' : 'ok');
      out.textContent = 'API ' + (r.health && r.health.version ? 'v' + r.health.version : 'ok') + ' in ' + r.latencyMs + ' ms\nauth: ' + (a.error ? a.error : 'required=' + a.required + ' authenticated=' + a.authenticated + ' role=' + role);
      describeToken(collect().token, a);
    } catch (e) {
      conn.className = 'badge badge-bad'; conn.textContent = 'offline';
      out.className = 'out bad'; out.textContent = e.message;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('version').textContent = 'v' + chrome.runtime.getManifest().version;
    const initial = await PlutusSettings.get();
    fill(initial);
    showCacheInfo();
    showBridgeState(initial.webAppUrl);
    describeToken(initial.token, null);
    showSiteAccess();
    test();
    $('token').addEventListener('input', () => describeToken($('token').value.trim(), null));
    $('webAppUrl').addEventListener('change', () => showBridgeState($('webAppUrl').value.trim()));
    $('allowBridge').addEventListener('click', async () => {
      // permissions.request needs the click: ask first, save after
      const perm = ensureBridgePermission($('webAppUrl').value.trim());
      await PlutusSettings.save(collect());
      await perm;
      showBridgeState($('webAppUrl').value.trim());
    });
    $('clearToken').addEventListener('click', async () => {
      $('token').value = '';
      await PlutusSettings.save({ token: '', _bridged: false });
      describeToken('', null);
      test();
    });
    $('save').addEventListener('click', async () => {
      const s = collect();
      // permissions.request must run inside the click: ask before any await
      const perm = ensureBridgePermission(s.webAppUrl);
      await PlutusSettings.save(s);
      await perm;
      $('saved').textContent = 'Saved'; setTimeout(() => { $('saved').textContent = ''; }, 1500);
    });
    $('reset').addEventListener('click', async () => { if (confirm('Reset all Plutus Companion settings (keeps nothing, including the token)?')) { fill(await PlutusSettings.reset()); } });
    $('test').addEventListener('click', test);
    $('refresh').addEventListener('click', async () => {
      $('cacheInfo').textContent = 'refreshing…';
      try { await send({ type: 'cache.clear' }); const b = await send({ type: 'bootstrap', force: true }); $('cacheInfo').textContent = 'refreshed · snapshot ' + (b.snapshot_date || '—') + ' · ' + (b.stocks || []).length + ' stocks'; showCacheInfo(); }
      catch (e) { $('cacheInfo').textContent = e.message; }
    });
  });
})();
