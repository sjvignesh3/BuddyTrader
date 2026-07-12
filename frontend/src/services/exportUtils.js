/**
 * exportUtils.js
 * CSV export utility for pool scan results.
 * Exports all main columns + expanded accordion strategy details as flattened rows.
 * File naming: {POOL}_{YYYY-MM-DD}.csv
 */

/**
 * Escapes a single CSV cell value.
 * Wraps in quotes if the value contains commas, quotes, or newlines.
 */
function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Converts an array of row arrays into a CSV string.
 */
function toCSVString(rows) {
  return rows.map(row => row.map(escapeCSV).join(',')).join('\n');
}

/**
 * Formats today's date as YYYY-MM-DD.
 */
function getTodayDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Maps best_status codes to human-readable labels.
 */
function formatStatus(status) {
  const map = {
    BUY_ZONE:    'Buy Zone',
    OPPORTUNITY: 'Opportunity',
    VALID:       '20% Rally',
    INVALID:     'No Rally',
    NO_SIGNAL:   'No Signal',
  };
  return map[status] || status || '—';
}

/**
 * Main export function.
 *
 * CSV structure per stock:
 *   — 1 main row with all core columns
 *   — N strategy sub-rows (one per strategy_result), indented under the stock
 *
 * Columns:
 *   Main:     Symbol, Sector, Cap Type, Close, 200 DMA, % Below DMA,
 *             52W Low, 52W High, % From Low, ATH, % Down ATH, Signal, Score
 *   Strategy: (blank symbol), Strategy Name, Status, Score, Reasons,
 *             Next Buy At, Next Sell At, Days Since Last Rally
 *
 * @param {Array}  results   - Array of stock result objects (filteredResults)
 * @param {string} poolCode  - e.g. 'F40', 'E40', 'S200', 'PlayArea'
 */
export function exportPoolToCSV(results, poolCode) {
  if (!results || results.length === 0) return;

  const date = getTodayDate();
  const fileName = `${poolCode}_${date}.csv`;

  // ── Section 1: Scan metadata header ─────────────────────────────────────
  const metaRows = [
    [`Pool: ${poolCode}`, `Export Date: ${date}`, `Total Stocks: ${results.length}`],
    [], // blank spacer
  ];

  // ── Section 2: Column headers ────────────────────────────────────────────
  const mainHeaders = [
    'Symbol', 'Sector', 'Cap Type', 'Close (₹)', '200 DMA',
    '% Below DMA', '52W Low', '52W High', '% From Low',
    'ATH', '% Down ATH', 'Signal', 'Score',
  ];

  // Strategy sub-row headers (shifted right by 1 col for visual grouping)
  const stratHeaders = [
    '',                   // blank Symbol col — visually indented
    'Strategy Name', 'Strategy Status', 'Strategy Score', 'Reasons',
    'Next Buy At (₹)', 'Next Sell At (₹)', 'Days Since Last Rally',
  ];

  const allRows = [
    ...metaRows,
    mainHeaders,
  ];

  // ── Section 3: Data rows ─────────────────────────────────────────────────
  results.forEach((stock) => {
    // Main row
    allRows.push([
      stock.symbol                          ?? '',
      stock.sector                          ?? '',
      stock.cap_type                        ?? '',
      stock.close           != null ? stock.close.toFixed(2)                    : '',
      stock.dma_200         != null ? stock.dma_200.toFixed(2)                  : '',
      stock.below_200dma_pct != null ? stock.below_200dma_pct.toFixed(2) + '%'  : '',
      stock.low_52w         != null ? stock.low_52w.toFixed(2)                  : '',
      stock.high_52w        != null ? stock.high_52w.toFixed(2)                 : '',
      stock.distance_from_52w_low_pct != null
        ? stock.distance_from_52w_low_pct.toFixed(2) + '%'                      : '',
      stock.ath             != null ? stock.ath.toFixed(2)                      : '',
      stock.down_from_ath_pct != null ? stock.down_from_ath_pct.toFixed(2) + '%': '',
      formatStatus(stock.best_status),
      stock.best_score      ?? '',
    ]);

    // Strategy accordion sub-rows
    if (stock.strategy_results && stock.strategy_results.length > 0) {
      // Print strategy sub-header once per stock block
      allRows.push(stratHeaders);

      stock.strategy_results.forEach((sr) => {
        const reasons = (sr.reasons || []).join(' | ');
        const isRally = sr.strategy_id === 'rally_20_percent';

        allRows.push([
          '',                                                   // blank symbol col
          sr.strategy_name                ?? '',
          formatStatus(sr.status),
          sr.score                        ?? '',
          reasons,
          isRally && sr.next_buy_at  != null ? sr.next_buy_at.toFixed(2)  : '',
          isRally && sr.next_sell_at != null ? sr.next_sell_at.toFixed(2) : '',
          isRally && sr.days_since_last_rally != null
            ? sr.days_since_last_rally + ' days'               : '',
        ]);
      });

      // Blank separator between stocks for readability
      allRows.push([]);
    }
  });

  // ── Trigger download ─────────────────────────────────────────────────────
  const csvContent = '\uFEFF' + toCSVString(allRows); // BOM for Excel UTF-8 compatibility
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href     = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();

  // Cleanup
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);
}
