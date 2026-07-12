import React, { useState } from 'react';
import { useTheme } from '../context/ThemeContext';

export default function ResultsTable({ allResults, errors }) {
  const { theme } = useTheme();
  const [sortCol, setSortCol] = useState('best_score');
  const [sortAsc, setSortAsc] = useState(false);
  const [expandedRow, setExpandedRow] = useState(null);
  const [showErrors, setShowErrors] = useState(false);

  const handleSort = (col) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(false); }
  };

  const sortedData = [...(allResults || [])].sort((a, b) => {
    const va = a[sortCol] ?? 0;
    const vb = b[sortCol] ?? 0;
    if (typeof va === 'string' && typeof vb === 'string') {
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  const getStatusStyle = (status) => {
    switch (status) {
      case 'BUY_ZONE':
        return { bg: theme.successLight, color: theme.successDark, label: 'BUY' };
      case 'OPPORTUNITY':
        return { bg: theme.warningLight, color: theme.warningDark, label: 'OPP' };
      default:
        return { bg: theme.bgTertiary, color: theme.textTertiary, label: '—' };
    }
  };

  const getCapStyle = (cap) => {
    const lower = (cap || '').toLowerCase();
    if (lower.includes('large')) return { bg: theme.badge.large + '15', color: theme.badge.large, text: 'LRG' };
    if (lower.includes('mid'))   return { bg: theme.badge.mid + '15', color: theme.badge.mid, text: 'MID' };
    if (lower.includes('small')) return { bg: theme.badge.small + '15', color: theme.badge.small, text: 'SML' };
    return { bg: theme.bgTertiary, color: theme.textTertiary, text: cap || '—' };
  };

  const columns = [
    { key: 'symbol',                   label: 'Symbol',       align: 'left',   w: '90px'  },
    { key: 'sector',                   label: 'Sector',       align: 'left',   w: '100px' },
    { key: 'cap_type',                 label: 'Cap',          align: 'center', w: '55px'  },
    { key: 'close',                    label: 'Close ₹',      align: 'right',  w: '80px'  },
    { key: 'dma_200',                  label: '200 DMA',      align: 'right',  w: '80px'  },
    { key: 'below_200dma_pct',         label: '% Below DMA',  align: 'right',  w: '85px'  },
    { key: 'low_52w',                  label: '52W Low',      align: 'right',  w: '80px'  },
    { key: 'high_52w',                 label: '52W High',     align: 'right',  w: '80px'  },
    { key: 'distance_from_52w_low_pct',label: '% From Low',   align: 'right',  w: '75px'  },
    { key: 'ath',                      label: 'ATH',          align: 'right',  w: '80px'  },
    { key: 'down_from_ath_pct',        label: '% ↓ ATH',      align: 'right',  w: '70px'  },
    { key: 'best_status',             label: 'Signal',       align: 'center', w: '60px'  },
    { key: 'best_score',              label: 'Score',        align: 'center', w: '50px'  },
  ];

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
  });

  const monoStyle = {
    fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
    fontSize: '11.5px',
  };

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
              marginTop: '6px',
              padding: '10px 14px',
              background: theme.bgCard,
              border: `1px solid ${theme.border}`,
              borderRadius: '6px',
            }}>
              {errors.map((e, i) => (
                <div key={i} style={{
                  padding: '5px 0',
                  fontSize: '12px',
                  color: theme.text,
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

      {/* Table */}
      <div style={{
        border: `1px solid ${theme.border}`,
        borderRadius: '8px',
        background: theme.bgCard,
        overflow: 'hidden',
        boxShadow: theme.shadow,
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '12px',
          }}>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    style={thStyle(col)}
                    onClick={() => handleSort(col.key)}
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
                const statusStyle = getStatusStyle(row.best_status);
                const capStyle = getCapStyle(row.cap_type);
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
                        if (!isExpanded) e.currentTarget.style.background = idx % 2 === 0 ? 'transparent' : theme.tableRowAlt;
                      }}
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
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 500, color: theme.text, ...monoStyle }}>
                        {row.close?.toFixed(2)}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
                        {row.dma_200?.toFixed(2)}
                      </td>
                      <td style={{
                        padding: '8px 10px', textAlign: 'right', fontWeight: 600, ...monoStyle,
                        color: row.below_200dma_pct > 0 ? theme.success : theme.danger,
                      }}>
                        {row.below_200dma_pct?.toFixed(1)}%
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
                        {row.low_52w?.toFixed(2)}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
                        {row.high_52w?.toFixed(2)}
                      </td>
                      <td style={{
                        padding: '8px 10px', textAlign: 'right', ...monoStyle,
                        fontWeight: row.distance_from_52w_low_pct <= 5 ? 600 : 400,
                        color: row.distance_from_52w_low_pct <= 5 ? theme.success : theme.textSecondary,
                      }}>
                        {row.distance_from_52w_low_pct?.toFixed(1)}%
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: theme.textSecondary, ...monoStyle }}>
                        {row.ath?.toFixed(2)}
                      </td>
                      <td style={{
                        padding: '8px 10px', textAlign: 'right', fontWeight: 600, ...monoStyle,
                        color: row.down_from_ath_pct >= 30 ? theme.success
                             : row.down_from_ath_pct >= 15 ? theme.warning
                             : theme.textTertiary,
                      }}>
                        {row.down_from_ath_pct?.toFixed(1)}%
                      </td>
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
                    </tr>

                    {/* Expanded Strategy Details */}
                    {isExpanded && (
                      <tr>
                        <td colSpan={13} style={{
                          padding: '0',
                          borderBottom: `2px solid ${theme.accent}30`,
                        }}>
                          <div style={{
                            padding: '12px 16px',
                            background: theme.bgTertiary,
                          }}>
                            <div style={{
                              fontSize: '10px', fontWeight: 700, color: theme.textTertiary,
                              textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px',
                            }}>
                              Strategy Details
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                              {row.strategy_results?.map((sr, i) => {
                                const sStyle = getStatusStyle(sr.status);
                                return (
                                  <div key={i} style={{
                                    padding: '8px 12px',
                                    background: theme.bgCard,
                                    borderRadius: '6px',
                                    border: `1px solid ${theme.border}`,
                                  }}>
                                    <div style={{
                                      display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px',
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
                                      {sr.reasons?.map((r, j) => (
                                        <div key={j}>• {r}</div>
                                      ))}
                                    </div>
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
