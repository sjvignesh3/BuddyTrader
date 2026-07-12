import React, { useState } from 'react';
import Header from './components/Header';
import ScanControls from './components/ScanControls';
import ScanSummary from './components/ScanSummary';
import ResultsTable from './components/ResultsTable';
import { triggerScan } from './services/api';

const globalStyles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #f0f2f5;
    color: #212529;
  }
  ::-webkit-scrollbar { height: 6px; width: 6px; }
  ::-webkit-scrollbar-thumb { background: #ced4da; border-radius: 3px; }
  tr:hover { background: #e8f4fd !important; }
`;

export default function App() {
  const [scanning, setScanning] = useState(false);
  const [pool, setPool] = useState('F40');
  const [scanData, setScanData] = useState(null);
  const [error, setError] = useState(null);

  const handleScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const result = await triggerScan(pool);
      setScanData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  };

  return (
    <>
      <style>{globalStyles}</style>
      <Header />
      <ScanControls
        onScan={handleScan}
        scanning={scanning}
        pool={pool}
        setPool={setPool}
      />

      {error && (
        <div style={styles.error}>
          ❌ {error}
        </div>
      )}

      {!scanData && !scanning && (
        <div style={styles.welcome}>
          <div style={styles.welcomeIcon}>🚀</div>
          <h2 style={styles.welcomeTitle}>Ready to Scan</h2>
          <p style={styles.welcomeText}>
            Select a stock pool and click <strong>Run Scan</strong> to find swing trading opportunities.
          </p>
          <p style={styles.welcomeHint}>
            Currently configured strategies for F40: <strong>Envelope</strong> and <strong>52 Week High Low</strong>
          </p>
        </div>
      )}

      {scanning && (
        <div style={styles.loading}>
          <div style={styles.spinner}>⏳</div>
          <p>Fetching live data and running strategies...</p>
          <p style={styles.loadingHint}>This may take 30-60 seconds for the first scan</p>
        </div>
      )}

      {scanData && !scanning && (
        <>
          <ScanSummary data={scanData} />
          <ResultsTable
            opportunities={scanData.opportunities}
            noSignal={scanData.no_signal}
            errors={scanData.errors}
          />
        </>
      )}
    </>
  );
}

const styles = {
  error: {
    margin: '16px 32px',
    padding: '12px 16px',
    background: '#fff3f3',
    border: '1px solid #fecaca',
    borderRadius: '8px',
    color: '#dc3545',
    fontSize: '14px',
  },
  welcome: {
    textAlign: 'center',
    padding: '80px 32px',
  },
  welcomeIcon: { fontSize: '64px', marginBottom: '16px' },
  welcomeTitle: {
    fontSize: '24px',
    fontWeight: 700,
    color: '#212529',
    marginBottom: '8px',
  },
  welcomeText: {
    fontSize: '16px',
    color: '#495057',
    marginBottom: '8px',
  },
  welcomeHint: {
    fontSize: '14px',
    color: '#6c757d',
  },
  loading: {
    textAlign: 'center',
    padding: '80px 32px',
    color: '#495057',
  },
  spinner: {
    fontSize: '48px',
    marginBottom: '16px',
    animation: 'pulse 1.5s infinite',
  },
  loadingHint: {
    fontSize: '13px',
    color: '#6c757d',
    marginTop: '8px',
  },
};
