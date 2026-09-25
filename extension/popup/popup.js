/**
 * Plutus Companion — popup: connection, feature toggles, thresholds.
 * Saves everything as one settings blob (shared/settings.js).
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const BOOLS = ['tvEnabled', 'tvShowChips', 'tvFocusMode', 'tvSpaceKeyNavigates', 'tvHeldStrip', 'scrEnabled', 'scrAutoConsolidated', 'scrPlutusCard', 'scrHighlightTables', 'scrPageRules', 'scrWalk', 'linkTabs'];
  const TEXTS = ['apiUrl', 'webAppUrl', 'token', 'adminToken', 'tvSort'];
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
    OVERRIDES.forEach((k) => { const v = (s.thresholdOverrides || {})[k]; $('ov_' + k).value = v == null || v === '' ? '' : v; });
    TILES.forEach((k) => { $('t_' + k).value = (s.tiles || {})[k]; });
    $('cacheTtlMinutes').value = s.cacheTtlMinutes;
    $('sizerRiskPct').value = s.sizerRiskPct;
  }

  function collect() {
    const out = { thresholdOverrides: {}, tiles: {} };
    BOOLS.forEach((k) => { out[k] = $(k).checked; });
    TEXTS.forEach((k) => { out[k] = $(k).value.trim(); });
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
      conn.className = 'badge ' + (a.authenticated === false && a.required ? 'badge-warn' : 'badge-ok');
      conn.textContent = a.authenticated === false && a.required ? 'api ok · sign in' : 'connected';
      out.className = 'out ok';
      out.textContent = 'API ' + (r.health && r.health.version ? 'v' + r.health.version : 'ok') + ' in ' + r.latencyMs + ' ms\nauth: ' + (a.error ? a.error : 'required=' + a.required + ' authenticated=' + a.authenticated + ' role=' + role);
    } catch (e) {
      conn.className = 'badge badge-bad'; conn.textContent = 'offline';
      out.className = 'out bad'; out.textContent = e.message;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('version').textContent = 'v' + chrome.runtime.getManifest().version;
    fill(await PlutusSettings.get());
    showCacheInfo();
    test();
    $('save').addEventListener('click', async () => { await PlutusSettings.save(collect()); $('saved').textContent = 'Saved'; setTimeout(() => { $('saved').textContent = ''; }, 1500); });
    $('reset').addEventListener('click', async () => { if (confirm('Reset all Plutus Companion settings (keeps nothing, including the token)?')) { fill(await PlutusSettings.reset()); } });
    $('test').addEventListener('click', test);
    $('refresh').addEventListener('click', async () => {
      $('cacheInfo').textContent = 'refreshing…';
      try { await send({ type: 'cache.clear' }); const b = await send({ type: 'bootstrap', force: true }); $('cacheInfo').textContent = 'refreshed · snapshot ' + (b.snapshot_date || '—') + ' · ' + (b.stocks || []).length + ' stocks'; showCacheInfo(); }
      catch (e) { $('cacheInfo').textContent = e.message; }
    });
  });
})();
