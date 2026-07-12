import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

/* ── Palette: Neutral-first with accent pops ── */
const lightTheme = {
  mode: 'light',
  // Surfaces
  bg: '#F5F6F8',
  bgSecondary: '#FFFFFF',
  bgTertiary: '#ECEEF2',
  bgHover: '#E4E7ED',
  bgCard: '#FFFFFF',
  bgCardHover: '#F8F9FB',
  bgInput: '#FFFFFF',
  bgHeader: '#1C2536',
  // Text
  text: '#1A1D26',
  textSecondary: '#555B6E',
  textTertiary: '#8C93A3',
  textInverse: '#FFFFFF',
  // Borders
  border: '#DDE0E7',
  borderLight: '#ECEEF2',
  borderFocus: '#4A7FDB',
  // Accent
  accent: '#4A7FDB',
  accentHover: '#3968C0',
  accentLight: '#EBF1FB',
  accentMuted: '#B0C9F0',
  // Status
  success: '#2DA44E',
  successLight: '#DFF5E5',
  successDark: '#1A7F37',
  warning: '#D4860A',
  warningLight: '#FFF4D6',
  warningDark: '#9A6700',
  danger: '#CF222E',
  dangerLight: '#FFEBE9',
  // Shadows
  shadow: '0 1px 2px rgba(0,0,0,0.05)',
  shadowMd: '0 2px 8px rgba(0,0,0,0.06)',
  shadowLg: '0 8px 24px rgba(0,0,0,0.08)',
  // Table
  tableRowAlt: '#F8F9FB',
  tableRowHover: '#EDF1F8',
  // Badges
  badge: { large: '#4A7FDB', mid: '#D4860A', small: '#CF222E' },
  // Misc
  cardAccent: '#4A7FDB',
  scrollThumb: 'transparent',
  divider: '#ECEEF2',
  motivationBg: 'linear-gradient(135deg, #EBF1FB 0%, #F5F6F8 100%)',
  pointerCardBg: '#FFF9ED',
  pointerCardBorder: '#F0E0B8',
};

const darkTheme = {
  mode: 'dark',
  bg: '#0D1117',
  bgSecondary: '#161B22',
  bgTertiary: '#1C2128',
  bgHover: '#272D37',
  bgCard: '#161B22',
  bgCardHover: '#1C2128',
  bgInput: '#1C2128',
  bgHeader: '#0D1117',
  text: '#E6EDF3',
  textSecondary: '#9AA5B4',
  textTertiary: '#636E7B',
  textInverse: '#FFFFFF',
  border: '#30363D',
  borderLight: '#21262D',
  borderFocus: '#58A6FF',
  accent: '#58A6FF',
  accentHover: '#4A93E0',
  accentLight: '#152238',
  accentMuted: '#2D4A6E',
  success: '#3FB950',
  successLight: '#12261E',
  successDark: '#3FB950',
  warning: '#D29922',
  warningLight: '#2A2012',
  warningDark: '#D29922',
  danger: '#F85149',
  dangerLight: '#2D1517',
  shadow: '0 1px 2px rgba(0,0,0,0.3)',
  shadowMd: '0 2px 8px rgba(0,0,0,0.25)',
  shadowLg: '0 8px 24px rgba(0,0,0,0.4)',
  tableRowAlt: '#0D1117',
  tableRowHover: '#1A2332',
  badge: { large: '#58A6FF', mid: '#D29922', small: '#F85149' },
  cardAccent: '#58A6FF',
  scrollThumb: 'transparent',
  divider: '#21262D',
  motivationBg: 'linear-gradient(135deg, #152238 0%, #0D1117 100%)',
  pointerCardBg: '#1C1E14',
  pointerCardBorder: '#3A3820',
};

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('buddy-theme');
    return saved ? saved === 'dark' : true; // Default dark
  });

  const theme = isDark ? darkTheme : lightTheme;

  useEffect(() => {
    localStorage.setItem('buddy-theme', isDark ? 'dark' : 'light');
    document.body.style.background = theme.bg;
    document.body.style.color = theme.text;
  }, [isDark, theme]);

  const toggleTheme = () => setIsDark(!isDark);

  return (
    <ThemeContext.Provider value={{ theme, isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
