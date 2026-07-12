import React from 'react';
import { useTheme } from '../context/ThemeContext';

export default function Header({ currentPage, onNavigate }) {
  const { theme, isDark, toggleTheme } = useTheme();

  return (
    <header style={{
      background: theme.bgHeader,
      padding: '0 24px',
      height: '52px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottom: `1px solid ${isDark ? '#21262D' : '#2A3A5A'}`,
      position: 'sticky',
      top: 0,
      zIndex: 100,
    }}>
      {/* Left: Logo + Nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
          }}
          onClick={() => onNavigate('home')}
        >
          <span style={{ fontSize: '20px' }}>📊</span>
          <h1 style={{
            margin: 0,
            fontSize: '16px',
            fontWeight: 700,
            color: '#FFFFFF',
            letterSpacing: '-0.3px',
          }}>
            Buddy Trader
          </h1>
          <span style={{
            background: '#58A6FF',
            color: '#fff',
            fontSize: '8px',
            fontWeight: 700,
            padding: '1px 5px',
            borderRadius: '3px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}>
            Beta
          </span>
        </div>

        {/* Nav Links */}
        <nav style={{ display: 'flex', gap: '2px' }}>
          {[
            { id: 'home', label: 'Home', icon: '🏠' },
            { id: 'scanner', label: 'Scanner', icon: '🔍' },
          ].map(item => {
            const isActive = currentPage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                style={{
                  background: isActive ? 'rgba(255,255,255,0.1)' : 'transparent',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  color: isActive ? '#FFFFFF' : 'rgba(255,255,255,0.6)',
                  fontSize: '13px',
                  fontWeight: isActive ? 600 : 400,
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'transparent';
                }}
              >
                <span style={{ fontSize: '12px' }}>{item.icon}</span>
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Right: Theme toggle + Dev */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{
          fontSize: '11px',
          color: 'rgba(255,255,255,0.35)',
          fontWeight: 500,
        }}>
          Built by Vicky
        </span>

        <button
          onClick={toggleTheme}
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: `1px solid rgba(255,255,255,0.12)`,
            borderRadius: '6px',
            padding: '5px 10px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            color: '#FFFFFF',
            fontSize: '12px',
            fontWeight: 500,
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.14)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
          title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
          <span style={{ fontSize: '13px' }}>{isDark ? '☀️' : '🌙'}</span>
          {isDark ? 'Light' : 'Dark'}
        </button>
      </div>
    </header>
  );
}
