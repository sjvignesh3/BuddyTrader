import React from 'react';
import { useTheme } from '../context/ThemeContext';

const STRATEGIES = [
  { name: 'Long Envelope',    pools: { F40: true,  E40: false, S200: false, all: false } },
  { name: 'Short Envelope',   pools: { F40: true,  E40: false, S200: false, all: false } },
  { name: 'Envelope + Knox',  pools: { F40: true,  E40: false, S200: false, all: false } },
  { name: '52W High Low',     pools: { F40: true,  E40: false, S200: false, all: false } },
  { name: 'SMA',              pools: { F40: true,  E40: 'Only With BCD', S200: false, all: false } },
  { name: 'RHS',              pools: { F40: true,  E40: true,  S200: false, all: false } },
  { name: 'CWH',              pools: { F40: true,  E40: true,  S200: false, all: false } },
  { name: '10% Correction',   pools: { F40: true,  E40: true,  S200: false, all: false } },
  { name: 'ABCD',             pools: { F40: true,  E40: true,  S200: true,  all: false } },
  { name: '20% Rally',        pools: { F40: true,  E40: true,  S200: true,  all: false } },
  { name: 'S&R',              pools: { F40: true,  E40: true,  S200: true,  all: false } },
];

const POOLS = [
  { key: 'F40',  label: 'F40' },
  { key: 'E40',  label: 'E40' },
  { key: 'S200', label: 'S200' },
  { key: 'all',  label: 'All' },
];

export default function StrategyMatrix() {
  const { theme } = useTheme();

  const renderCell = (value) => {
    if (value === true) {
      return (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '22px',
          height: '22px',
          borderRadius: '4px',
          background: theme.successLight,
          color: theme.success,
          fontSize: '12px',
          fontWeight: 700,
        }}>
          ✓
        </span>
      );
    }
    if (typeof value === 'string') {
      return (
        <span style={{
          fontSize: '9px',
          fontWeight: 600,
          padding: '2px 6px',
          borderRadius: '4px',
          background: theme.warningLight,
          color: theme.warningDark,
          whiteSpace: 'nowrap',
        }}>
          {value}
        </span>
      );
    }
    return (
      <span style={{ color: theme.textTertiary, fontSize: '12px' }}>—</span>
    );
  };

  return (
    <div style={{
      background: theme.bgCard,
      borderRadius: '10px',
      border: `1px solid ${theme.border}`,
      boxShadow: theme.shadow,
      overflow: 'hidden',
    }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: '13px',
        }}>
          <thead>
            <tr>
              <th style={{
                padding: '10px 16px',
                textAlign: 'left',
                fontSize: '10px',
                fontWeight: 600,
                color: theme.textTertiary,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                borderBottom: `1px solid ${theme.border}`,
                background: theme.bgTertiary,
              }}>
                Strategy
              </th>
              {POOLS.map(p => (
                <th key={p.key} style={{
                  padding: '10px 16px',
                  textAlign: 'center',
                  fontSize: '10px',
                  fontWeight: 600,
                  color: theme.textTertiary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  borderBottom: `1px solid ${theme.border}`,
                  background: theme.bgTertiary,
                  minWidth: '60px',
                }}>
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STRATEGIES.map((strat, idx) => (
              <tr key={strat.name} style={{
                background: idx % 2 === 0 ? 'transparent' : theme.tableRowAlt,
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = theme.tableRowHover}
              onMouseLeave={(e) => e.currentTarget.style.background = idx % 2 === 0 ? 'transparent' : theme.tableRowAlt}
              >
                <td style={{
                  padding: '9px 16px',
                  fontWeight: 500,
                  color: theme.text,
                  borderBottom: `1px solid ${theme.borderLight}`,
                  whiteSpace: 'nowrap',
                  fontSize: '12px',
                }}>
                  {strat.name}
                </td>
                {POOLS.map(p => (
                  <td key={p.key} style={{
                    padding: '9px 16px',
                    textAlign: 'center',
                    borderBottom: `1px solid ${theme.borderLight}`,
                  }}>
                    {renderCell(strat.pools[p.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
