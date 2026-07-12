import React, { useState } from 'react';

const STATUS_STYLES = {
  BUY_ZONE: { bg: '#d4edda', color: '#155724', label: '🟢 BUY ZONE' },
  OPPORTUNITY: { bg: '#fff3cd', color: '#856404', label: '🟡 OPPORTUNITY' },
  NO_SIGNAL: { bg: '#f8f9fa', color: '#6c757d', label: '⚪ No Signal' },
};

export default function ResultsTable({ opportunities, noSignal, errors }) {
  const [tab, setTab] = useState('opportunities');
  const [sortCol, setSortCol] = useState('best_score');
  const [sortAsc, setSortAsc] = useState(false);
  const [expandedRow, setExpandedRow] = useState(null);

  const handleSort = (col) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(false);
    }
  };

  const currentData = tab === 'opportunities' ? opportunities : tab === 'no_signal' ? noSignal : errors;

  const sortedData = tab !== 'errors'
    ? [...(currentData || [])].sort((a, b) => {
        const va = a[sortCol] ?? 0;
        const vb = b[sortCol] ?? 0;
        return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
      })
    : currentData || [];

  return (
    <div style={styles.container}>
      {/* Tabs */}
      <div style={styles.tabs}>
        <button
          style={{ ...styles.tab, ...(tab === 'opportunities' ? styles.tabActive : {}) }}
          onClick={() => setTab('opportunities')}
        >
          🎯 Opportunities ({opportunities?.length || 0})
        </button>
        <button
          style={{ ...styles.tab, ...(tab === 'no_signal' ? styles.tabActive : {}) }}
          onClick={() => setTab('no_signal')}
        >
          ⚪ No Signal ({noSignal?.length || 0})
        </button>
        {errors?.length > 0 && (
          <button
            style={{ ...styles.tab, ...(tab === 'errors' ? styles.tabActive : {}) }}
            onClick={() => setTab('errors')}
          >
            ❌ Errors ({errors.length})
          </button>
        )}
      </div>

      {/* Table */}
      {tab === 'errors' ? (
        <div style={styles.errorList}>
          {errors?.map((e, i) => (
            <div key={i} style={styles.errorItem}>
              <strong>{e.symbol}</strong>: {e.error}
            </div>
          ))}
        </div>
      ) : (
        <div style={styles.tableWrapper}>
          <table style={styles.table}>
            <thead>
              <tr>
                {[
                  { key: 'symbol', label: 'Symbol' },
                  { key: 'sector', label: 'Sector' },
                  { key: 'cap_type', label: 'Cap' },
                  { key: 'close', label: 'Close ₹' },
                  { key: 'dma_200', label: '200 DMA' },
                  { key: 'below_200dma_pct', label: '% Below DMA' },
                  { key: 'low_52w', label: '52W Low' },
                  { key: 'high_52w', label: '52W High' },
                  { key: 'distance_from_52w_low_pct', label: '% From Low' },
                  { key: 'best_status', label: 'Signal' },
                  { key: 'best_score', label: 'Score' },
                ].map(({ key, label }) => (
                  <th
                    key={key}
                    style={styles.th}
                    onClick={() => handleSort(key)}
                  >
                    {label} {sortCol === key ? (sortAsc ? '↑' : '↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedData.map((row, idx) => {
                const statusStyle = STATUS_STYLES[row.best_status] || STATUS_STYLES.NO_SIGNAL;
                const isExpanded = expandedRow === idx;
                return (
                  <React.Fragment key={row.symbol + idx}>
                    <tr
                      style={{
                        ...styles.tr,
                        background: idx % 2 === 0 ? '#fff' : '#fafafa',
                        cursor: 'pointer',
                      }}
                      onClick={() => setExpandedRow(isExpanded ? null : idx)}
                    >
                      <td style={{ ...styles.td, fontWeight: 600 }}>{row.symbol}</td>
                      <td style={styles.td}>{row.sector}</td>
                      <td style={styles.td}>
                        <span style={styles.capBadge}>{row.cap_type}</span>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>₹{row.close?.toFixed(2)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>₹{row.dma_200?.toFixed(2)}</td>
                      <td style={{
                        ...styles.td,
                        textAlign: 'right',
                        color: row.below_200dma_pct > 0 ? '#2d6a4f' : '#dc3545',
                        fontWeight: 600,
                      }}>
                        {row.below_200dma_pct?.toFixed(1)}%
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>₹{row.low_52w?.toFixed(2)}</td>
                      <td style={{ ...styles.td, textAlign: 'right' }}>₹{row.high_52w?.toFixed(2)}</td>
                      <td style={{
                        ...styles.td,
                        textAlign: 'right',
                        color: row.distance_from_52w_low_pct <= 5 ? '#2d6a4f' : '#6c757d',
                        fontWeight: row.distance_from_52w_low_pct <= 5 ? 600 : 400,
                      }}>
                        {row.distance_from_52w_low_pct?.toFixed(1)}%
                      </td>
                      <td style={styles.td}>
                        <span style={{
                          ...styles.statusBadge,
                          background: statusStyle.bg,
                          color: statusStyle.color,
                        }}>
                          {statusStyle.label}
                        </span>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'center', fontWeight: 700, fontSize: '16px' }}>
                        {row.best_score}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={11} style={styles.expandedRow}>
                          <div style={styles.reasonsBox}>
                            <strong>Strategy Details:</strong>
                            {row.strategy_results?.map((sr, i) => (
                              <div key={i} style={styles.strategyDetail}>
                                <span style={{ fontWeight: 600 }}>{sr.strategy_name}:</span>{' '}
                                <span style={{
                                  ...styles.miniStatusBadge,
                                  background: STATUS_STYLES[sr.status]?.bg || '#f8f9fa',
                                  color: STATUS_STYLES[sr.status]?.color || '#6c757d',
                                }}>
                                  {sr.status} (Score: {sr.score})
                                </span>
                                <div style={styles.reasons}>
                                  {sr.reasons?.map((r, j) => (
                                    <div key={j}>• {r}</div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {sortedData.length === 0 && (
            <div style={styles.empty}>
              {tab === 'opportunities'
                ? '🔍 No opportunities found. Market may not be in a corrective phase.'
                : 'No data to display.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    padding: '0 32px 32px',
  },
  tabs: {
    display: 'flex',
    gap: '4px',
    marginBottom: '12px',
  },
  tab: {
    padding: '8px 16px',
    borderRadius: '8px 8px 0 0',
    border: '1px solid #dee2e6',
    borderBottom: 'none',
    background: '#f8f9fa',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    color: '#495057',
  },
  tabActive: {
    background: '#fff',
    fontWeight: 700,
    color: '#0f3460',
    borderColor: '#0f3460',
    borderBottomColor: '#fff',
  },
  tableWrapper: {
    overflowX: 'auto',
    border: '1px solid #dee2e6',
    borderRadius: '0 8px 8px 8px',
    background: '#fff',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px',
  },
  th: {
    padding: '12px 10px',
    textAlign: 'left',
    background: '#f8f9fa',
    borderBottom: '2px solid #dee2e6',
    fontWeight: 600,
    color: '#495057',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    fontSize: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  tr: {
    borderBottom: '1px solid #f0f0f0',
    transition: 'background 0.1s',
  },
  td: {
    padding: '10px 10px',
    whiteSpace: 'nowrap',
  },
  statusBadge: {
    padding: '4px 10px',
    borderRadius: '12px',
    fontSize: '11px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  miniStatusBadge: {
    padding: '2px 8px',
    borderRadius: '8px',
    fontSize: '11px',
    fontWeight: 600,
  },
  capBadge: {
    fontSize: '11px',
    color: '#6c757d',
  },
  expandedRow: {
    padding: '12px 16px',
    background: '#f8f9fa',
    borderBottom: '2px solid #dee2e6',
  },
  reasonsBox: {
    fontSize: '13px',
    lineHeight: '1.6',
  },
  strategyDetail: {
    marginTop: '8px',
    padding: '8px 12px',
    background: '#fff',
    borderRadius: '6px',
    border: '1px solid #e9ecef',
  },
  reasons: {
    marginTop: '4px',
    fontSize: '12px',
    color: '#495057',
  },
  empty: {
    padding: '48px',
    textAlign: 'center',
    color: '#6c757d',
    fontSize: '15px',
  },
  errorList: { padding: '16px' },
  errorItem: {
    padding: '8px 12px',
    background: '#fff3f3',
    borderRadius: '6px',
    marginBottom: '8px',
    fontSize: '13px',
    border: '1px solid #fecaca',
  },
};
