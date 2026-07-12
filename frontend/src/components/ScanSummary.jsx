import React from 'react';

export default function ScanSummary({ data }) {
  if (!data) return null;

  const cards = [
    {
      label: 'Total Scanned',
      value: data.total_stocks_scanned,
      icon: '📋',
      color: '#495057',
    },
    {
      label: 'Data Available',
      value: data.data_available_for,
      icon: '📡',
      color: '#0077b6',
    },
    {
      label: 'BUY ZONE',
      value: data.buy_zone_count,
      icon: '🟢',
      color: '#2d6a4f',
      highlight: data.buy_zone_count > 0,
    },
    {
      label: 'OPPORTUNITY',
      value: data.opportunity_count,
      icon: '🟡',
      color: '#e76f51',
      highlight: data.opportunity_count > 0,
    },
    {
      label: 'No Signal',
      value: data.no_signal_count,
      icon: '⚪',
      color: '#6c757d',
    },
    {
      label: 'Errors',
      value: data.error_count,
      icon: '❌',
      color: data.error_count > 0 ? '#dc3545' : '#6c757d',
    },
  ];

  return (
    <div style={styles.container}>
      <div style={styles.meta}>
        <span>🕐 Scanned at: {new Date(data.scan_timestamp).toLocaleString()}</span>
        <span>⏱️ Duration: {data.scan_duration_seconds}s</span>
        <span>📊 Pool: {data.pool}</span>
        <span>🎯 Strategies: {data.strategies_applied?.join(', ')}</span>
      </div>
      <div style={styles.grid}>
        {cards.map((card) => (
          <div
            key={card.label}
            style={{
              ...styles.card,
              borderLeft: `4px solid ${card.color}`,
              ...(card.highlight ? styles.cardHighlight : {}),
            }}
          >
            <div style={styles.cardIcon}>{card.icon}</div>
            <div style={styles.cardValue}>{card.value}</div>
            <div style={styles.cardLabel}>{card.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  container: {
    padding: '16px 32px',
  },
  meta: {
    display: 'flex',
    gap: '24px',
    flexWrap: 'wrap',
    fontSize: '13px',
    color: '#6c757d',
    marginBottom: '16px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '12px',
  },
  card: {
    background: '#fff',
    borderRadius: '8px',
    padding: '16px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    textAlign: 'center',
  },
  cardHighlight: {
    background: '#f0fff4',
    boxShadow: '0 2px 8px rgba(45,106,79,0.15)',
  },
  cardIcon: { fontSize: '20px', marginBottom: '4px' },
  cardValue: { fontSize: '28px', fontWeight: 700, color: '#212529' },
  cardLabel: { fontSize: '12px', color: '#6c757d', fontWeight: 500, textTransform: 'uppercase' },
};
