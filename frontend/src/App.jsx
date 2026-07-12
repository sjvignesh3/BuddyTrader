import React, { useState, useEffect } from 'react';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import Header from './components/Header';
import HomePage from './pages/HomePage';
import ScannerPage from './pages/ScannerPage';
import { getScanStatuses } from './services/api';

function AppContent() {
  const { theme } = useTheme();
  const [currentPage, setCurrentPage] = useState('home');
  const [initialPool, setInitialPool] = useState('F40');

  // Per-pool scan cache (persisted in React state, survives tab switches)
  const [scanCache, setScanCache] = useState({});

  // Load scan statuses on mount
  useEffect(() => {
    getScanStatuses()
      .then(statuses => {
        // Only store metadata (timestamps, counts) for pool cards
        // Full data is loaded lazily when user visits scanner
        const meta = {};
        for (const [pool, data] of Object.entries(statuses)) {
          if (data.scan_timestamp) {
            meta[pool] = data;
          }
        }
        // Merge with existing cache (don't overwrite full data)
        setScanCache(prev => {
          const merged = { ...prev };
          for (const [pool, data] of Object.entries(meta)) {
            if (!merged[pool]) merged[pool] = data;
          }
          return merged;
        });
      })
      .catch(() => {}); // Silently ignore if backend is not running
  }, []);

  const handleNavigate = (page, poolCode) => {
    setCurrentPage(page);
    if (poolCode) setInitialPool(poolCode);
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: theme.bg,
      transition: 'background 0.25s, color 0.25s',
    }}>
      <Header currentPage={currentPage} onNavigate={handleNavigate} />

      {currentPage === 'home' && (
        <HomePage
          onNavigate={handleNavigate}
          scanCache={scanCache}
        />
      )}

      {currentPage === 'scanner' && (
        <ScannerPage
          initialPool={initialPool}
          scanCache={scanCache}
          setScanCache={setScanCache}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}
