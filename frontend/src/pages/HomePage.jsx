import React from 'react';
import { useTheme } from '../context/ThemeContext';
import StrategyMatrix from '../components/StrategyMatrix';

const MOTIVATIONAL_QUOTES = [
  { text: "The stock market is a device for transferring money from the impatient to the patient.", author: "Warren Buffett" },
  { text: "In investing, what is comfortable is rarely profitable.", author: "Robert Arnott" },
  { text: "The individual investor should act consistently as an investor and not as a speculator.", author: "Ben Graham" },
  { text: "Risk comes from not knowing what you're doing.", author: "Warren Buffett" },
  { text: "Buy when there's blood in the streets, even if the blood is your own.", author: "Baron Rothschild" },
  { text: "The time of maximum pessimism is the best time to buy.", author: "Sir John Templeton" },
];

const POOL_INFO = [
  {
    code: 'F40', name: 'Flagship 40', icon: '🏛️',
    desc: 'Core qualitative large & mid cap picks',
    method: 'Qualitative', cap: 'Large & Mid', strategies: 11,
    update: 'Very Rare', volatility: 'Low', reward: 'Low', priority: 'First',
    color: '#4A7FDB',
  },
  {
    code: 'E40', name: 'Emerging 40', icon: '🚀',
    desc: 'Growth-stage mid & small cap companies',
    method: 'Qualitative', cap: 'Mid & Small', strategies: 7,
    update: 'Very Rare', volatility: 'Medium', reward: 'Medium', priority: 'Second',
    color: '#D4860A',
  },
  {
    code: 'S200', name: 'Smartpick 200', icon: '📈',
    desc: 'Quantitative selection across all caps',
    method: 'Quantitative', cap: 'All Caps', strategies: 3,
    update: 'Every Quarter', volatility: 'High', reward: 'High', priority: 'Third',
    color: '#2DA44E',
  },
  {
    code: 'PlayArea', name: 'Play Area', icon: '🎯',
    desc: 'Custom stock screening playground',
    method: 'Custom', cap: 'Any', strategies: 'All',
    update: 'On Demand', volatility: '—', reward: '—', priority: 'Ad-hoc',
    color: '#9B59B6',
  },
];

export default function HomePage({ onNavigate, scanCache }) {
  const { theme, isDark } = useTheme();

  // Pick a random quote based on the day
  const dayIndex = new Date().getDate() % MOTIVATIONAL_QUOTES.length;
  const quote = MOTIVATIONAL_QUOTES[dayIndex];

  const Card = ({ children, style: cardStyle = {}, ...rest }) => (
    <div style={{
      background: theme.bgCard,
      border: `1px solid ${theme.border}`,
      borderRadius: '10px',
      boxShadow: theme.shadow,
      ...cardStyle,
    }} {...rest}>
      {children}
    </div>
  );

  const SectionTitle = ({ icon, title, subtitle }) => (
    <div style={{ marginBottom: '14px' }}>
      <h2 style={{
        fontSize: '15px',
        fontWeight: 700,
        color: theme.text,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '2px',
      }}>
        <span style={{ fontSize: '16px' }}>{icon}</span>
        {title}
      </h2>
      {subtitle && (
        <p style={{ fontSize: '12px', color: theme.textTertiary, marginLeft: '24px' }}>
          {subtitle}
        </p>
      )}
    </div>
  );

  return (
    <div style={{
      padding: '20px 28px 40px',
      maxWidth: '1200px',
      margin: '0 auto',
      animation: 'fadeIn 0.3s ease',
    }}>

      {/* ── Motivation Banner ── */}
      <div style={{
        background: theme.motivationBg,
        border: `1px solid ${theme.border}`,
        borderRadius: '12px',
        padding: '24px 28px',
        marginBottom: '24px',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute',
          top: '-20px',
          right: '-10px',
          fontSize: '80px',
          opacity: 0.06,
          transform: 'rotate(-10deg)',
        }}>📈</div>
        <blockquote style={{
          fontSize: '16px',
          fontWeight: 500,
          color: theme.text,
          lineHeight: 1.6,
          fontStyle: 'italic',
          margin: 0,
          position: 'relative',
        }}>
          "{quote.text}"
        </blockquote>
        <div style={{
          fontSize: '13px',
          color: theme.accent,
          fontWeight: 600,
          marginTop: '8px',
        }}>
          — {quote.author}
        </div>
      </div>

      {/* ── Pool Cards Grid ── */}
      <SectionTitle icon="📦" title="Stock Pools" subtitle="Select a pool to start scanning" />

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '14px',
        marginBottom: '28px',
      }}>
        {POOL_INFO.map((pool) => {
          const cached = scanCache?.[pool.code];
          const hasData = !!cached;

          return (
            <Card
              key={pool.code}
              style={{
                padding: '18px 20px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                borderTop: `3px solid ${pool.color}`,
                position: 'relative',
              }}
              onClick={() => onNavigate('scanner', pool.code)}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = theme.shadowMd;
                e.currentTarget.style.borderColor = pool.color + '60';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = theme.shadow;
                e.currentTarget.style.borderColor = theme.border;
              }}
            >
              {/* Pool header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                <span style={{ fontSize: '22px' }}>{pool.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontSize: '15px', fontWeight: 700, color: theme.text, lineHeight: 1.2,
                  }}>
                    {pool.name}
                  </div>
                  <div style={{
                    fontSize: '11px', color: theme.textTertiary, fontWeight: 500,
                  }}>
                    {pool.code} · {pool.strategies} strategies
                  </div>
                </div>
              </div>

              {/* Desc */}
              <div style={{
                fontSize: '12px', color: theme.textSecondary, lineHeight: 1.4, marginBottom: '12px',
              }}>
                {pool.desc}
              </div>

              {/* Pool meta */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '4px 12px',
                fontSize: '11px',
              }}>
                {[
                  ['Method', pool.method],
                  ['Cap', pool.cap],
                  ['Volatility', pool.volatility],
                  ['Priority', pool.priority],
                ].map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: theme.textTertiary }}>{label}</span>
                    <span style={{ color: theme.textSecondary, fontWeight: 500 }}>{value}</span>
                  </div>
                ))}
              </div>

              {/* Scan status footer */}
              <div style={{
                marginTop: '12px',
                paddingTop: '10px',
                borderTop: `1px solid ${theme.divider}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                {hasData ? (
                  <>
                    <span style={{
                      fontSize: '10px',
                      color: theme.success,
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}>
                      <span style={{
                        width: '6px', height: '6px', borderRadius: '50%',
                        background: theme.success, display: 'inline-block',
                      }} />
                      Scanned
                    </span>
                    <span style={{ fontSize: '10px', color: theme.textTertiary }}>
                      {new Date(cached.scan_timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </>
                ) : (
                  <span style={{ fontSize: '10px', color: theme.textTertiary, fontStyle: 'italic' }}>
                    Not scanned yet
                  </span>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/* ── Quick Links ── */}
      <SectionTitle icon="🔗" title="Quick Links" />
      <div style={{
        display: 'flex',
        gap: '12px',
        marginBottom: '28px',
        flexWrap: 'wrap',
      }}>
        <a
          href="https://docs.google.com/spreadsheets/d/158FgpVyiJF4G4EV59Gh8rWj4E4t0lPeMhGBEHHBMmqc/edit?gid=1298302892#gid=1298302892"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 16px',
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: '8px',
            textDecoration: 'none',
            color: theme.text,
            fontSize: '13px',
            fontWeight: 500,
            transition: 'all 0.15s',
            boxShadow: theme.shadow,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = theme.accent;
            e.currentTarget.style.boxShadow = theme.shadowMd;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = theme.border;
            e.currentTarget.style.boxShadow = theme.shadow;
          }}
        >
          <span style={{ fontSize: '16px' }}>📓</span>
          Trading Journal
          <span style={{ fontSize: '11px', color: theme.textTertiary }}>↗</span>
        </a>

        <button
          onClick={() => onNavigate('scanner')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 16px',
            background: theme.accent,
            border: 'none',
            borderRadius: '8px',
            color: '#fff',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s',
            boxShadow: theme.shadow,
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = theme.accentHover}
          onMouseLeave={(e) => e.currentTarget.style.background = theme.accent}
        >
          <span style={{ fontSize: '14px' }}>🔍</span>
          Open Scanner
        </button>
      </div>

      {/* ── Fundamental Pointers ── */}
      <SectionTitle
        icon="📋"
        title="Fundamental Pointers"
        subtitle="Quick reference rules for buying decisions"
      />

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        gap: '14px',
        marginBottom: '28px',
      }}>
        {/* Position Sizing */}
        <Card style={{ padding: '18px 20px' }}>
          <h3 style={{
            fontSize: '13px', fontWeight: 700, color: theme.accent,
            textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px',
            display: 'flex', alignItems: 'center', gap: '6px',
          }}>
            <span style={{ fontSize: '14px' }}>⚖️</span>
            Position Sizing
          </h3>
          {[
            { cap: 'Large Cap', pct: '5%', color: theme.badge.large },
            { cap: 'Mid Cap', pct: '3%', color: theme.badge.mid },
            { cap: 'Small Cap', pct: '1.5%', color: theme.badge.small },
          ].map(item => (
            <div key={item.cap} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              borderRadius: '6px',
              marginBottom: '6px',
              background: item.color + '10',
              border: `1px solid ${item.color}20`,
            }}>
              <span style={{ fontSize: '12px', color: theme.text, fontWeight: 500 }}>
                {item.cap}
              </span>
              <span style={{
                fontSize: '13px', fontWeight: 700, color: item.color,
              }}>
                Max {item.pct}
              </span>
            </div>
          ))}
        </Card>

        {/* Buy Only on Fall */}
        <Card style={{ padding: '18px 20px' }}>
          <h3 style={{
            fontSize: '13px', fontWeight: 700, color: theme.danger,
            textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px',
            display: 'flex', alignItems: 'center', gap: '6px',
          }}>
            <span style={{ fontSize: '14px' }}>📉</span>
            Buy Only on Fall
          </h3>
          <p style={{ fontSize: '11px', color: theme.textTertiary, marginBottom: '10px' }}>
            I will NOT buy at top. Only when there is a fall:
          </p>
          {[
            { cap: 'Large Cap', range: '20 – 30% fall', color: theme.badge.large },
            { cap: 'Mid Cap', range: '35 – 50% fall', color: theme.badge.mid },
            { cap: 'Small Cap', range: '50 – 70% fall', color: theme.badge.small },
          ].map(item => (
            <div key={item.cap} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              borderRadius: '6px',
              marginBottom: '6px',
              background: item.color + '10',
              border: `1px solid ${item.color}20`,
            }}>
              <span style={{ fontSize: '12px', color: theme.text, fontWeight: 500 }}>
                {item.cap}
              </span>
              <span style={{
                fontSize: '12px', fontWeight: 600, color: item.color,
              }}>
                {item.range}
              </span>
            </div>
          ))}
          <p style={{
            fontSize: '11px', color: theme.textTertiary, marginTop: '8px', fontStyle: 'italic',
          }}>
            Check fall + apply strategy rule together
          </p>
        </Card>

        {/* Must Have */}
        <Card style={{ padding: '18px 20px' }}>
          <h3 style={{
            fontSize: '13px', fontWeight: 700, color: theme.success,
            textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px',
            display: 'flex', alignItems: 'center', gap: '6px',
          }}>
            <span style={{ fontSize: '14px' }}>✅</span>
            Must Have Conditions
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {[
              'Do NOT buy above 200 DMA',
              'PE < 70 & PE < 5yr Median PE',
              'Net Debt/Equity < 0.25',
              'ROCE > 15 (ROE > 15 for banks)',
              'TTM Net Profit > ₹250 Cr p.a.',
              'Public Shareholding < 30%',
              'Pledged % < 5%',
              'TTM Sales ≥ 90% of 10yr highest',
              'TTM Profit ≥ 90% of 10yr highest',
              'OPM stable or increasing',
            ].map((rule, i) => (
              <div key={i} style={{
                fontSize: '12px',
                color: theme.text,
                padding: '4px 0',
                borderBottom: i < 9 ? `1px solid ${theme.divider}` : 'none',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '6px',
              }}>
                <span style={{
                  fontSize: '8px',
                  color: theme.success,
                  marginTop: '4px',
                  flexShrink: 0,
                }}>●</span>
                {rule}
              </div>
            ))}
          </div>
        </Card>

        {/* Good to Have + Watchout */}
        <Card style={{ padding: '18px 20px' }}>
          <h3 style={{
            fontSize: '13px', fontWeight: 700, color: theme.warning,
            textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px',
            display: 'flex', alignItems: 'center', gap: '6px',
          }}>
            <span style={{ fontSize: '14px' }}>💡</span>
            Good to Have
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '16px' }}>
            {[
              'More below DMA → better opportunity',
              'PE < 10yr Median PE',
              'Market Cap/Sales below median',
              'EV/EBITDA below median',
              '1yr Price CAGR < Profit Growth',
              '3yr Price CAGR < Profit Growth',
              'Fixed assets in increasing trend',
              'Book Value < 0.4',
            ].map((rule, i) => (
              <div key={i} style={{
                fontSize: '12px', color: theme.text, padding: '3px 0',
                display: 'flex', alignItems: 'flex-start', gap: '6px',
              }}>
                <span style={{ fontSize: '8px', color: theme.warning, marginTop: '4px', flexShrink: 0 }}>●</span>
                {rule}
              </div>
            ))}
          </div>

          <h3 style={{
            fontSize: '13px', fontWeight: 700, color: theme.danger,
            textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px',
            display: 'flex', alignItems: 'center', gap: '6px',
          }}>
            <span style={{ fontSize: '14px' }}>⚠️</span>
            Watch Out
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {[
              'More interest reducing profit → more borrowing',
              'Exceptional income — abnormal profit/loss',
              'Tax payment anomalies — manipulation',
              'Book Value opportunity',
            ].map((rule, i) => (
              <div key={i} style={{
                fontSize: '12px', color: theme.text, padding: '3px 0',
                display: 'flex', alignItems: 'flex-start', gap: '6px',
              }}>
                <span style={{ fontSize: '8px', color: theme.danger, marginTop: '4px', flexShrink: 0 }}>●</span>
                {rule}
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* ── Strategy Matrix ── */}
      <SectionTitle
        icon="🧮"
        title="Strategy × Pool Matrix"
        subtitle="Active strategy assignments from the Master CSV"
      />
      <StrategyMatrix />
    </div>
  );
}
