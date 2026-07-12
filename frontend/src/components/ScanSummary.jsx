import React from 'react';
import { useTheme } from '../context/ThemeContext';

export default function ScanSummary({ data }) {
  const { theme } = useTheme();

  if (!data) return null;

  const cards = [
    { label: 'Scanned',     value: data.total_stocks_scanned, color: theme.textSecondary },
    { label: 'Data OK',     value: data.data_available_for,   color: theme.accent },
    { label: 'Buy Zone',    value: data.buy_zone_count,       color: theme.success,  highlight: data.buy_zone_count > 0 },
    { label: 'Opportunity', value: data.opportunity_count,    color: theme.warning,  highlight: data.opportunity_count > 0 },
    { label: 'No Signal',   value: data.no_signal_count,      color: theme.textTertiary },
    { label: 'Errors',      value: data.error_count,          color: data.error_count > 0 ? theme.danger : theme.textTertiary },
  ];

  return (
    <div style={{ padding: '16px 24px 12px' }}>
      {/* Meta row */}
      <div style={{
        display: 'flex',
        gap: '16px',
        flexWrap: 'wrap',
        fontSize: '11px',
        color: theme.textTertiary,
        marginBottom: '12px',
        fontWeight: 500,
      }}>
        <span>Scanned: {new Date(data.scan_timestamp).toLocaleString()}</span>
        <span>Duration: {data.scan_duration_seconds}s</span>
        <span>Pool: {data.pool}</span>
        <span>Strategies: {data.strategies_applied?.join(', ')}</span>
      </div>

      {/* Metric Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
        gap: '8px',
      }}>
        {cards.map((card) => (
          <div
            key={card.label}
            style={{
              background: card.highlight
                ? (theme.mode === 'dark' ? theme.successLight : '#F0FFF4')
                : theme.bgCard,
              borderRadius: '8px',
              padding: '12px 14px',
              border: `1px solid ${card.highlight ? theme.success + '30' : theme.border}`,
              boxShadow: card.highlight ? theme.shadowMd : theme.shadow,
              textAlign: 'center',
              transition: 'all 0.15s',
            }}
          >
            <div style={{
              fontSize: '22px',
              fontWeight: 700,
              color: card.color,
              lineHeight: 1.1,
            }}>
              {card.value}
            </div>
            <div style={{
              fontSize: '10px',
              color: theme.textTertiary,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              marginTop: '3px',
            }}>
              {card.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
