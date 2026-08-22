import React, { useState, useEffect, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';
import { getFundamentalsFromCache } from '../services/api';

// ─── helpers ────────────────────────────────────────────────────────────────

const RALLY_POOLS = new Set(['S200', 'PlayArea']);

function pctToBuyColor(pct, theme) {
  if (pct == null) return theme.textTertiary;
  if (pct <= 0)   return theme.success;
  if (pct <= 10)  return theme.warning;
  return theme.textSecondary;
}

function daysColor(days, theme) {
  if (days == null) return theme.textTertiary;
  if (days <= 30)  return '#58a6ff';
  if (days <= 90)  return '#79c0ff';
  return theme.textSecondary;
}

// ─── Score badge ─────────────────────────────────────────────────────────
const MAX_SCORE = 11;

function ScoreBadge({ points, max = MAX_SCORE, theme, notInCache = false }) {
  if (notInCache) {
    return (
      <span style={{
        fontSize: '11px', color: theme.textTertiary,
        fontFamily: "'SF Mono','Fira Code','Consolas',monospace",
      }}>—</span>
    );
  }
  if (points == null) {
    return (
      <span style={{
        fontSize: '10px', color: theme.textTertiary,
        fontFamily: "'SF Mono','Fira Code','Consolas',monospace",
      }}>…</span>
    );
  }
  const color = points >= 8 ? '#3fb950'
              : points >= 6 ? '#d29922'
              : '#f85149';
  const bg    = points >= 8 ? '#1f883d22'
              : points >= 6 ? '#d2992222'
              : '#da363322';
  return (
    <span style={{
      fontSize: '12px', fontWeight: 700,
      padding: '3px 8px', borderRadius: '5px',
      background: bg, color,
      fontFamily: "'SF Mono','Fira Code','Consolas',monospace",
      whiteSpace: 'nowrap',
      letterSpacing: '0.3px',
    }}>
      {points}<span style={{ fontWeight: 400, opacity: 0.7 }}>/{max}</span>
    </span>
  );
}

// ─── Fundamental Details Panel ───────────────────────────────────────────
function FundamentalDetails({ symbol, fundamentalData, notInCache, theme }) {
  const [isOpen, setIsOpen] = useState(false);

  // Still loading (fd === undefined in parent) — show nothing yet
  if (!fundamentalData && !notInCache) {
    return null;
  }

  // Symbol is not in cache
  if (!fundamentalData && notInCache) {
    return (
      <div style={{
        marginTop: '10px',
        padding: '10px 14px',
        background: theme.bgCard,
        borderRadius: '6px',
        border: `1px solid ${theme.border}`,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          fontSize: '11px', fontWeight: 700,
          color: theme.textTertiary,
          textTransform: 'uppercase', letterSpacing: '0.5px',
        }}>
          <span>📊</span>
          <span>Fundamental Details</span>
          <span style={{
            fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '3px',
            background: theme.bgTertiary, color: theme.textTertiary,
            marginLeft: '4px',
          }}>
            NOT IN CACHE
          </span>
        </div>
        <div style={{ fontSize: '10px', color: theme.textTertiary, marginTop: '6px' }}>
          No fundamental data cached for <strong>{symbol}</strong>. Run the Screener for this stock to populate the cache.
        </div>
      </div>
    );
  }

  const { data, points, points_max, checks } = fundamentalData;
  const monoFont = { fontFamily: "'SF Mono','Fira Code','Consolas',monospace" };
  const passColor  = '#3fb950';
  const failColor  = '#f85149';
  const naColor    = theme.textTertiary;
  const ptColor    = points >= 8 ? passColor : points >= 6 ? '#d29922' : failColor;

  // Group metrics for the top summary row
  const metrics = [
    { label: 'PE',         value: data.current_pe    != null ? data.current_pe.toFixed(1)          : '—', unit: '' },
    { label: '5yr Avg PE', value: data.pe_5yr_avg    != null ? data.pe_5yr_avg.toFixed(1)          : '—', unit: '' },
    { label: 'PB',         value: data.current_pb    != null ? data.current_pb.toFixed(2)          : '—', unit: '' },
    { label: '5yr Avg PB', value: data.pb_5yr_avg    != null ? data.pb_5yr_avg.toFixed(2)          : '—', unit: '' },
    { label: 'ROCE',       value: data.roce           != null ? data.roce.toFixed(1)               : '—', unit: '%' },
    { label: 'ROE',        value: data.roe            != null ? data.roe.toFixed(1)                : '—', unit: '%' },
    { label: 'ND/Eq',      value: data.net_debt_to_equity != null ? data.net_debt_to_equity.toFixed(2) : '—', unit: '' },
    { label: 'Pledging',   value: data.pledging       != null ? data.pledging.toFixed(1)           : '—', unit: '%' },
    { label: 'OPM',        value: data.latest_opm     != null ? data.latest_opm.toFixed(1)        : '—', unit: '%' },
  ];

  return (
    <div style={{
      marginTop: '10px',
      border: `1px solid ${theme.border}`,
      borderRadius: '6px',
      overflow: 'hidden',
      background: theme.bgCard,
    }}>
      {/* Accordion header */}
      <button
        onClick={() => setIsOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
          padding: '9px 14px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '13px' }}>📊</span>
        <span style={{
          fontSize: '11px', fontWeight: 700, color: theme.textSecondary,
          textTransform: 'uppercase', letterSpacing: '0.5px', flex: 1,
        }}>
          Fundamental Details
        </span>
        {/* Score badge inline */}
        <span style={{
          fontSize: '11px', fontWeight: 700, padding: '2px 9px', borderRadius: '4px',
          background: ptColor + '22', color: ptColor,
          ...monoFont,
        }}>
          {points}<span style={{ fontWeight: 400, opacity: 0.7 }}>/{points_max}</span>
          {' '}pts
        </span>
        {!data.auth_available && (
          <span style={{
            fontSize: '9px', fontWeight: 600, padding: '1px 5px', borderRadius: '3px',
            background: '#d2992218', color: '#d29922', marginLeft: '4px',
          }}>
            PUBLIC ONLY
          </span>
        )}
        <span style={{
          fontSize: '10px', color: theme.textTertiary, marginLeft: '4px',
          transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
          display: 'inline-block',
        }}>▼</span>
      </button>

      {/* Accordion body */}
      {isOpen && (
        <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${theme.borderLight}` }}>
          {/* ── Key metrics summary row ── */}
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '6px',
            padding: '10px 0 8px',
            borderBottom: `1px solid ${theme.borderLight}`,
            marginBottom: '10px',
          }}>
            {metrics.map(m => (
              <div key={m.label} style={{
                background: theme.bgTertiary,
                borderRadius: '5px', padding: '5px 10px',
                minWidth: '70px', textAlign: 'center',
              }}>
                <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textTertiary, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '2px' }}>
                  {m.label}
                </div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: theme.text, ...monoFont }}>
                  {m.value}{m.unit && m.value !== '—' ? m.unit : ''}
                </div>
              </div>
            ))}
          </div>

          {/* ── Quarterly ATH data ── */}
          {(data.latest_sales != null || data.latest_profit != null || data.latest_pbt != null) && (
            <div style={{
              display: 'flex', gap: '8px', flexWrap: 'wrap',
              marginBottom: '10px',
            }}>
              {data.latest_sales != null && (
                <div style={{
                  fontSize: '10px', color: theme.textSecondary,
                  background: theme.bgTertiary, borderRadius: '4px',
                  padding: '4px 10px',
                }}>
                  <span style={{ color: theme.textTertiary, fontWeight: 600 }}>Latest Q Sales: </span>
                  <span style={{ ...monoFont, fontWeight: 700, color: theme.text }}>
                    {data.latest_sales.toLocaleString()}
                  </span>
                  {data.ath_sales != null && (
                    <span style={{ color: theme.textTertiary }}>
                      {' '}/ ATH {data.ath_sales.toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              {data.latest_pbt != null && (
                <div style={{
                  fontSize: '10px', color: theme.textSecondary,
                  background: theme.bgTertiary, borderRadius: '4px',
                  padding: '4px 10px',
                }}>
                  <span style={{ color: theme.textTertiary, fontWeight: 600 }}>Latest Q PBT: </span>
                  <span style={{ ...monoFont, fontWeight: 700, color: theme.text }}>
                    {data.latest_pbt.toLocaleString()}
                  </span>
                  {data.ath_pbt != null && (
                    <span style={{ color: theme.textTertiary }}>
                      {' '}/ ATH {data.ath_pbt.toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              {data.latest_profit != null && (
                <div style={{
                  fontSize: '10px', color: theme.textSecondary,
                  background: theme.bgTertiary, borderRadius: '4px',
                  padding: '4px 10px',
                }}>
                  <span style={{ color: theme.textTertiary, fontWeight: 600 }}>Latest Q Net Profit: </span>
                  <span style={{ ...monoFont, fontWeight: 700, color: theme.text }}>
                    {data.latest_profit.toLocaleString()}
                  </span>
                  {data.ath_profit != null && (
                    <span style={{ color: theme.textTertiary }}>
                      {' '}/ ATH {data.ath_profit.toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              {data.promoter_holding != null && (
                <div style={{
                  fontSize: '10px', color: theme.textSecondary,
                  background: theme.bgTertiary, borderRadius: '4px',
                  padding: '4px 10px',
                }}>
                  <span style={{ color: theme.textTertiary, fontWeight: 600 }}>Promoter Holding: </span>
                  <span style={{ ...monoFont, fontWeight: 700, color: theme.text }}>
                    {data.promoter_holding.toFixed(1)}%
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ── 11 Fundamental checks ── */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: '5px',
          }}>
            {checks.map((chk, i) => {
              const isPassed  = chk.passed === true;
              const isFailed  = chk.passed === false;
              const isUnknown = chk.passed === null;

              const borderColor = isUnknown ? theme.border
                                : isPassed  ? '#3fb95040'
                                : '#f8514940';
              const bgColor = isUnknown ? theme.bgTertiary
                            : isPassed  ? '#1f883d12'
                            : '#da363312';
              const iconEl = isUnknown ? '❓'
                           : isPassed  ? '✅'
                           : '❌';
              const statusColor = isUnknown ? naColor : isPassed ? passColor : failColor;

              return (
                <div key={chk.id || i} style={{
                  display: 'flex', alignItems: 'flex-start', gap: '8px',
                  padding: '7px 10px',
                  background: bgColor,
                  borderRadius: '5px',
                  border: `1px solid ${borderColor}`,
                }}>
                  <span style={{ fontSize: '11px', flexShrink: 0, marginTop: '1px' }}>{iconEl}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: '11px', fontWeight: 600, color: theme.text,
                      marginBottom: '2px',
                    }}>
                      {`${i + 1}. ${chk.label}`}
                    </div>
                    <div style={{ fontSize: '10px', color: theme.textSecondary, lineHeight: 1.4 }}>
                      {chk.detail}
                    </div>
                  </div>
                  <span style={{
                    fontSize: '8px', fontWeight: 700, flexShrink: 0,
                    padding: '1px 5px', borderRadius: '3px',
                    background: isUnknown ? theme.bgTertiary : (isPassed ? '#1f883d22' : '#da363322'),
                    color: statusColor,
                    textTransform: 'uppercase',
                    alignSelf: 'flex-start',
                  }}>
                    {isUnknown ? 'N/A' : isPassed ? 'PASS' : 'FAIL'}
                  </span>
                </div>
              );
            })}
          </div>

          {!data.auth_available && (
            <div style={{
              marginTop: '8px', fontSize: '10px', color: '#d29922',
              padding: '5px 10px', background: '#d2992210',
              borderRadius: '4px', border: '1px solid #d2992225',
            }}>
              ⚠ Partial data only — ROCE, ROE, Pledging, Quarterly results require authenticated screener access.
              Run the Screener with valid credentials to get full data.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

export default function ResultsTable({ allResults, errors, pool }) {
  const { theme } = useTheme();
  const isRallyView = RALLY_POOLS.has(pool);

  const [sortCol, setSortCol] = useState(isRallyView ? 'days_since_last_rally' : 'fundamental_points');
  const [sortAsc, setSortAsc] = useState(isRallyView ? true : false); // false = DESC for score (highest first)
  const [expandedRow, setExpandedRow] = useState(null);
  const [showErrors, setShowErrors] = useState(false);

  // Fundamental data from cache: { [symbol]: { found, data, points, checks } | null }
  const [fundamentals, setFundamentals] = useState({});
  const fetchedSymbolsRef = useRef(new Set());

  // Fetch fundamentals from cache whenever results change
  useEffect(() => {
    if (!allResults || allResults.length === 0) return;

    const symbols = allResults.map(r => r.symbol);
    const toFetch = symbols.filter(s => !fetchedSymbolsRef.current.has(s));
    if (toFetch.length === 0) return;

    toFetch.forEach(s => fetchedSymbolsRef.current.add(s));

    getFundamentalsFromCache(toFetch)
      .then(resp => {
        setFundamentals(prev => {
          const next = { ...prev };
          for (const [sym, val] of Object.entries(resp.results || {})) {
            next[sym] = val;
          }
          return next;
        });
      })
      .catch(() => {
        // silently ignore — fundamentals are optional enrichment
      });
  }, [allResults]);

  // When pool changes, reset state so new pool fetches fresh
  useEffect(() => {
    setFundamentals({});
    fetchedSymbolsRef.current = new Set();
    setExpandedRow(null);
  }, [pool]);

  const handleSort = (col) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else {
      setSortCol(col);
      // fundamental_points: default DESC (highest score first)
      // days/pct: default ASC (smallest first)
      setSortAsc(col === 'days_since_last_rally' || col === 'pct_to_next_buy');
    }
  };

  const sortedData = [...(allResults || [])].sort((a, b) => {
    let va, vb;
    if (sortCol === 'fundamental_points') {
      // Null / not-in-cache always goes to the bottom regardless of sort direction
      const pa = fundamentals[a.symbol]?.found ? (fundamentals[a.symbol]?.points ?? null) : null;
      const pb = fundamentals[b.symbol]?.found ? (fundamentals[b.symbol]?.points ?? null) : null;
      if (pa === null && pb === null) return 0;
      if (pa === null) return 1;
      if (pb === null) return -1;
      return sortAsc ? pa - pb : pb - pa;
    } else {
      va = a[sortCol] ?? (sortAsc ? Infinity : -Infinity);
      vb = b[sortCol] ?? (sortAsc ? Infinity : -Infinity);
    }
    if (typeof va === 'string' && typeof vb === 'string') {
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  // ── Column definitions ────────────────────────────────────────────────────
  const BASE_COLS = [
    { key: 'symbol',                    label: 'Symbol',           align: 'left',   w: '90px'  },
    { key: 'sector',                    label: 'Sector',           align: 'left',   w: '100px' },
    { key: 'cap_type',                  label: 'Cap',              align: 'center', w: '50px'  },
    { key: 'close',                     label: 'Close ₹',          align: 'right',  w: '80px'  },
    { key: 'dma_200',                   label: '200 DMA',          align: 'right',  w: '80px'  },
    { key: 'below_200dma_pct',          label: '% Below DMA',      align: 'right',  w: '85px'  },
    { key: 'low_52w',                   label: '52W Low',          align: 'right',  w: '75px'  },
    { key: 'high_52w',                  label: '52W High',         align: 'right',  w: '75px'  },
    { key: 'distance_from_52w_low_pct', label: '% From Low',       align: 'right',  w: '75px'  },
    { key: 'ath',                       label: 'ATH',              align: 'right',  w: '75px'  },
    { key: 'down_from_ath_pct',         label: '% ↓ ATH',          align: 'right',  w: '70px'  },
    // Last N-Day Trend column
    {
      key:   'price_change_nd_pct',
      label: 'Last Week Trend',
      align: 'right',
      w:     '105px',
      tip:   'Price % change over the configured trend window (default 7 trading days). Green = gainer, Red = loser. Sort to find Top Gainers / Top Losers.',
    },
    // Score column
    {
      key:   'fundamental_points',
      label: 'Score (out of 11)',
      align: 'center',
      w:     '110px',
      tip:   'Fundamental score: how many of 11 key criteria pass (from screener cache). Click to sort.',
    },
  ];

  const RALLY_COLS = [
    {
      key:   'days_since_last_rally',
      label: 'Days Since Streak',
      align: 'right',
      w:     '105px',
      tip:   'Trading days since the last qualifying 20%+ green streak ended',
    },
    {
      key:   'pct_to_next_buy',
      label: '% to Next Buy',
      align: 'right',
      w:     '100px',
      tip:   'How far the current price is above the re-entry low of the last streak.\n≤0 = already at/below buy level',
    },
    {
      key:   'last_rally_pct',
      label: 'Streak %',
      align: 'right',
      w:     '80px',
      tip:   'Rally % of the most recent qualifying streak (High-to-Low within streak)',
    },
  ];

  const STANDARD_COLS = [
    { key: 'best_status', label: 'Signal', align: 'center', w: '60px' },
  ];

  const columns = isRallyView
    ? [...BASE_COLS, ...RALLY_COLS]
    : [...BASE_COLS, ...STANDARD_COLS];

  // ── Style helpers ─────────────────────────────────────────────────────────
  const thStyle = (col) => ({
    padding: '8px 10px',
    textAlign: col.align,
    background: theme.bgTertiary,
    borderBottom: `2px solid ${theme.border}`,
    fontWeight: 700,
    color: sortCol === col.key ? theme.accent : theme.textTertiary,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.4px',
    transition: 'color 0.1s',
    minWidth: col.w,
    position: 'sticky',
    top: 0,
    zIndex: 2,
    title: col.tip || undefined,
  });

  const monoStyle = {
    fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
    fontSize: '11.5px',
  };

  const getStatusStyle = (status) => {
    switch (status) {
      case 'BUY_ZONE':    return { bg: theme.successLight, color: theme.successDark, label: 'BUY' };
      case 'OPPORTUNITY': return { bg: theme.warningLight,  color: theme.warningDark,  label: 'OPP' };
      case 'VALID':       return { bg: '#1f6feb22',          color: '#58a6ff',           label: 'RALLY' };
      case 'INVALID':     return { bg: theme.bgTertiary,    color: theme.textTertiary,  label: '—' };
      default:            return { bg: theme.bgTertiary,    color: theme.textTertiary,  label: '—' };
    }
  };

  const getCapStyle = (cap) => {
    const lower = (cap || '').toLowerCase();
    if (lower.includes('large')) return { bg: theme.badge.large + '15', color: theme.badge.large, text: 'LRG' };
    if (lower.includes('mid'))   return { bg: theme.badge.mid   + '15', color: theme.badge.mid,   text: 'MID' };
    if (lower.includes('small')) return { bg: theme.badge.small + '15', color: theme.badge.small, text: 'SML' };
    return { bg: theme.bgTertiary, color: theme.textTertiary, text: cap || '—' };
  };

  // ── Base cells ────────────────────────────────────────────────────────────
  const renderBaseCells = (row) => {
    const capStyle = getCapStyle(row.cap_type);
    const fd = fundamentals[row.symbol];
    const notInCache = fd && !fd.found;
    const points = fd?.found ? fd.points : null;

    return (
      <>
        {/* Symbol */}
        <td style={{ padding: '8px 10px', fontWeight: 600, color: theme.text, fontSize: '12px' }}>
          {row.symbol}
        </td>
        {/* Sector */}
        <td style={{
          padding: '8px 10px', color: theme.textSecondary, fontSize: '11px',
          maxWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {row.sector || '—'}
        </td>
        {/* Cap */}
        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
          <span style={{
            fontSize: '9px', fontWeight: 600, padding: '2px 5px',
            borderRadius: '3px', background: capStyle.bg, color: capStyle.color,
          }}>
            {capStyle.text}
          </span>
        </td>
        {/* Close */}
        <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 500, color: theme.text, ...monoStyle }}>
          {row.close?.toFixed(2)}
        </td>
        {/* 200 DMA */}
        <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
          {row.dma_200?.toFixed(2)}
        </td>
        {/* % Below DMA */}
        <td style={{
          padding: '8px 10px', textAlign: 'right', fontWeight: 600, ...monoStyle,
          color: row.below_200dma_pct > 0 ? theme.success : theme.danger,
        }}>
          {row.below_200dma_pct?.toFixed(1)}%
        </td>
        {/* 52W Low */}
        <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
          {row.low_52w?.toFixed(2)}
        </td>
        {/* 52W High */}
        <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
          {row.high_52w?.toFixed(2)}
        </td>
        {/* % From Low */}
        <td style={{
          padding: '8px 10px', textAlign: 'right', ...monoStyle,
          fontWeight: row.distance_from_52w_low_pct <= 5 ? 600 : 400,
          color: row.distance_from_52w_low_pct <= 5 ? theme.success : theme.textSecondary,
        }}>
          {row.distance_from_52w_low_pct?.toFixed(1)}%
        </td>
        {/* ATH */}
        <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
          {row.ath?.toFixed(2)}
        </td>
        {/* % ↓ ATH */}
        <td style={{
          padding: '8px 10px', textAlign: 'right', fontWeight: 600, ...monoStyle,
          color: row.down_from_ath_pct >= 30 ? theme.success
               : row.down_from_ath_pct >= 15 ? theme.warning
               : theme.textTertiary,
        }}>
          {row.down_from_ath_pct?.toFixed(1)}%
        </td>
        {/* Last Week Trend */}
        <td style={{ padding: '8px 10px', textAlign: 'right', ...monoStyle }}>
          {row.price_change_nd_pct != null ? (
            <span style={{
              fontWeight: 700,
              color: row.price_change_nd_pct > 3  ? theme.success
                   : row.price_change_nd_pct > 0  ? '#3fb95099'
                   : row.price_change_nd_pct > -3 ? '#f8514999'
                   : theme.danger,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '2px',
            }}>
              <span style={{ fontSize: '9px' }}>
                {row.price_change_nd_pct > 0 ? '▲' : row.price_change_nd_pct < 0 ? '▼' : '▶'}
              </span>
              {row.price_change_nd_pct > 0 ? '+' : ''}{row.price_change_nd_pct.toFixed(2)}%
            </span>
          ) : (
            <span style={{ color: theme.textTertiary }}>—</span>
          )}
        </td>
        {/* Score (out of 11) */}
        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
          <ScoreBadge
            points={points}
            max={MAX_SCORE}
            theme={theme}
            notInCache={notInCache}
          />
        </td>
      </>
    );
  };

  // ── Rally tail cells ─────────────────────────────────────────────────────
  const renderRallyCells = (row) => {
    const days = row.days_since_last_rally;
    const pct  = row.pct_to_next_buy;
    const rPct = row.last_rally_pct;

    return (
      <>
        <td style={{ padding: '8px 10px', textAlign: 'right', ...monoStyle }}>
          {days != null ? (
            <span style={{ fontWeight: 600, color: daysColor(days, theme) }}>
              {days}d
            </span>
          ) : (
            <span style={{ color: theme.textTertiary }}>—</span>
          )}
        </td>
        <td style={{ padding: '8px 10px', textAlign: 'right', ...monoStyle }}>
          {pct != null ? (
            <span style={{ fontWeight: 600, color: pctToBuyColor(pct, theme) }}>
              {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
            </span>
          ) : (
            <span style={{ color: theme.textTertiary }}>—</span>
          )}
        </td>
        <td style={{ padding: '8px 10px', textAlign: 'right', ...monoStyle }}>
          {rPct > 0 ? (
            <span style={{
              fontWeight: 700,
              color: rPct >= 30 ? theme.success : rPct >= 20 ? '#58a6ff' : theme.textSecondary,
            }}>
              {rPct.toFixed(1)}%
            </span>
          ) : (
            <span style={{ color: theme.textTertiary }}>—</span>
          )}
        </td>
      </>
    );
  };

  // ── Standard tail cells ──────────────────────────────────────────────────
  const renderStandardCells = (row) => {
    const statusStyle = getStatusStyle(row.best_status);
    return (
      <>
        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
          <span style={{
            padding: '2px 7px', borderRadius: '3px',
            fontSize: '9px', fontWeight: 700,
            background: statusStyle.bg, color: statusStyle.color,
            letterSpacing: '0.3px',
          }}>
            {statusStyle.label}
          </span>
        </td>
      </>
    );
  };

  const colSpan = columns.length;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '0 24px 24px' }}>

      {/* Error toggle */}
      {errors?.length > 0 && (
        <div style={{ marginBottom: '8px' }}>
          <button
            onClick={() => setShowErrors(!showErrors)}
            style={{
              background: theme.dangerLight,
              border: `1px solid ${theme.danger}20`,
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 600,
              color: theme.danger,
            }}
          >
            {showErrors ? 'Hide' : 'Show'} {errors.length} Error{errors.length > 1 ? 's' : ''}
          </button>
          {showErrors && (
            <div style={{
              marginTop: '6px', padding: '10px 14px',
              background: theme.bgCard,
              border: `1px solid ${theme.border}`,
              borderRadius: '6px',
            }}>
              {errors.map((e, i) => (
                <div key={i} style={{
                  padding: '5px 0', fontSize: '12px', color: theme.text,
                  borderBottom: i < errors.length - 1 ? `1px solid ${theme.divider}` : 'none',
                }}>
                  <strong>{e.symbol}</strong>
                  <span style={{ color: theme.textTertiary, margin: '0 6px' }}>→</span>
                  <span style={{ color: theme.danger }}>{e.error}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Rally view legend ── */}
      {isRallyView && (
        <div style={{
          marginBottom: '8px',
          display: 'flex',
          gap: '16px',
          flexWrap: 'wrap',
          fontSize: '11px',
          color: theme.textTertiary,
          padding: '8px 12px',
          background: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: '6px',
        }}>
          <span style={{ fontWeight: 600, color: theme.textSecondary }}>Legend:</span>
          <span><span style={{ color: '#58a6ff', fontWeight: 700 }}>Days Since Streak</span> — trading days since the last 20%+ green streak ended</span>
          <span><span style={{ color: theme.success, fontWeight: 700 }}>% to Next Buy ≤ 0</span> = price at/below re-entry · <span style={{ color: theme.warning, fontWeight: 700 }}>≤ +10%</span> = watch zone</span>
          <span><span style={{ color: '#58a6ff', fontWeight: 700 }}>Streak %</span> — magnitude of the last qualifying rally</span>
          <span>
            <span style={{ fontWeight: 700, color: '#58a6ff' }}>Score (out of 11)</span>
            {' '}— fundamental score from screener cache · <span style={{ color: theme.textTertiary }}>— = not cached</span>
          </span>
          <span>
            <span style={{ color: theme.success, fontWeight: 700 }}>▲ Last Week Trend</span>
            {' '}— % price move vs N trading days ago · sort ▲▼ to find Top Gainers / Top Losers
          </span>
        </div>
      )}

      {/* Table */}
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
                {columns.map((col) => (
                  <th
                    key={col.key}
                    style={thStyle(col)}
                    onClick={() => handleSort(col.key)}
                    title={col.tip}
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
              {sortedData.map((row, idx) => {
                const isExpanded = expandedRow === idx;
                const fd = fundamentals[row.symbol];

                return (
                  <React.Fragment key={row.symbol + idx}>
                    <tr
                      style={{
                        background: isExpanded
                          ? theme.accentLight
                          : idx % 2 === 0 ? 'transparent' : theme.tableRowAlt,
                        cursor: 'pointer',
                        transition: 'background 0.08s',
                        borderBottom: `1px solid ${theme.borderLight}`,
                      }}
                      onClick={() => setExpandedRow(isExpanded ? null : idx)}
                      onMouseEnter={(e) => {
                        if (!isExpanded) e.currentTarget.style.background = theme.tableRowHover;
                      }}
                      onMouseLeave={(e) => {
                        if (!isExpanded) e.currentTarget.style.background =
                          idx % 2 === 0 ? 'transparent' : theme.tableRowAlt;
                      }}
                    >
                      {renderBaseCells(row)}
                      {isRallyView ? renderRallyCells(row) : renderStandardCells(row)}
                    </tr>

                    {/* ── Expanded detail panel ── */}
                    {isExpanded && (
                      <tr>
                        <td colSpan={colSpan} style={{
                          padding: 0,
                          borderBottom: `2px solid ${theme.accent}30`,
                        }}>
                          <div style={{ padding: '12px 16px', background: theme.bgTertiary }}>
                            {/* Strategy Details header */}
                            <div style={{
                              fontSize: '10px', fontWeight: 700, color: theme.textTertiary,
                              textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px',
                            }}>
                              Strategy Details
                            </div>

                            {/* Strategy accordion cards */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                              {row.strategy_results?.map((sr, i) => {
                                const sStyle = getStatusStyle(sr.status);
                                const isRally = sr.strategy_id === 'rally_20_percent';
                                return (
                                  <div key={i} style={{
                                    padding: '8px 12px',
                                    background: theme.bgCard,
                                    borderRadius: '6px',
                                    border: `1px solid ${isRally && sr.status === 'VALID'
                                      ? '#58a6ff40' : theme.border}`,
                                  }}>
                                    <div style={{
                                      display: 'flex', alignItems: 'center',
                                      gap: '8px', marginBottom: '3px',
                                    }}>
                                      <span style={{ fontWeight: 600, color: theme.text, fontSize: '12px' }}>
                                        {sr.strategy_name}
                                      </span>
                                      <span style={{
                                        padding: '1px 5px', borderRadius: '3px',
                                        fontSize: '9px', fontWeight: 700,
                                        background: sStyle.bg, color: sStyle.color,
                                      }}>
                                        {sr.status}
                                      </span>
                                      <span style={{ fontSize: '11px', color: theme.textTertiary, fontWeight: 500 }}>
                                        Score: {sr.score}
                                      </span>
                                    </div>
                                    <div style={{ fontSize: '11px', color: theme.textSecondary, lineHeight: 1.5 }}>
                                      {sr.reasons?.map((r, j) => <div key={j}>• {r}</div>)}
                                    </div>

                                    {/* Rally price levels */}
                                    {isRally && sr.status === 'VALID' && (
                                      <div style={{
                                        marginTop: '8px',
                                        display: 'flex', gap: '8px', flexWrap: 'wrap',
                                      }}>
                                        <span style={{
                                          padding: '3px 8px', borderRadius: '4px',
                                          background: '#1f883d22', color: '#3fb950',
                                          fontSize: '11px', fontWeight: 600,
                                          fontFamily: "'SF Mono', 'Fira Code', monospace",
                                        }}>
                                          📥 Next Buy: ₹{sr.next_buy_at?.toFixed(2)}
                                        </span>
                                        <span style={{
                                          padding: '3px 8px', borderRadius: '4px',
                                          background: '#da363322', color: '#f85149',
                                          fontSize: '11px', fontWeight: 600,
                                          fontFamily: "'SF Mono', 'Fira Code', monospace",
                                        }}>
                                          📤 Next Sell: ₹{sr.next_sell_at?.toFixed(2)}
                                        </span>
                                        {sr.days_since_last_rally != null && (
                                          <span style={{
                                            padding: '3px 8px', borderRadius: '4px',
                                            background: '#58a6ff18', color: '#79c0ff',
                                            fontSize: '11px', fontWeight: 500,
                                          }}>
                                            🕒 {sr.days_since_last_rally}d ago
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>

                            {/* ── Fundamental Details accordion ── */}
                            <FundamentalDetails
                              symbol={row.symbol}
                              fundamentalData={
                                fd === undefined
                                  ? null  // still loading → show nothing special yet
                                  : fd.found
                                    ? fd
                                    : null  // not in cache
                              }
                              notInCache={fd !== undefined && !fd.found}
                              theme={theme}
                            />
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

        {sortedData.length === 0 && (
          <div style={{
            padding: '40px', textAlign: 'center',
            color: theme.textTertiary, fontSize: '13px',
          }}>
            No stocks match the current filters.
          </div>
        )}
      </div>

      {/* ── Score + Trend legend ── */}
      <div style={{
        marginTop: '8px', fontSize: '10px', color: theme.textTertiary,
        display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
        padding: '6px 10px',
        background: 'rgba(88, 166, 255, 0.04)',
        border: '1px solid rgba(88, 166, 255, 0.12)',
        borderRadius: '6px',
      }}>
        <span style={{ fontWeight: 700, color: '#58a6ff' }}>Score legend:</span>
        <span>
          <span style={{ color: '#3fb950', fontWeight: 700 }}>8–11</span>
          {' '}= Strong fundamentals
        </span>
        <span>
          <span style={{ color: '#d29922', fontWeight: 700 }}>6–7</span>
          {' '}= Moderate
        </span>
        <span>
          <span style={{ color: '#f85149', fontWeight: 700 }}>0–5</span>
          {' '}= Weak
        </span>
        <span>
          <span style={{ fontWeight: 700 }}>—</span>
          {' '}= Not in screener cache · run Screener to populate
        </span>
        <span style={{ borderLeft: '1px solid rgba(88,166,255,0.2)', paddingLeft: '10px' }}>
          <span style={{ fontWeight: 700, color: '#58a6ff' }}>Last Week Trend:</span>
          {' '}
          <span style={{ color: '#3fb950', fontWeight: 700 }}>▲ green</span> = gainer ·{' '}
          <span style={{ color: '#f85149', fontWeight: 700 }}>▼ red</span> = loser · sort to find Top Gainers / Top Losers
        </span>
        <span style={{ marginLeft: 'auto', color: '#58a6ff', fontWeight: 600 }}>
          ↕ Click column header to sort
        </span>
      </div>
    </div>
  );
}
