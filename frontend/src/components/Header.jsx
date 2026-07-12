import React from 'react';

export default function Header() {
  return (
    <header style={styles.header}>
      <div style={styles.brand}>
        <span style={styles.logo}>📊</span>
        <h1 style={styles.title}>Buddy Scanner</h1>
        <span style={styles.badge}>MVP</span>
      </div>
      <p style={styles.subtitle}>NSE Swing Trading Opportunity Scanner</p>
    </header>
  );
}

const styles = {
  header: {
    background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    padding: '20px 32px',
    color: '#fff',
    borderBottom: '3px solid #0f3460',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  logo: { fontSize: '32px' },
  title: {
    margin: 0,
    fontSize: '24px',
    fontWeight: 700,
    letterSpacing: '-0.5px',
  },
  badge: {
    background: '#e94560',
    color: '#fff',
    fontSize: '11px',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: '12px',
    textTransform: 'uppercase',
  },
  subtitle: {
    margin: '4px 0 0 44px',
    fontSize: '13px',
    color: '#8892b0',
  },
};
