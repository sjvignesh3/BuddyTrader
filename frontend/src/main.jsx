import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

/* Global styles injected once */
const style = document.createElement('style');
style.textContent = `
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Hide all scrollbars globally */
  ::-webkit-scrollbar {
    width: 0;
    height: 0;
    display: none;
  }

  * {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  /* Spinner animation */
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  /* Smooth transitions for theme changes */
  body, #root {
    transition: background 0.25s ease, color 0.25s ease;
  }

  /* Focus ring */
  select:focus, button:focus-visible, input:focus-visible {
    outline: 2px solid #4A7FDB;
    outline-offset: 2px;
  }

  button:focus:not(:focus-visible) {
    outline: none;
  }

  /* Tooltip */
  [data-tooltip] {
    position: relative;
  }
  [data-tooltip]:hover::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 8px;
    background: #1C2536;
    color: #fff;
    font-size: 11px;
    border-radius: 4px;
    white-space: nowrap;
    z-index: 99;
    margin-bottom: 4px;
  }
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
