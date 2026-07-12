import React from 'react';

export default function ScanControls({ onScan, scanning, pool, setPool }) {
  return (
    <div style={styles.controls}>
      <div style={styles.poolSelect}>
        <label style={styles.label}>Stock Pool:</label>
        <select
          value={pool}
          onChange={(e) => setPool(e.target.value)}
          style={styles.select}
          disabled={scanning}
        >
          <option value="F40">Flagship 40 (F40)</option>
          <option value="E40">Emerging 40 (E40)</option>
          <option value="S200">Smartpick 200 (S200)</option>
        </select>
      </div>
      <button
        onClick={onScan}
        disabled={scanning}
        style={{
          ...styles.scanBtn,
          ...(scanning ? styles.scanBtnDisabled : {}),
        }}
      >
        {scanning ? '⏳ Scanning...' : '🔍 Run Scan'}
      </button>
    </div>
  );
}

const styles = {
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '16px 32px',
    background: '#f8f9fa',
    borderBottom: '1px solid #e9ecef',
  },
  poolSelect: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  label: {
    fontSize: '14px',
    fontWeight: 500,
    color: '#495057',
  },
  select: {
    padding: '8px 12px',
    borderRadius: '8px',
    border: '1px solid #ced4da',
    fontSize: '14px',
    background: '#fff',
    cursor: 'pointer',
  },
  scanBtn: {
    padding: '10px 24px',
    borderRadius: '8px',
    border: 'none',
    background: '#0f3460',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  scanBtnDisabled: {
    background: '#6c757d',
    cursor: 'not-allowed',
  },
};
