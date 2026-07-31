import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';
import { getScreenerRules, getScreenerAuthStatus, runScreenerStream, getScreenerCacheInfo } from '../services/api';

// ── localStorage keys ─────────────────────────────────────────────────────
const STORAGE_KEY = 'buddy-screener-rules';
const STORAGE_POOL_KEY = 'buddy-screener-pool';
// Bump this version whenever DEFAULT_SCREENER_RULES change structurally
// (rules added/removed). Triggers auto-reset of stale localStorage.
const RULES_VERSION = '2'; // v2: removed ath_match_quarters, added net_debt_to_equity
const STORAGE_VERSION_KEY = 'buddy-screener-rules-version';

// ── Category metadata for grouping ────────────────────────────────────────
const CATEGORY_META = {
  ath:       { label: 'Fundamental ATH Filters',  icon: '📊', color: '#58a6ff' },
  valuation: { label: 'Valuation Filters',        icon: '💰', color: '#d29922' },
  quality:   { label: 'Quality Filters',           icon: '✅', color: '#3fb950' },
  promoter:  { label: 'Promoter Filters',          icon: '👔', color: '#bc8cff' },
};

const POOL_TABS = [
  { code: 'F40',      label: 'F40',   icon: '🏛️' },
  { code: 'E40',      label: 'E40',   icon: '🚀' },
  { code: 'S200',     label: 'S200',  icon: '📈' },
  { code: 'PlayArea', label: 'Play',  icon: '🎯' },
];

// ── Helpers ────────────────────────────────────────────────────────────────
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function saveRulesToStorage(rules) {
  try {
    const serializable = rules.map(r => ({
      id: r.id,
      enabled: r.enabled,
      params: Object.fromEntries(
        Object.entries(r.params || {}).map(([k, v]) => [k, v.value ?? v.default])
      ),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
    localStorage.setItem(STORAGE_VERSION_KEY, RULES_VERSION);
  } catch (e) { /* ignore */ }
}

function loadRulesFromStorage() {
  try {
    // Version guard: if rules schema changed, drop stale localStorage
    const storedVersion = localStorage.getItem(STORAGE_VERSION_KEY);
    if (storedVersion !== RULES_VERSION) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(STORAGE_VERSION_KEY, RULES_VERSION);
      return null;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function mergeStoredRules(defaults, stored) {
  if (!stored) return defaults;
  const storedMap = {};
  stored.forEach(s => { storedMap[s.id] = s; });

  return defaults.map(rule => {
    const override = storedMap[rule.id];
    if (!override) return rule;

    const merged = deepClone(rule);
    merged.enabled = override.enabled;

    for (const [pk, pv] of Object.entries(override.params || {})) {
      if (merged.params[pk]) {
        merged.params[pk].value = pv;
      }
    }
    return merged;
  });
}

function validateParam(paramDef, rawValue) {
  const type = paramDef.type;
  const val = type === 'int' ? parseInt(rawValue, 10) : parseFloat(rawValue);
  if (isNaN(val)) return { valid: false, error: 'Must be a number' };
  if (paramDef.min != null && val < paramDef.min) return { valid: false, error: `Min: ${paramDef.min}` };
  if (paramDef.max != null && val > paramDef.max) return { valid: false, error: `Max: ${paramDef.max}` };
  return { valid: true, value: val };
}

// ═══════════════════════════════════════════════════════════════════════════
//  COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
export default function ScreenerPage() {
  const { theme } = useTheme();

  // State
  const [rules, setRules] = useState([]);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [activePool, setActivePool] = useState(
    () => localStorage.getItem(STORAGE_POOL_KEY) || 'F40'
  );
  const [playAreaSymbols, setPlayAreaSymbols] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [error, setError] = useState(null);

  // ── Streaming progress state ────────────────────────────────────────────
  const [progressManifest, setProgressManifest] = useState(null);   // { total_symbols, cache_hits, internet_fetches, throttle_active, estimated_seconds }
  const [progressLog, setProgressLog] = useState([]);               // [{symbol, from_cache, status}] in order
  const [throttleCountdown, setThrottleCountdown] = useState(0);    // seconds remaining in current throttle wait
  const [nextSymbol, setNextSymbol] = useState(null);               // next symbol queued after throttle
  const [internetFetchesDone, setInternetFetchesDone] = useState(0);
  const [validationErrors, setValidationErrors] = useState({});
  const [authStatus, setAuthStatus] = useState(null);
  const [copied, setCopied] = useState(false);
  const [sortCol, setSortCol] = useState('passed_count');
  const [sortAsc, setSortAsc] = useState(false);
  const [expandedRow, setExpandedRow] = useState(null);
  const [filterMode, setFilterMode] = useState('all'); // all | passed | failed
  const [forceRefresh, setForceRefresh] = useState(false); // bypass persistent cache
  const [cacheInfo, setCacheInfo] = useState(null);        // {total_symbols, symbols[]}
  const [showCachePanel, setShowCachePanel] = useState(false);

  const resultsRef = useRef(null);

  // ── Load default rules from API + merge with localStorage ──────────────
  useEffect(() => {
    getScreenerRules()
      .then(data => {
        const defaults = data.rules || [];
        const stored = loadRulesFromStorage();
        const merged = mergeStoredRules(defaults, stored);
        setRules(merged);
        setRulesLoaded(true);
        if (data.auth_status) setAuthStatus(data.auth_status);
      })
      .catch(err => {
        setError('Failed to load screener rules: ' + err.message);
      });
  }, []);

  // ── Poll auth status every 3s while login is pending ──────────────────
  useEffect(() => {
    const isPending = !authStatus || authStatus.mode === 'login_pending';
    if (!isPending) return; // already resolved — no polling needed

    const intervalId = setInterval(() => {
      getScreenerAuthStatus()
        .then(status => {
          setAuthStatus(status);
          if (status.mode !== 'login_pending') clearInterval(intervalId);
        })
        .catch(() => {}); // silent — don't replace banner with a fetch error
    }, 3000);

    return () => clearInterval(intervalId);
  }, [authStatus]);

  // Update auth status from scan results
  useEffect(() => {
    if (scanResult?.auth_status) {
      setAuthStatus(scanResult.auth_status);
    }
  }, [scanResult]);

  // ── Persist rules to localStorage on change ────────────────────────────
  useEffect(() => {
    if (rulesLoaded && rules.length > 0) {
      saveRulesToStorage(rules);
    }
  }, [rules, rulesLoaded]);

  // Persist pool selection
  useEffect(() => {
    localStorage.setItem(STORAGE_POOL_KEY, activePool);
  }, [activePool]);

  // ── Rule mutation helpers ──────────────────────────────────────────────
  const toggleRule = useCallback((ruleId) => {
    setRules(prev => prev.map(r =>
      r.id === ruleId ? { ...r, enabled: !r.enabled } : r
    ));
  }, []);

  const updateParam = useCallback((ruleId, paramKey, rawValue) => {
    setRules(prev => prev.map(r => {
      if (r.id !== ruleId) return r;
      const newRule = deepClone(r);
      const paramDef = newRule.params[paramKey];
      if (!paramDef) return r;

      const validation = validateParam(paramDef, rawValue);
      if (validation.valid) {
        paramDef.value = validation.value;
        setValidationErrors(ve => {
          const next = { ...ve };
          delete next[`${ruleId}.${paramKey}`];
          return next;
        });
      } else {
        paramDef.value = rawValue; // keep raw for display
        setValidationErrors(ve => ({
          ...ve,
          [`${ruleId}.${paramKey}`]: validation.error,
        }));
      }
      return newRule;
    }));
  }, []);

  const resetToDefaults = useCallback(() => {
    getScreenerRules()
      .then(data => {
        setRules(data.rules || []);
        setValidationErrors({});
        localStorage.removeItem(STORAGE_KEY);
      })
      .catch(() => {});
  }, []);

  const handleToggleCachePanel = useCallback(() => {
    if (!showCachePanel) {
      getScreenerCacheInfo()
        .then(info => setCacheInfo(info))
        .catch(() => setCacheInfo(null));
    }
    setShowCachePanel(p => !p);
  }, [showCachePanel]);

  // ── Run screener (streaming) ───────────────────────────────────────────
  const handleRun = async () => {
    // Validate all params before running
    const errors = {};
    rules.forEach(r => {
      if (!r.enabled) return;
      Object.entries(r.params || {}).forEach(([pk, pv]) => {
        const val = pv.value ?? pv.default;
        const v = validateParam(pv, val);
        if (!v.valid) errors[`${r.id}.${pk}`] = v.error;
      });
    });
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }

    // Reset all progress state
    setScanning(true);
    setError(null);
    setScanResult(null);
    setExpandedRow(null);
    setFilterMode('all');
    setProgressManifest(null);
    setProgressLog([]);
    setThrottleCountdown(0);
    setNextSymbol(null);
    setInternetFetchesDone(0);

    try {
      const symbolList = activePool === 'PlayArea' && playAreaSymbols.trim()
        ? playAreaSymbols.split(',').map(s => s.trim()).filter(Boolean)
        : null;

      const result = await runScreenerStream(
        activePool,
        rules,
        symbolList,
        forceRefresh,
        (event) => {
          // Handle each SSE event from the backend
          switch (event.type) {
            case 'manifest':
              setProgressManifest(event);
              break;

            case 'progress':
              // Add to progress log (cap at last 60 entries to avoid DOM bloat)
              setProgressLog(prev => {
                const entry = {
                  symbol: event.symbol,
                  from_cache: event.from_cache,
                  status: event.status,   // cache_hit | fetching | fetched
                };
                return [...prev.slice(-59), entry];
              });
              if (!event.from_cache) {
                setInternetFetchesDone(event.internet_fetches_done ?? 0);
              }
              // Reset countdown when a new fetch starts
              if (event.status === 'fetching') {
                setThrottleCountdown(0);
                setNextSymbol(null);
              }
              break;

            case 'throttle_tick':
              setThrottleCountdown(event.throttle_wait_seconds ?? 0);
              setInternetFetchesDone(event.internet_fetches_done ?? 0);
              setNextSymbol(event.next_symbol ?? null);
              break;

            case 'complete':
              // Will be handled after the stream resolves
              break;

            case 'error':
              setError(event.message || 'Unknown streaming error');
              break;

            default:
              break;
          }
        },
      );

      // `result` is the final "complete" event
      setScanResult(result);

      // Scroll to results
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 200);
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
      setThrottleCountdown(0);
      setNextSymbol(null);
    }
  };

  // ── Grouping rules by category ────────────────────────────────────────
  const groupedRules = {};
  rules.forEach(r => {
    const cat = r.category || 'other';
    if (!groupedRules[cat]) groupedRules[cat] = [];
    groupedRules[cat].push(r);
  });

  // ── Filtered + sorted results ──────────────────────────────────────────
  const getFilteredResults = () => {
    if (!scanResult?.results) return [];
    let data = [...scanResult.results];
    if (filterMode === 'passed') data = data.filter(r => r.all_passed);
    if (filterMode === 'failed') data = data.filter(r => !r.all_passed && !r.error);
    return data;
  };

  const getSortedResults = () => {
    const data = getFilteredResults();
    return data.sort((a, b) => {
      const va = a[sortCol] ?? (sortAsc ? Infinity : -Infinity);
      const vb = b[sortCol] ?? (sortAsc ? Infinity : -Infinity);
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      if (typeof va === 'boolean') return sortAsc ? (va ? -1 : 1) : (va ? 1 : -1);
      return sortAsc ? va - vb : vb - va;
    });
  };

  const sortedResults = getSortedResults();

  // ── Copy symbol list ──────────────────────────────────────────────────
  const getPassedSymbols = () => {
    if (!scanResult?.results) return '';
    return scanResult.results
      .filter(r => r.all_passed)
      .map(r => r.symbol)
      .join(', ');
  };

  const handleCopy = () => {
    const list = filterMode === 'all' ? getPassedSymbols()
      : sortedResults.map(r => r.symbol).join(', ');
    navigator.clipboard.writeText(list).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  // ── Sort handler ──────────────────────────────────────────────────────
  const handleSort = (col) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(col === 'symbol'); }
  };

  // ── Styles ────────────────────────────────────────────────────────────
  const monoStyle = {
    fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
    fontSize: '11.5px',
  };

  const inputStyle = {
    padding: '5px 8px',
    borderRadius: '5px',
    border: `1px solid ${theme.border}`,
    fontSize: '12px',
    background: theme.bgInput,
    color: theme.text,
    outline: 'none',
    width: '72px',
    textAlign: 'right',
    ...monoStyle,
  };

  const getCapStyle = (cap) => {
    const lower = (cap || '').toLowerCase();
    if (lower.includes('large')) return { bg: theme.badge.large + '15', color: theme.badge.large, text: 'LRG' };
    if (lower.includes('mid'))   return { bg: theme.badge.mid   + '15', color: theme.badge.mid,   text: 'MID' };
    if (lower.includes('small')) return { bg: theme.badge.small + '15', color: theme.badge.small, text: 'SML' };
    return { bg: theme.bgTertiary, color: theme.textTertiary, text: cap || '—' };
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════════════
  return (
    <div style={{ animation: 'fadeIn 0.25s ease' }}>

      {/* ── Pool Tabs + Run Button ──────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'stretch',
        padding: '0 24px',
        background: theme.bgSecondary,
        borderBottom: `1px solid ${theme.border}`,
      }}>
        {POOL_TABS.map(tab => {
          const isActive = activePool === tab.code;
          return (
            <button
              key={tab.code}
              onClick={() => { setActivePool(tab.code); setScanResult(null); }}
              style={{
                padding: '12px 18px 10px',
                border: 'none',
                borderBottom: isActive ? `2px solid ${theme.accent}` : '2px solid transparent',
                background: 'transparent',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '6px',
                transition: 'all 0.15s',
                minWidth: '80px', justifyContent: 'center',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = theme.bgHover; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ fontSize: '14px' }}>{tab.icon}</span>
              <span style={{
                fontSize: '13px',
                fontWeight: isActive ? 700 : 500,
                color: isActive ? theme.text : theme.textSecondary,
              }}>
                {tab.label}
              </span>
            </button>
          );
        })}

        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', padding: '0 4px' }}>
          {activePool === 'PlayArea' && (
            <input
              type="text"
              placeholder="RELIANCE, TCS, INFY..."
              value={playAreaSymbols}
              onChange={e => setPlayAreaSymbols(e.target.value)}
              style={{
                padding: '7px 12px', borderRadius: '6px',
                border: `1px solid ${theme.border}`, fontSize: '12px',
                background: theme.bgInput, color: theme.text,
                outline: 'none', width: '240px',
              }}
            />
          )}

          {/* ── Cache Info button ─────────────────────────────────── */}
          <button
            onClick={handleToggleCachePanel}
            title="View persistent cache status"
            style={{
              padding: '6px 10px', borderRadius: '6px',
              border: `1px solid ${showCachePanel ? theme.accent : theme.border}`,
              background: showCachePanel ? theme.accentLight : theme.bgTertiary,
              color: showCachePanel ? theme.accent : theme.textSecondary,
              fontSize: '11px', fontWeight: 600, cursor: 'pointer',
              transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: '4px',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ fontSize: '13px' }}>🗄️</span>
            Cache
          </button>

          {/* ── Force Refresh toggle ──────────────────────────────── */}
          <button
            onClick={() => setForceRefresh(p => !p)}
            title={forceRefresh
              ? 'Force Refresh ON — will bypass cache and fetch live data from screener.in, then update the cache'
              : 'Use Cache — cached data is served regardless of age. Use Force Refresh to hard-fetch fresh data.'}
            style={{
              padding: '6px 12px', borderRadius: '6px',
              border: `1px solid ${forceRefresh ? '#d29922' : theme.border}`,
              background: forceRefresh ? '#d2992218' : theme.bgTertiary,
              color: forceRefresh ? '#d29922' : theme.textSecondary,
              fontSize: '11px', fontWeight: 700, cursor: 'pointer',
              transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: '5px',
              whiteSpace: 'nowrap',
              boxShadow: forceRefresh ? '0 0 0 1px #d2992240' : 'none',
            }}
          >
            <span style={{ fontSize: '13px' }}>{forceRefresh ? '🔄' : '📦'}</span>
            {forceRefresh ? 'Force Refresh: ON' : 'Use Cache'}
          </button>

          {/* ── Run Screener button ───────────────────────────────── */}
          <button
            onClick={handleRun}
            disabled={scanning || (activePool === 'PlayArea' && !playAreaSymbols.trim()) || Object.keys(validationErrors).length > 0}
            style={{
              padding: '7px 16px', borderRadius: '6px', border: 'none',
              background: scanning ? theme.textTertiary
                : forceRefresh ? '#d29922'
                : theme.accent,
              color: '#fff', fontSize: '12px', fontWeight: 600,
              cursor: scanning ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: '5px',
              opacity: scanning ? 0.7 : 1, whiteSpace: 'nowrap',
            }}
            onMouseEnter={e => {
              if (!scanning) e.currentTarget.style.background = forceRefresh ? '#b8861e' : theme.accentHover;
            }}
            onMouseLeave={e => {
              if (!scanning) e.currentTarget.style.background = forceRefresh ? '#d29922' : theme.accent;
            }}
          >
            {scanning ? (
              <>
                <span style={{
                  display: 'inline-block', width: '12px', height: '12px',
                  border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff',
                  borderRadius: '50%', animation: 'spin 0.7s linear infinite',
                }} />
                {forceRefresh ? 'Hard Screening...' : 'Screening...'}
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
                </svg>
                {forceRefresh ? 'Hard Screen' : 'Run Screener'}
              </>
            )}
          </button>
        </div>
      </div>

      <div style={{ padding: '16px 24px 40px', maxWidth: '1400px', margin: '0 auto' }}>

        {/* ── Force Refresh Warning Banner ─────────────────────────────── */}
        {forceRefresh && (
          <div style={{
            padding: '8px 14px', marginBottom: '12px',
            background: '#d2992215',
            border: '1px solid #d2992240',
            borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '10px',
          }}>
            <span style={{ fontSize: '16px', flexShrink: 0 }}>🔄</span>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: '#d29922' }}>
                Force Refresh is ON — Hard Screen Mode
              </span>
              <span style={{ fontSize: '11px', color: theme.textSecondary, marginLeft: '8px' }}>
                The persistent cache will be bypassed. Fresh data will be fetched from screener.in
                and the cache will be updated for the screened stocks only.
              </span>
            </div>
            <button
              onClick={() => setForceRefresh(false)}
              style={{
                padding: '3px 10px', borderRadius: '4px', border: '1px solid #d2992240',
                background: 'transparent', color: '#d29922', fontSize: '11px',
                fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              Turn Off
            </button>
          </div>
        )}

        {/* ── Cache Info Panel ─────────────────────────────────────────── */}
        {showCachePanel && (
          <div style={{
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: '10px',
            padding: '16px 20px',
            marginBottom: '16px',
            boxShadow: theme.shadow,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '16px' }}>🗄️</span>
                <span style={{ fontSize: '14px', fontWeight: 700, color: theme.text }}>
                  Persistent Cache
                </span>
                {cacheInfo && (
                  <span style={{
                    fontSize: '10px', fontWeight: 700, padding: '2px 8px',
                    borderRadius: '4px', background: theme.accentLight, color: theme.accent,
                  }}>
                    {cacheInfo.total_symbols} symbols
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '10px', color: theme.textTertiary }}>
                  {cacheInfo ? `File: ${cacheInfo.cache_file?.split('/').slice(-2).join('/')} · No expiry — use Force Refresh to update` : 'Loading...'}
                </span>
                <button
                  onClick={handleToggleCachePanel}
                  style={{
                    padding: '3px 8px', borderRadius: '4px', border: `1px solid ${theme.border}`,
                    background: 'transparent', color: theme.textSecondary,
                    fontSize: '11px', cursor: 'pointer',
                  }}
                >✕</button>
              </div>
            </div>

            {!cacheInfo && (
              <div style={{ fontSize: '12px', color: theme.textTertiary, padding: '8px 0' }}>Loading cache info...</div>
            )}

            {cacheInfo && cacheInfo.total_symbols === 0 && (
              <div style={{
                fontSize: '12px', color: theme.textTertiary, padding: '12px',
                background: theme.bgTertiary, borderRadius: '6px', textAlign: 'center',
              }}>
                Cache is empty — run the screener to populate it.
              </div>
            )}

            {cacheInfo && cacheInfo.total_symbols > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr>
                      {['Symbol', 'Cached At', 'Age', ''].map(h => (
                        <th key={h} style={{
                          padding: '5px 10px', textAlign: 'left',
                          background: theme.bgTertiary,
                          borderBottom: `1px solid ${theme.border}`,
                          fontWeight: 700, color: theme.textTertiary,
                          fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.4px',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cacheInfo.symbols.map((s, i) => (
                      <tr key={s.symbol} style={{
                        background: i % 2 === 0 ? 'transparent' : theme.tableRowAlt,
                        borderBottom: `1px solid ${theme.borderLight}`,
                      }}>
                        <td style={{ padding: '5px 10px', fontWeight: 600, color: theme.text }}>{s.symbol}</td>
                        <td style={{ padding: '5px 10px', color: theme.textSecondary }}>
                          {s.cached_at ? new Date(s.cached_at).toLocaleString() : '—'}
                        </td>
                        <td style={{ padding: '5px 10px', color: theme.textTertiary }}>
                          {s.age_hours != null ? `${s.age_hours.toFixed(1)}h ago` : '—'}
                        </td>
                        <td style={{ padding: '5px 10px' }}>
                          <span style={{
                            fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '3px',
                            background: theme.accentLight,
                            color: theme.accent,
                          }}>
                            ✓ CACHED
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Filter Configuration Panel ───────────────────────────────── */}
        <div style={{
          background: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: '10px',
          padding: '20px',
          marginBottom: '20px',
          boxShadow: theme.shadow,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div>
              <h2 style={{ fontSize: '15px', fontWeight: 700, color: theme.text, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '16px' }}>⚙️</span>
                Screening Criteria
              </h2>
              <p style={{ fontSize: '11px', color: theme.textTertiary, margin: '2px 0 0 24px' }}>
                Enable/disable and configure each filter independently. Settings are saved automatically.
              </p>
            </div>
            <button
              onClick={resetToDefaults}
              style={{
                padding: '6px 12px', borderRadius: '6px',
                border: `1px solid ${theme.border}`,
                background: theme.bgTertiary, color: theme.textSecondary,
                fontSize: '11px', fontWeight: 600, cursor: 'pointer',
                transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: '4px',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = theme.accent; e.currentTarget.style.color = theme.text; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = theme.border; e.currentTarget.style.color = theme.textSecondary; }}
              title="Reset all criteria to factory defaults"
            >
              <span style={{ fontSize: '12px' }}>↺</span>
              Reset to Defaults
            </button>
          </div>

          {/* ── Rule groups ─────────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {Object.entries(CATEGORY_META).map(([catKey, catMeta]) => {
              const catRules = groupedRules[catKey] || [];
              if (catRules.length === 0) return null;

              return (
                <div key={catKey}>
                  {/* Category header */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    marginBottom: '10px', paddingBottom: '6px',
                    borderBottom: `1px solid ${theme.divider}`,
                  }}>
                    <span style={{ fontSize: '14px' }}>{catMeta.icon}</span>
                    <span style={{
                      fontSize: '12px', fontWeight: 700, color: catMeta.color,
                      textTransform: 'uppercase', letterSpacing: '0.5px',
                    }}>
                      {catMeta.label}
                    </span>
                  </div>

                  {/* Rules in this category */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                    gap: '8px',
                  }}>
                    {catRules.map(rule => (
                      <RuleCard
                        key={rule.id}
                        rule={rule}
                        theme={theme}
                        catColor={catMeta.color}
                        onToggle={toggleRule}
                        onParamChange={updateParam}
                        validationErrors={validationErrors}
                        inputStyle={inputStyle}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Auth Status Banner ───────────────────────────────────────── */}
        {/* Show a subtle spinner while auth status hasn't arrived yet */}
        {!authStatus && (
          <div style={{
            padding: '8px 14px', marginBottom: '12px',
            background: `${theme.accent}08`,
            border: `1px solid ${theme.accent}20`,
            borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <span style={{
              display: 'inline-block', width: '10px', height: '10px',
              border: `2px solid ${theme.accent}40`, borderTopColor: theme.accent,
              borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0,
            }} />
            <span style={{ fontSize: '11px', color: theme.textSecondary }}>
              Connecting to Screener.in...
            </span>
          </div>
        )}

        {authStatus && !authStatus.authenticated && (() => {
          const mode               = authStatus.mode;
          const isNetworkBlocked   = mode === 'network_blocked';
          const isNetworkTimeout   = mode === 'network_timeout';
          const isRateLimited      = mode === 'rate_limited';
          const isWrongCredentials = mode === 'wrong_credentials';
          const isPublicOnly       = mode === 'public_only';
          const isLoginPending     = mode === 'login_pending';

          // Login still in flight — show a subtle pending indicator
          if (isLoginPending) return (
            <div style={{
              padding: '8px 14px', marginBottom: '12px',
              background: `${theme.accent}08`,
              border: `1px solid ${theme.accent}20`,
              borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <span style={{
                display: 'inline-block', width: '10px', height: '10px',
                border: `2px solid ${theme.accent}40`, borderTopColor: theme.accent,
                borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0,
              }} />
              <span style={{ fontSize: '11px', color: theme.textSecondary }}>
                Logging into Screener.in... <span style={{ color: theme.textTertiary }}>(auto-retrying every 3s)</span>
              </span>
            </div>
          );

          const bannerColor = (isNetworkBlocked || isWrongCredentials) ? theme.danger
                            : (isNetworkTimeout || isRateLimited)      ? theme.warning
                            : isPublicOnly                             ? theme.accent
                            : theme.warning;

          const icon  = isNetworkBlocked   ? '🚫'
                      : isNetworkTimeout   ? '⏱️'
                      : isRateLimited      ? '🚦'
                      : isWrongCredentials ? '🔑'
                      : isPublicOnly       ? 'ℹ️'
                      : '⚠️';

          const title = isNetworkBlocked   ? 'Network Blocked — screener.in unreachable from this server'
                      : isNetworkTimeout   ? 'Login Timed Out — screener.in was slow to respond'
                      : isRateLimited      ? 'Rate Limited — Too Many Login Attempts (HTTP 429)'
                      : isWrongCredentials ? 'Wrong Credentials — screener.in rejected the login'
                      : isPublicOnly       ? 'Public Mode — Partial Data Only'
                      : 'Screener.in Login Error';

          const badge = isNetworkBlocked   ? 'NETWORK BLOCKED'
                      : isNetworkTimeout   ? 'TIMED OUT'
                      : isRateLimited      ? '429 RATE LIMITED'
                      : isWrongCredentials ? 'WRONG PASSWORD'
                      : isPublicOnly       ? 'PUBLIC ONLY'
                      : 'LOGIN ERROR';

          return (
            <div style={{
              padding: '10px 14px', marginBottom: '12px',
              background: `${bannerColor}10`,
              border: `1px solid ${bannerColor}30`,
              borderRadius: '8px',
              display: 'flex', alignItems: 'flex-start', gap: '10px',
            }}>
              <span style={{ fontSize: '16px', flexShrink: 0, marginTop: '1px' }}>{icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: bannerColor, marginBottom: '3px' }}>
                  {title}
                </div>
                <div style={{ fontSize: '11px', color: theme.textSecondary, lineHeight: 1.6 }}>
                  {isNetworkBlocked && (
                    <>
                      <strong>Your credentials are correct.</strong> The issue is this server&apos;s network firewall
                      blocks outbound connections to{' '}
                      <code style={{ background: theme.bgTertiary, padding: '1px 4px', borderRadius: '3px' }}>screener.in</code>.{' '}
                      Run <code style={{ background: theme.bgTertiary, padding: '1px 4px', borderRadius: '3px' }}>py debug_login_local.py</code>{' '}
                      on your <strong>local machine</strong> to confirm, then start the backend locally.
                    </>
                  )}
                  {isNetworkTimeout && (
                    <>
                      screener.in took too long to respond during login. This is usually <strong>temporary</strong>.{' '}
                      <strong>Click Run Screener</strong> to retry — login will be attempted again automatically.
                    </>
                  )}
                  {isRateLimited && (
                    <>
                      screener.in returned <strong>HTTP 429</strong> — too many login requests in a short time.{' '}
                      This is now <strong>fixed</strong>: your session is saved to disk so restarts won&apos;t re-login.{' '}
                      <strong>Wait 2–3 minutes</strong>, then click{' '}
                      <strong>Run Screener</strong> — it will retry automatically.
                    </>
                  )}
                  {isWrongCredentials && (
                    <>
                      screener.in rejected the login. Steps to fix:{' '}
                      <strong>1)</strong> Verify at{' '}
                      <a href="https://www.screener.in/login/" target="_blank" rel="noreferrer"
                         style={{ color: bannerColor }}>screener.in/login</a>,{' '}
                      <strong>2)</strong> Update <code style={{ background: theme.bgTertiary, padding: '1px 4px', borderRadius: '3px' }}>SCREENER_PASSWORD</code> in{' '}
                      <code style={{ background: theme.bgTertiary, padding: '1px 4px', borderRadius: '3px' }}>backend/.env</code>,{' '}
                      <strong>3)</strong> Restart the backend.
                    </>
                  )}
                  {isPublicOnly && (
                    <>
                      <strong>PE &amp; PB history</strong> work without login (public chart API).{' '}
                      <strong>ROCE, ROE, Quarterly data, Pledging</strong> need authentication.{' '}
                      Add <code style={{ background: theme.bgTertiary, padding: '1px 4px', borderRadius: '3px' }}>SCREENER_EMAIL</code> and{' '}
                      <code style={{ background: theme.bgTertiary, padding: '1px 4px', borderRadius: '3px' }}>SCREENER_PASSWORD</code> to{' '}
                      <code style={{ background: theme.bgTertiary, padding: '1px 4px', borderRadius: '3px' }}>backend/.env</code>.
                    </>
                  )}
                  {!isNetworkBlocked && !isNetworkTimeout && !isRateLimited && !isWrongCredentials && !isPublicOnly && (
                    <>{authStatus.note}</>
                  )}
                </div>
              </div>
              <div style={{
                flexShrink: 0, fontSize: '10px', fontWeight: 700, padding: '3px 8px',
                borderRadius: '4px', background: theme.bgTertiary, color: theme.textTertiary,
                whiteSpace: 'nowrap',
              }}>
                {badge}
              </div>
            </div>
          );
        })()}

        {authStatus?.authenticated && (
          <div style={{
            padding: '8px 14px', marginBottom: '12px',
            background: `${theme.success}10`,
            border: `1px solid ${theme.success}25`,
            borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <span style={{ fontSize: '14px' }}>🔐</span>
            <span style={{ fontSize: '11px', color: theme.success, fontWeight: 600 }}>
              Authenticated — Full data available (quarterly results, ROCE, ROE, pledging)
            </span>
            <span style={{ fontSize: '10px', color: theme.textTertiary, marginLeft: 'auto' }}>
              {authStatus.email_configured ? authStatus.note?.split('—')[0] : ''}
            </span>
          </div>
        )}

        {/* ── Error Banner ─────────────────────────────────────────────── */}
        {error && (
          <div style={{
            padding: '10px 14px', marginBottom: '16px',
            background: theme.dangerLight, border: `1px solid ${theme.danger}25`,
            borderRadius: '6px', color: theme.danger, fontSize: '12px', fontWeight: 500,
          }}>
            ⚠ {error}
          </div>
        )}

        {/* ── Live Progress Panel (while scanning) ────────────────────── */}
        {scanning && (
          <div style={{
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: '10px',
            padding: '20px 24px',
            boxShadow: theme.shadow,
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
              <div style={{
                width: '20px', height: '20px', flexShrink: 0,
                border: `2px solid ${theme.border}`, borderTopColor: theme.accent,
                borderRadius: '50%', animation: 'spin 0.7s linear infinite',
              }} />
              <div>
                <div style={{ fontSize: '14px', fontWeight: 700, color: theme.text }}>
                  {progressManifest?.throttle_active
                    ? '🔬 Screening with rate-limit protection…'
                    : '🔬 Fetching fundamentals from Screener.in…'}
                </div>
                {progressManifest && (
                  <div style={{ fontSize: '11px', color: theme.textTertiary, marginTop: '2px' }}>
                    {progressManifest.cache_hits > 0 && (
                      <span>📦 {progressManifest.cache_hits} from cache · </span>
                    )}
                    <span>🌐 {progressManifest.internet_fetches} live fetch{progressManifest.internet_fetches !== 1 ? 'es' : ''}</span>
                    {progressManifest.throttle_active && (
                      <span style={{ color: theme.warning }}>
                        {' '}· ⚠ 20s throttle between fetches to avoid 429
                      </span>
                    )}
                    {progressManifest.estimated_seconds > 0 && (
                      <span style={{ color: theme.textTertiary }}>
                        {' '}· ~{Math.round(progressManifest.estimated_seconds / 60)}m estimated
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Progress bar for internet fetches */}
            {progressManifest && progressManifest.internet_fetches > 0 && (
              <div style={{ marginBottom: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: theme.textTertiary, marginBottom: '4px' }}>
                  <span>Live Fetches</span>
                  <span>{internetFetchesDone} / {progressManifest.internet_fetches}</span>
                </div>
                <div style={{ height: '6px', background: theme.bgTertiary, borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${progressManifest.internet_fetches > 0 ? (internetFetchesDone / progressManifest.internet_fetches) * 100 : 0}%`,
                    background: theme.accent,
                    borderRadius: '3px',
                    transition: 'width 0.4s ease',
                  }} />
                </div>
              </div>
            )}

            {/* Throttle countdown */}
            {throttleCountdown > 0 && (
              <div style={{
                padding: '12px 16px',
                background: `${theme.warning}12`,
                border: `1px solid ${theme.warning}30`,
                borderRadius: '8px',
                marginBottom: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              }}>
                {/* Circular countdown visual */}
                <div style={{ position: 'relative', flexShrink: 0, width: '44px', height: '44px' }}>
                  <svg width="44" height="44" viewBox="0 0 44 44" style={{ transform: 'rotate(-90deg)' }}>
                    <circle cx="22" cy="22" r="18" fill="none" stroke={`${theme.warning}25`} strokeWidth="3" />
                    <circle
                      cx="22" cy="22" r="18"
                      fill="none"
                      stroke={theme.warning}
                      strokeWidth="3"
                      strokeDasharray={`${2 * Math.PI * 18}`}
                      strokeDashoffset={`${2 * Math.PI * 18 * (1 - throttleCountdown / 20)}`}
                      strokeLinecap="round"
                      style={{ transition: 'stroke-dashoffset 0.9s linear' }}
                    />
                  </svg>
                  <div style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '13px', fontWeight: 700, color: theme.warning,
                    fontFamily: "'SF Mono', 'Fira Code', monospace",
                  }}>
                    {throttleCountdown}
                  </div>
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: theme.warning, marginBottom: '2px' }}>
                    ⏳ Rate-limit pause — next fetch in {throttleCountdown}s
                  </div>
                  <div style={{ fontSize: '11px', color: theme.textSecondary }}>
                    Waiting to avoid screener.in&apos;s 429 Too Many Requests.
                    {nextSymbol && (
                      <span> Next: <strong style={{ color: theme.text }}>{nextSymbol}</strong></span>
                    )}
                  </div>
                </div>

                {/* Linear countdown bar */}
                <div style={{ flexShrink: 0, width: '80px' }}>
                  <div style={{ height: '4px', background: `${theme.warning}25`, borderRadius: '2px', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${(throttleCountdown / 20) * 100}%`,
                      background: theme.warning,
                      borderRadius: '2px',
                      transition: 'width 0.9s linear',
                    }} />
                  </div>
                  <div style={{ fontSize: '9px', color: theme.textTertiary, marginTop: '3px', textAlign: 'right' }}>
                    {throttleCountdown}s / 20s
                  </div>
                </div>
              </div>
            )}

            {/* Recent activity log */}
            {progressLog.length > 0 && (
              <div>
                <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textTertiary, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                  Activity
                </div>
                <div style={{
                  maxHeight: '180px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '3px',
                }}>
                  {[...progressLog].reverse().map((entry, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        background: i === 0 ? theme.accentLight : 'transparent',
                        opacity: i === 0 ? 1 : Math.max(0.35, 1 - i * 0.08),
                      }}
                    >
                      <span style={{ fontSize: '11px', flexShrink: 0 }}>
                        {entry.from_cache ? '📦' : entry.status === 'fetching' ? '🌐' : '✅'}
                      </span>
                      <span style={{
                        fontSize: '11px', fontWeight: 600, color: theme.text,
                        fontFamily: "'SF Mono', 'Fira Code', monospace",
                        minWidth: '80px',
                      }}>
                        {entry.symbol}
                      </span>
                      <span style={{
                        fontSize: '10px',
                        color: entry.from_cache ? theme.accent
                          : entry.status === 'fetching' ? theme.warning
                          : theme.success,
                      }}>
                        {entry.from_cache ? 'from cache'
                          : entry.status === 'fetching' ? 'fetching…'
                          : 'fetched'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Empty pre-manifest state */}
            {!progressManifest && progressLog.length === 0 && (
              <div style={{ textAlign: 'center', padding: '20px', color: theme.textTertiary, fontSize: '12px' }}>
                Connecting to screener.in…
              </div>
            )}
          </div>
        )}

        {/* ── Results ──────────────────────────────────────────────────── */}
        {scanResult && !scanning && (
          <div ref={resultsRef}>
            {/* Summary cards */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
              gap: '8px', marginBottom: '14px',
            }}>
              {[
                { label: 'Total Stocks',   value: scanResult.total_stocks,           color: theme.textSecondary },
                { label: 'Data Available', value: scanResult.data_available,          color: theme.accent },
                { label: 'All Passed',     value: scanResult.passed_all,             color: theme.success,
                  highlight: scanResult.passed_all > 0 },
                { label: scanResult.force_refresh ? '🔄 Live Fetched' : '📦 From Cache',
                  value: scanResult.force_refresh ? scanResult.live_fetches : scanResult.cache_hits,
                  color: scanResult.force_refresh ? '#d29922' : theme.accent,
                },
                { label: 'Duration',       value: `${scanResult.scan_duration_seconds}s`, color: theme.textTertiary },
              ].map(card => (
                <div key={card.label} style={{
                  background: card.highlight ? theme.successLight : theme.bgCard,
                  borderRadius: '8px', padding: '12px 14px',
                  border: `1px solid ${card.highlight ? theme.success + '30' : theme.border}`,
                  boxShadow: card.highlight ? theme.shadowMd : theme.shadow,
                  textAlign: 'center',
                }}>
                  <div style={{ fontSize: '22px', fontWeight: 700, color: card.color, lineHeight: 1.1 }}>
                    {card.value}
                  </div>
                  <div style={{
                    fontSize: '10px', color: theme.textTertiary, fontWeight: 600,
                    textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: '3px',
                  }}>
                    {card.label}
                  </div>
                </div>
              ))}
            </div>

            {/* ── Copyable Symbol List ──────────────────────────────────── */}
            {scanResult.passed_all > 0 && (
              <div style={{
                background: theme.successLight,
                border: `1px solid ${theme.success}30`,
                borderRadius: '8px', padding: '12px 16px', marginBottom: '14px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontSize: '10px', fontWeight: 700, color: theme.success,
                    textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px',
                  }}>
                    ✅ Stocks Passing All Criteria ({scanResult.passed_all})
                  </div>
                  <div style={{
                    fontSize: '12px', color: theme.text, fontWeight: 500,
                    ...monoStyle, lineHeight: 1.6, wordBreak: 'break-word',
                    userSelect: 'all',
                  }}>
                    {getPassedSymbols()}
                  </div>
                </div>
                <button
                  onClick={handleCopy}
                  style={{
                    padding: '6px 14px', borderRadius: '6px', border: 'none',
                    background: copied ? theme.success : theme.accent,
                    color: '#fff', fontSize: '11px', fontWeight: 600,
                    cursor: 'pointer', whiteSpace: 'nowrap',
                    transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: '4px',
                  }}
                >
                  {copied ? '✓ Copied!' : '📋 Copy List'}
                </button>
              </div>
            )}

            {/* ── Filter bar ───────────────────────────────────────────── */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: '10px', gap: '8px', flexWrap: 'wrap',
            }}>
              <div style={{ display: 'flex', gap: '4px' }}>
                {[
                  { key: 'all',    label: `All (${scanResult.results?.length || 0})` },
                  { key: 'passed', label: `Passed (${scanResult.passed_all})` },
                  { key: 'failed', label: `Failed (${(scanResult.results?.length || 0) - scanResult.passed_all})` },
                ].map(f => (
                  <button
                    key={f.key}
                    onClick={() => setFilterMode(f.key)}
                    style={{
                      padding: '5px 12px', borderRadius: '5px',
                      border: `1px solid ${filterMode === f.key ? theme.accent : theme.border}`,
                      background: filterMode === f.key ? theme.accentLight : 'transparent',
                      color: filterMode === f.key ? theme.accent : theme.textSecondary,
                      fontSize: '11px', fontWeight: 600, cursor: 'pointer',
                      transition: 'all 0.12s',
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {scanResult.force_refresh && (
                  <span style={{
                    fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '3px',
                    background: '#d2992218', color: '#d29922', border: '1px solid #d2992230',
                  }}>
                    🔄 HARD SCREEN — live data
                  </span>
                )}
                {!scanResult.force_refresh && scanResult.cache_hits > 0 && (
                  <span style={{
                    fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '3px',
                    background: theme.accentLight, color: theme.accent,
                  }}>
                    📦 {scanResult.cache_hits} from cache
                  </span>
                )}
                <span style={{ fontSize: '11px', color: theme.textTertiary }}>
                  {sortedResults.length} stocks · {new Date(scanResult.scan_timestamp).toLocaleTimeString()}
                </span>
              </div>
            </div>

            {/* ── Results Table ─────────────────────────────────────────── */}
            <div style={{
              border: `1px solid ${theme.border}`,
              borderRadius: '8px',
              background: theme.bgCard,
              overflow: 'hidden',
              boxShadow: theme.shadow,
            }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr>
                      {[
                        { key: 'symbol',        label: 'Symbol',    align: 'left',   w: '90px'  },
                        { key: 'sector',         label: 'Sector',    align: 'left',   w: '100px' },
                        { key: 'cap_type',       label: 'Cap',       align: 'center', w: '50px'  },
                        { key: 'all_passed',     label: 'Status',    align: 'center', w: '70px'  },
                        { key: 'passed_count',   label: 'Passed',    align: 'center', w: '60px'  },
                        { key: 'failed_count',   label: 'Failed',    align: 'center', w: '60px'  },
                        { key: 'current_pe',     label: 'PE',        align: 'right',  w: '60px'  },
                        { key: 'current_pb',     label: 'PB',        align: 'right',  w: '60px'  },
                        { key: 'roce',           label: 'ROCE %',    align: 'right',  w: '65px'  },
                        { key: 'roe',            label: 'ROE %',     align: 'right',  w: '65px'  },
                        { key: 'pledging',           label: 'Pledge %',    align: 'right',  w: '65px'  },
                        { key: 'net_debt_to_equity', label: 'ND/Eq',       align: 'right',  w: '65px'  },
                        { key: 'latest_sales',       label: 'Q Sales',     align: 'right',  w: '80px'  },
                        { key: 'latest_net_profit', label: 'Q Profit', align: 'right', w: '80px'  },
                      ].map(col => (
                        <th
                          key={col.key}
                          onClick={() => handleSort(col.key)}
                          style={{
                            padding: '8px 10px', textAlign: col.align,
                            background: theme.bgTertiary,
                            borderBottom: `2px solid ${theme.border}`,
                            fontWeight: 600,
                            color: sortCol === col.key ? theme.accent : theme.textTertiary,
                            cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
                            fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.4px',
                            minWidth: col.w, position: 'sticky', top: 0, zIndex: 2,
                          }}
                        >
                          {col.label}
                          {sortCol === col.key && (
                            <span style={{ marginLeft: '2px', fontSize: '8px' }}>
                              {sortAsc ? '▲' : '▼'}
                            </span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedResults.map((row, idx) => {
                      const isExpanded = expandedRow === idx;
                      const capStyle = getCapStyle(row.cap_type);
                      const fs = row.fundamentals_summary || {};

                      return (
                        <React.Fragment key={row.symbol + idx}>
                          <tr
                            style={{
                              background: isExpanded ? theme.accentLight
                                : idx % 2 === 0 ? 'transparent' : theme.tableRowAlt,
                              cursor: 'pointer',
                              transition: 'background 0.08s',
                              borderBottom: `1px solid ${theme.borderLight}`,
                            }}
                            onClick={() => setExpandedRow(isExpanded ? null : idx)}
                            onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = theme.tableRowHover; }}
                            onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = idx % 2 === 0 ? 'transparent' : theme.tableRowAlt; }}
                          >
                            <td style={{ padding: '8px 10px', fontWeight: 600, color: theme.text, fontSize: '12px' }}>
                              {row.symbol}
                            </td>
                            <td style={{
                              padding: '8px 10px', color: theme.textSecondary, fontSize: '11px',
                              maxWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {row.sector || '—'}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                              <span style={{
                                fontSize: '9px', fontWeight: 600, padding: '2px 5px',
                                borderRadius: '3px', background: capStyle.bg, color: capStyle.color,
                              }}>
                                {capStyle.text}
                              </span>
                            </td>
                            {/* Status */}
                            <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                              {row.error ? (
                                <span style={{
                                  fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '3px',
                                  background: theme.dangerLight, color: theme.danger,
                                }}>ERR</span>
                              ) : row.all_passed ? (
                                <span style={{
                                  fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '3px',
                                  background: theme.successLight, color: theme.successDark, letterSpacing: '0.3px',
                                }}>PASS</span>
                              ) : (
                                <span style={{
                                  fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '3px',
                                  background: theme.warningLight, color: theme.warningDark,
                                }}>FAIL</span>
                              )}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: theme.success, ...monoStyle }}>
                              {row.passed_count}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: row.failed_count > 0 ? theme.danger : theme.textTertiary, ...monoStyle }}>
                              {row.failed_count}
                            </td>
                            {/* Fundamental values */}
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
                              {fs.current_pe != null ? fs.current_pe.toFixed(1) : '—'}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
                              {fs.current_pb != null ? fs.current_pb.toFixed(1) : '—'}
                            </td>
                            <td style={{
                              padding: '8px 10px', textAlign: 'right', ...monoStyle,
                              fontWeight: 600,
                              color: fs.roce >= 18 ? theme.success : fs.roce > 0 ? theme.warning : theme.textTertiary,
                            }}>
                              {fs.roce != null ? `${fs.roce.toFixed(1)}` : '—'}
                            </td>
                            <td style={{
                              padding: '8px 10px', textAlign: 'right', ...monoStyle,
                              fontWeight: 600,
                              color: fs.roe >= 18 ? theme.success : fs.roe > 0 ? theme.warning : theme.textTertiary,
                            }}>
                              {fs.roe != null ? `${fs.roe.toFixed(1)}` : '—'}
                            </td>
                            <td style={{
                              padding: '8px 10px', textAlign: 'right', ...monoStyle,
                              fontWeight: 600,
                              color: fs.promoter_pledging_pct == null
                                ? theme.textTertiary
                                : fs.promoter_pledging_pct <= 5
                                  ? theme.success
                                  : theme.danger,
                            }}>
                              {fs.promoter_pledging_pct != null ? `${fs.promoter_pledging_pct.toFixed(1)}` : '—'}
                            </td>
                            <td style={{
                              padding: '8px 10px', textAlign: 'right', ...monoStyle,
                              fontWeight: 600,
                              color: fs.net_debt_to_equity == null
                                ? theme.textTertiary
                                : fs.net_debt_to_equity < 0.30
                                  ? theme.success
                                  : theme.danger,
                            }}>
                              {fs.net_debt_to_equity != null ? fs.net_debt_to_equity.toFixed(2) : '—'}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
                              {fs.latest_sales != null ? fs.latest_sales.toLocaleString() : '—'}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
                              {fs.latest_net_profit != null ? fs.latest_net_profit.toLocaleString() : '—'}
                            </td>
                          </tr>

                          {/* ── Expanded Rule Details ─────────────────────── */}
                          {isExpanded && (
                            <tr>
                              <td colSpan={14} style={{ padding: 0, borderBottom: `2px solid ${theme.accent}30` }}>
                                <div style={{ padding: '12px 16px', background: theme.bgTertiary }}>
                                  <div style={{
                                    fontSize: '10px', fontWeight: 700, color: theme.textTertiary,
                                    textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px',
                                  }}>
                                    Rule Evaluation Details — {row.symbol}
                                  </div>
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '6px' }}>
                                    {(row.rule_results || []).map((rr, i) => (
                                      <div key={i} style={{
                                        padding: '8px 12px', background: theme.bgCard,
                                        borderRadius: '6px',
                                        border: `1px solid ${!rr.enabled ? theme.border : rr.passed ? theme.success + '30' : theme.danger + '30'}`,
                                        opacity: rr.enabled ? 1 : 0.5,
                                      }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                                          <span style={{ fontSize: '10px' }}>
                                            {!rr.enabled ? '⏸️' : rr.passed ? '✅' : '❌'}
                                          </span>
                                          <span style={{ fontWeight: 600, color: theme.text, fontSize: '11px' }}>
                                            {rr.rule_label}
                                          </span>
                                          <span style={{
                                            fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px',
                                            textTransform: 'uppercase',
                                            background: !rr.enabled ? theme.bgTertiary : rr.passed ? theme.successLight : theme.dangerLight,
                                            color: !rr.enabled ? theme.textTertiary : rr.passed ? theme.successDark : theme.danger,
                                          }}>
                                            {!rr.enabled ? 'SKIP' : rr.passed ? 'PASS' : 'FAIL'}
                                          </span>
                                        </div>
                                        <div style={{ fontSize: '10px', color: theme.textSecondary, lineHeight: 1.4 }}>
                                          {rr.details?.reason || '—'}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {sortedResults.length === 0 && (
                <div style={{ padding: '40px', textAlign: 'center', color: theme.textTertiary, fontSize: '13px' }}>
                  No stocks match the current filter.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Empty State ──────────────────────────────────────────────── */}
        {!scanResult && !scanning && (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <div style={{
              width: '48px', height: '48px', borderRadius: '12px',
              background: theme.accentLight,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '22px', marginBottom: '12px',
            }}>
              🔬
            </div>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: theme.text, marginBottom: '4px' }}>
              Advanced Fundamental Screener
            </h3>
            <p style={{ fontSize: '12px', color: theme.textTertiary, maxWidth: '400px', margin: '0 auto', lineHeight: 1.5 }}>
              Configure the screening criteria above, select a stock pool, then click <strong>Run Screener</strong> to
              find stocks that meet your fundamental requirements.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
//  RULE CARD — Individual configurable rule
// ═══════════════════════════════════════════════════════════════════════════
function RuleCard({ rule, theme, catColor, onToggle, onParamChange, validationErrors, inputStyle }) {
  const enabled = rule.enabled;

  return (
    <div
      style={{
        padding: '10px 14px',
        borderRadius: '8px',
        border: `1px solid ${enabled ? catColor + '30' : theme.border}`,
        background: enabled ? theme.bgCard : theme.bgTertiary,
        opacity: enabled ? 1 : 0.6,
        transition: 'all 0.15s',
      }}
    >
      {/* Header: checkbox + label + tooltip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={() => onToggle(rule.id)}
          style={{ cursor: 'pointer', accentColor: catColor, width: '14px', height: '14px' }}
        />
        <span
          style={{
            fontSize: '12px', fontWeight: 600,
            color: enabled ? theme.text : theme.textTertiary,
            flex: 1,
          }}
          title={rule.description}
        >
          {rule.label}
        </span>
        {/* Info icon with tooltip */}
        <span
          title={rule.description}
          style={{
            fontSize: '11px', cursor: 'help', color: theme.textTertiary,
            width: '16px', height: '16px', borderRadius: '50%',
            border: `1px solid ${theme.textTertiary}40`,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          ?
        </span>
      </div>

      {/* Description */}
      <div style={{
        fontSize: '10px', color: theme.textTertiary, lineHeight: 1.4,
        marginBottom: enabled && Object.keys(rule.params || {}).length > 0 ? '8px' : '0',
        marginLeft: '22px',
      }}>
        {rule.description}
      </div>

      {/* Parameters */}
      {enabled && Object.entries(rule.params || {}).map(([pk, pv]) => {
        const errKey = `${rule.id}.${pk}`;
        const hasError = !!validationErrors[errKey];
        const currentVal = pv.value ?? pv.default;

        return (
          <div key={pk} style={{ marginLeft: '22px', marginTop: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <label style={{ fontSize: '10px', color: theme.textSecondary, fontWeight: 600, minWidth: '80px' }}>
                {pv.label}:
              </label>
              <input
                type="number"
                value={currentVal}
                onChange={e => onParamChange(rule.id, pk, e.target.value)}
                min={pv.min}
                max={pv.max}
                step={pv.type === 'int' ? 1 : 0.1}
                style={{
                  ...inputStyle,
                  borderColor: hasError ? theme.danger : theme.border,
                  width: '65px',
                }}
              />
              <span style={{ fontSize: '10px', color: theme.textTertiary }}>
                {pv.unit}
              </span>
            </div>
            {hasError && (
              <div style={{ fontSize: '10px', color: theme.danger, marginLeft: '86px', marginTop: '2px' }}>
                {validationErrors[errKey]}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
