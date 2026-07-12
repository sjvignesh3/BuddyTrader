import React, { useState, useEffect } from 'react';
import { useTheme } from '../context/ThemeContext';
import { triggerScan, getCachedScan } from '../services/api';
import ResultsTable from '../components/ResultsTable';
import ScanSummary from '../components/ScanSummary';
import { exportPoolToCSV } from '../services/exportUtils';

const POOL_TABS = [
  { code: 'F40',      label: 'Flagship 40',   short: 'F40',   icon: '🏛️' },
  { code: 'E40',      label: 'Emerging 40',   short: 'E40',   icon: '🚀' },
  { code: 'S200',     label: 'Smartpick 200', short: 'S200',  icon: '📈' },
  { code: 'PlayArea', label: 'Play Area',     short: 'Play',  icon: '🎯' },
];

export default function ScannerPage({ initialPool, scanCache, setScanCache }) {
  const { theme } = useTheme();
  const [activePool, setActivePool] = useState(initialPool || 'F40');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [playAreaSymbols, setPlayAreaSymbols] = useState('');

  // Filters
  const [filters, setFilters] = useState({
    signal: '',
    cap: '',
    sector: '',
    belowDmaMin: '',
    belowDmaMax: '',
    fromLowMin: '',
    fromLowMax: '',
    downAthMin: '',
    downAthMax: '',
  });

  const currentData = scanCache[activePool] || null;

  const handleScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const params = activePool === 'PlayArea' && playAreaSymbols.trim()
        ? { symbols: playAreaSymbols.trim() }
        : {};

      const result = await triggerScan(activePool, null, params.symbols);

      // Process results into opportunities / no_signal
      const results = result.results || [];
      const opportunities = results.filter(r => r.best_status !== 'NO_SIGNAL');
      const noSignal = results.filter(r => r.best_status === 'NO_SIGNAL');

      const processed = {
        ...result,
        opportunities,
        no_signal: noSignal,
        allResults: results,
      };

      setScanCache(prev => ({ ...prev, [activePool]: processed }));
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  };

  // Load cached data on tab switch
  useEffect(() => {
    if (!scanCache[activePool]) {
      // Try loading from backend cache
      getCachedScan(activePool)
        .then(data => {
          if (data && data.results) {
            const results = data.results || [];
            const opportunities = results.filter(r => r.best_status !== 'NO_SIGNAL');
            const noSignal = results.filter(r => r.best_status === 'NO_SIGNAL');
            setScanCache(prev => ({
              ...prev,
              [activePool]: { ...data, opportunities, no_signal: noSignal, allResults: results },
            }));
          }
        })
        .catch(() => {}); // Silently ignore if no cached data
    }
  }, [activePool]);

  // Reset filters on pool switch
  useEffect(() => {
    setFilters({
      signal: '', cap: '', sector: '',
      belowDmaMin: '', belowDmaMax: '',
      fromLowMin: '', fromLowMax: '',
      downAthMin: '', downAthMax: '',
    });
  }, [activePool]);

  // Get unique sectors from current data
  const sectors = currentData?.allResults
    ? [...new Set(currentData.allResults.map(r => r.sector).filter(Boolean))].sort()
    : [];

  // Apply filters to all results
  const getFilteredResults = () => {
    if (!currentData?.allResults) return [];
    let data = [...currentData.allResults];

    if (filters.signal) {
      if (filters.signal === 'SIGNAL') {
        // "Has Signal" = any meaningful status (not NO_SIGNAL / INVALID)
        data = data.filter(r => r.best_status !== 'NO_SIGNAL' && r.best_status !== 'INVALID');
      } else {
        data = data.filter(r => r.best_status === filters.signal);
      }
    }
    if (filters.cap) {
      data = data.filter(r => (r.cap_type || '').toLowerCase().includes(filters.cap.toLowerCase()));
    }
    if (filters.sector) {
      data = data.filter(r => r.sector === filters.sector);
    }
    if (filters.belowDmaMin) {
      data = data.filter(r => (r.below_200dma_pct || 0) >= parseFloat(filters.belowDmaMin));
    }
    if (filters.belowDmaMax) {
      data = data.filter(r => (r.below_200dma_pct || 0) <= parseFloat(filters.belowDmaMax));
    }
    if (filters.fromLowMin) {
      data = data.filter(r => (r.distance_from_52w_low_pct || 0) >= parseFloat(filters.fromLowMin));
    }
    if (filters.fromLowMax) {
      data = data.filter(r => (r.distance_from_52w_low_pct || 0) <= parseFloat(filters.fromLowMax));
    }
    if (filters.downAthMin) {
      data = data.filter(r => (r.down_from_ath_pct || 0) >= parseFloat(filters.downAthMin));
    }
    if (filters.downAthMax) {
      data = data.filter(r => (r.down_from_ath_pct || 0) <= parseFloat(filters.downAthMax));
    }

    return data;
  };

  const filteredResults = getFilteredResults();
  const hasActiveFilters = Object.values(filters).some(v => v !== '');

  const inputStyle = {
    padding: '5px 8px',
    borderRadius: '5px',
    border: `1px solid ${theme.border}`,
    fontSize: '11px',
    background: theme.bgInput,
    color: theme.text,
    outline: 'none',
    width: '100%',
    minWidth: '50px',
  };

  const selectStyle = {
    ...inputStyle,
    cursor: 'pointer',
    appearance: 'none',
    paddingRight: '20px',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%236B7080' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 6px center',
  };

  return (
    <div style={{
      padding: '0 0 32px',
      animation: 'fadeIn 0.25s ease',
    }}>
      {/* ── Pool Tabs ── */}
      <div style={{
        display: 'flex',
        alignItems: 'stretch',
        padding: '0 24px',
        background: theme.bgSecondary,
        borderBottom: `1px solid ${theme.border}`,
        gap: '0',
      }}>
        {POOL_TABS.map((tab) => {
          const isActive = activePool === tab.code;
          const cached = scanCache[tab.code];

          return (
            <button
              key={tab.code}
              onClick={() => setActivePool(tab.code)}
              style={{
                padding: '12px 18px 10px',
                border: 'none',
                borderBottom: isActive ? `2px solid ${theme.accent}` : '2px solid transparent',
                background: 'transparent',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '2px',
                transition: 'all 0.15s',
                minWidth: '100px',
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.background = theme.bgHover;
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.background = 'transparent';
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}>
                <span style={{ fontSize: '14px' }}>{tab.icon}</span>
                <span style={{
                  fontSize: '13px',
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? theme.text : theme.textSecondary,
                }}>
                  {tab.short}
                </span>
                {cached && (
                  <span style={{
                    width: '6px', height: '6px', borderRadius: '50%',
                    background: theme.success, flexShrink: 0,
                  }} />
                )}
              </div>
              {cached && (
                <span style={{
                  fontSize: '9px',
                  color: theme.textTertiary,
                  whiteSpace: 'nowrap',
                }}>
                  {new Date(cached.scan_timestamp).toLocaleTimeString([], {
                    hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              )}
            </button>
          );
        })}

        {/* Spacer + Scan button */}
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '10px',
          padding: '0 4px',
        }}>
          {/* PlayArea symbol input */}
          {activePool === 'PlayArea' && (
            <input
              type="text"
              placeholder="RELIANCE, TCS, INFY..."
              value={playAreaSymbols}
              onChange={(e) => setPlayAreaSymbols(e.target.value)}
              style={{
                padding: '7px 12px',
                borderRadius: '6px',
                border: `1px solid ${theme.border}`,
                fontSize: '12px',
                background: theme.bgInput,
                color: theme.text,
                outline: 'none',
                width: '240px',
              }}
            />
          )}

          <button
            onClick={handleScan}
            disabled={scanning || (activePool === 'PlayArea' && !playAreaSymbols.trim())}
            style={{
              padding: '7px 16px',
              borderRadius: '6px',
              border: 'none',
              background: scanning ? theme.textTertiary : theme.accent,
              color: '#fff',
              fontSize: '12px',
              fontWeight: 600,
              cursor: scanning ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              opacity: scanning ? 0.7 : 1,
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => {
              if (!scanning) e.currentTarget.style.background = theme.accentHover;
            }}
            onMouseLeave={(e) => {
              if (!scanning) e.currentTarget.style.background = theme.accent;
            }}
          >
            {scanning ? (
              <>
                <span style={{
                  display: 'inline-block',
                  width: '12px', height: '12px',
                  border: '2px solid rgba(255,255,255,0.3)',
                  borderTopColor: '#fff',
                  borderRadius: '50%',
                  animation: 'spin 0.7s linear infinite',
                }} />
                Scanning...
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                Run Scan
              </>
            )}
          </button>

          {/* Export CSV — only visible when data is available */}
          {currentData && !scanning && (
            <button
              onClick={() => exportPoolToCSV(filteredResults, activePool)}
              title={`Export ${activePool} results as CSV`}
              style={{
                padding: '7px 14px',
                borderRadius: '6px',
                border: `1px solid ${theme.border}`,
                background: theme.bgCard,
                color: theme.textSecondary,
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = theme.bgHover;
                e.currentTarget.style.color = theme.text;
                e.currentTarget.style.borderColor = theme.accent;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = theme.bgCard;
                e.currentTarget.style.color = theme.textSecondary;
                e.currentTarget.style.borderColor = theme.border;
              }}
            >
              {/* Download icon */}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export CSV
            </button>
          )}

        </div>
      </div>

      {/* ── Error Banner ── */}
      {error && (
        <div style={{
          margin: '16px 24px 0',
          padding: '10px 14px',
          background: theme.dangerLight,
          border: `1px solid ${theme.danger}25`,
          borderRadius: '6px',
          color: theme.danger,
          fontSize: '12px',
          fontWeight: 500,
        }}>
          ⚠ {error}
        </div>
      )}

      {/* ── Scanning State ── */}
      {scanning && (
        <div style={{
          textAlign: 'center',
          padding: '80px 24px',
        }}>
          <div style={{
            width: '40px', height: '40px',
            border: `3px solid ${theme.border}`,
            borderTopColor: theme.accent,
            borderRadius: '50%',
            animation: 'spin 0.7s linear infinite',
            margin: '0 auto 14px',
          }} />
          <p style={{ fontSize: '14px', fontWeight: 600, color: theme.text, marginBottom: '4px' }}>
            Fetching live data & running strategies...
          </p>
          <p style={{ fontSize: '11px', color: theme.textTertiary }}>
            This may take 30–60s for the first scan
          </p>
        </div>
      )}

      {/* ── Empty State ── */}
      {!currentData && !scanning && (
        <div style={{
          textAlign: 'center',
          padding: '80px 24px',
        }}>
          <div style={{
            width: '48px', height: '48px', borderRadius: '12px',
            background: theme.accentLight,
            display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: '22px', marginBottom: '12px',
          }}>
            🔍
          </div>
          <h3 style={{ fontSize: '16px', fontWeight: 700, color: theme.text, marginBottom: '4px' }}>
            Ready to Scan
          </h3>
          <p style={{ fontSize: '12px', color: theme.textTertiary, maxWidth: '350px', margin: '0 auto', lineHeight: 1.5 }}>
            Click <strong>Run Scan</strong> to fetch live data and run strategies for the <strong>{activePool}</strong> pool.
          </p>
        </div>
      )}

      {/* ── Results ── */}
      {currentData && !scanning && (
        <>
          <ScanSummary data={currentData} />

          {/* ── Filters ── */}
          <div style={{
            margin: '0 24px',
            padding: '12px 16px',
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: '8px',
            marginBottom: '12px',
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '10px',
            }}>
              <span style={{
                fontSize: '11px', fontWeight: 700, color: theme.textTertiary,
                textTransform: 'uppercase', letterSpacing: '0.5px',
              }}>
                Filters
              </span>
              {hasActiveFilters && (
                <button
                  onClick={() => setFilters({
                    signal: '', cap: '', sector: '',
                    belowDmaMin: '', belowDmaMax: '',
                    fromLowMin: '', fromLowMax: '',
                    downAthMin: '', downAthMax: '',
                  })}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: theme.accent,
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Clear all
                </button>
              )}
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
              gap: '8px',
            }}>
              {/* Signal */}
              <div>
                <label style={{ fontSize: '10px', color: theme.textTertiary, fontWeight: 600, display: 'block', marginBottom: '3px' }}>Signal</label>
                <select value={filters.signal} onChange={(e) => setFilters(f => ({ ...f, signal: e.target.value }))} style={selectStyle}>
                  <option value="">All</option>
                  <option value="SIGNAL">Has Signal</option>
                  <option value="BUY_ZONE">Buy Zone</option>
                  <option value="OPPORTUNITY">Opportunity</option>
                  <option value="VALID">20% Rally ✓</option>
                  <option value="NO_SIGNAL">No Signal</option>
                  <option value="INVALID">No Rally</option>
                </select>
              </div>

              {/* Cap */}
              <div>
                <label style={{ fontSize: '10px', color: theme.textTertiary, fontWeight: 600, display: 'block', marginBottom: '3px' }}>Cap Type</label>
                <select value={filters.cap} onChange={(e) => setFilters(f => ({ ...f, cap: e.target.value }))} style={selectStyle}>
                  <option value="">All</option>
                  <option value="large">Large</option>
                  <option value="mid">Mid</option>
                  <option value="small">Small</option>
                </select>
              </div>

              {/* Sector */}
              <div>
                <label style={{ fontSize: '10px', color: theme.textTertiary, fontWeight: 600, display: 'block', marginBottom: '3px' }}>Sector</label>
                <select value={filters.sector} onChange={(e) => setFilters(f => ({ ...f, sector: e.target.value }))} style={selectStyle}>
                  <option value="">All</option>
                  {sectors.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              {/* % Below DMA */}
              <div>
                <label style={{ fontSize: '10px', color: theme.textTertiary, fontWeight: 600, display: 'block', marginBottom: '3px' }}>% Below DMA</label>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <input type="number" placeholder="Min" value={filters.belowDmaMin} onChange={(e) => setFilters(f => ({ ...f, belowDmaMin: e.target.value }))} style={inputStyle} />
                  <input type="number" placeholder="Max" value={filters.belowDmaMax} onChange={(e) => setFilters(f => ({ ...f, belowDmaMax: e.target.value }))} style={inputStyle} />
                </div>
              </div>

              {/* % From Low */}
              <div>
                <label style={{ fontSize: '10px', color: theme.textTertiary, fontWeight: 600, display: 'block', marginBottom: '3px' }}>% From Low</label>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <input type="number" placeholder="Min" value={filters.fromLowMin} onChange={(e) => setFilters(f => ({ ...f, fromLowMin: e.target.value }))} style={inputStyle} />
                  <input type="number" placeholder="Max" value={filters.fromLowMax} onChange={(e) => setFilters(f => ({ ...f, fromLowMax: e.target.value }))} style={inputStyle} />
                </div>
              </div>

              {/* % Down ATH */}
              <div>
                <label style={{ fontSize: '10px', color: theme.textTertiary, fontWeight: 600, display: 'block', marginBottom: '3px' }}>% Down ATH</label>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <input type="number" placeholder="Min" value={filters.downAthMin} onChange={(e) => setFilters(f => ({ ...f, downAthMin: e.target.value }))} style={inputStyle} />
                  <input type="number" placeholder="Max" value={filters.downAthMax} onChange={(e) => setFilters(f => ({ ...f, downAthMax: e.target.value }))} style={inputStyle} />
                </div>
              </div>
            </div>

            {hasActiveFilters && (
              <div style={{
                marginTop: '8px',
                fontSize: '11px',
                color: theme.textTertiary,
              }}>
                Showing {filteredResults.length} of {currentData.allResults?.length || 0} stocks
              </div>
            )}
          </div>

          {/* Table */}
          <ResultsTable
            allResults={filteredResults}
            errors={currentData.errors}
          />
        </>
      )}
    </div>
  );
}
