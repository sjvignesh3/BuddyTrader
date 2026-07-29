import React, { useState } from 'react';
import { useTheme } from '../context/ThemeContext';

// ─── helpers ────────────────────────────────────────────────────────────────

const RALLY_POOLS = new Set(['S200', 'PlayArea']);

// Colour for "% to Next Buy":
//   green  = stock is at or below the re-entry low (perfect entry)
//   yellow = within 10% above
//   grey   = further above (just tracking)
function pctToBuyColor(pct, theme) {
  if (pct == null) return theme.textTertiary;
  if (pct <= 0)   return theme.success;      // at / below re-entry — buy zone
  if (pct <= 10)  return theme.warning;      // within 10% above
  return theme.textSecondary;               // further away
}

// Colour for days since streak: fresher = brighter blue
function daysColor(days, theme) {
  if (days == null) return theme.textTertiary;
  if (days <= 30)  return '#58a6ff';   // ≤ 1 month — very fresh
  if (days <= 90)  return '#79c0ff';   // ≤ 3 months
  return theme.textSecondary;          // older
}

// ─── component ──────────────────────────────────────────────────────────────

export default function ResultsTable({ allResults, errors, pool }) {
  const { theme } = useTheme();
  const isRallyView = RALLY_POOLS.has(pool);

  // Default sort: rally view → days_since_last_rally asc | normal → best_score desc
  const [sortCol, setSortCol] = useState(isRallyView ? 'days_since_last_rally' : 'best_score');
  const [sortAsc, setSortAsc] = useState(isRallyView ? true : false);
  const [expandedRow, setExpandedRow] = useState(null);
  const [showErrors, setShowErrors] = useState(false);

  const handleSort = (col) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else {
      setSortCol(col);
      // days_since / pct_to_next_buy naturally sort ascending; rest descending
      setSortAsc(col === 'days_since_last_rally' || col === 'pct_to_next_buy');
    }
  };

  const sortedData = [...(allResults || [])].sort((a, b) => {
    // Push nulls to the bottom regardless of direction
    const va = a[sortCol] ?? (sortAsc ? Infinity : -Infinity);
    const vb = b[sortCol] ?? (sortAsc ? Infinity : -Infinity);
    if (typeof va === 'string' && typeof vb === 'string') {
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  // ── shared column definitions ────────────────────────────────────────────
  const BASE_COLS = [
    { key: 'symbol',                    label: 'Symbol',      align: 'left',   w: '90px'  },
    { key: 'sector',                    label: 'Sector',      align: 'left',   w: '100px' },
    { key: 'cap_type',                  label: 'Cap',         align: 'center', w: '50px'  },
    { key: 'close',                     label: 'Close ₹',     align: 'right',  w: '80px'  },
    { key: 'dma_200',                   label: '200 DMA',     align: 'right',  w: '80px'  },
    { key: 'below_200dma_pct',          label: '% Below DMA', align: 'right',  w: '85px'  },
    { key: 'low_52w',                   label: '52W Low',     align: 'right',  w: '75px'  },
    { key: 'high_52w',                  label: '52W High',    align: 'right',  w: '75px'  },
    { key: 'distance_from_52w_low_pct', label: '% From Low',  align: 'right',  w: '75px'  },
    { key: 'ath',                       label: 'ATH',         align: 'right',  w: '75px'  },
    { key: 'down_from_ath_pct',         label: '% ↓ ATH',     align: 'right',  w: '70px'  },
  ];

  // Rally-specific tail columns (replace Signal + Score)
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

  // Standard tail columns
  const STANDARD_COLS = [
    { key: 'best_status', label: 'Signal', align: 'center', w: '60px' },
    { key: 'best_score',  label: 'Score',  align: 'center', w: '50px' },
  ];

  const columns = isRallyView
    ? [...BASE_COLS, ...RALLY_COLS]
    : [...BASE_COLS, ...STANDARD_COLS];

  // ── style helpers ────────────────────────────────────────────────────────
  const thStyle = (col) => ({
    padding: '8px 10px',
    textAlign: col.align,
    background: theme.bgTertiary,
    borderBottom: `2px solid ${theme.border}`,
    fontWeight: 600,
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

  // ── shared base cells renderer ────────────────────────────────────────────
  const renderBaseCells = (row) => {
    const capStyle = getCapStyle(row.cap_type);
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
      </>
    );
  };

  // ── rally tail cells ─────────────────────────────────────────────────────
  const renderRallyCells = (row) => {
    const days = row.days_since_last_rally;
    const pct  = row.pct_to_next_buy;
    const rPct = row.last_rally_pct;

    return (
      <>
        {/* Days Since Streak End */}
        <td style={{ padding: '8px 10px', textAlign: 'right', ...monoStyle }}>
          {days != null ? (
            <span style={{
              fontWeight: 600,
              color: daysColor(days, theme),
            }}>
              {days}d
            </span>
          ) : (
            <span style={{ color: theme.textTertiary }}>—</span>
          )}
        </td>

        {/* % to Next Buy */}
        <td style={{ padding: '8px 10px', textAlign: 'right', ...monoStyle }}>
          {pct != null ? (
            <span style={{
              fontWeight: 600,
              color: pctToBuyColor(pct, theme),
            }}>
              {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
            </span>
          ) : (
            <span style={{ color: theme.textTertiary }}>—</span>
          )}
        </td>

        {/* Latest Streak / Rally % */}
        <td style={{ padding: '8px 10px', textAlign: 'right', ...monoStyle }}>
          {rPct > 0 ? (
            <span style={{
              fontWeight: 700,
              color: rPct >= 30 ? theme.success
                   : rPct >= 20 ? '#58a6ff'
                   : theme.textSecondary,
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

  // ── standard tail cells ──────────────────────────────────────────────────
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
        <td style={{
          padding: '8px 10px', textAlign: 'center',
          fontWeight: 700, fontSize: '13px',
          color: row.best_score > 0 ? theme.accent : theme.textTertiary,
        }}>
          {row.best_score}
        </td>
      </>
    );
  };

  // ── expand panel colspan ─────────────────────────────────────────────────
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
                            <div style={{
                              fontSize: '10px', fontWeight: 700, color: theme.textTertiary,
                              textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px',
                            }}>
                              Strategy Details
                            </div>
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
    </div>
  );
}
