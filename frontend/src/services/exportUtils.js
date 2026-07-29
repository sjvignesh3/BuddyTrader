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
 * Rally-specific pools that carry streak / re-entry columns on the main row.
 */
const RALLY_POOLS = new Set(['S200', 'PlayArea']);

/**
 * Main export function.
 *
 * CSV structure per stock:
 *   — 1 main row with all core columns
 *       Rally pools also get: Streak %, % to Next Buy, Days Since Streak
 *   — N strategy sub-rows (one per strategy_result), indented under the stock
 *       Rally strategy rows also get: Streak %, % to Next Buy, Days Since Streak
 *
 * Columns (standard pools — F40 / E40):
 *   Main:     Symbol, Sector, Cap Type, Close, 200 DMA, % Below DMA,
 *             52W Low, 52W High, % From Low, ATH, % Down ATH, Signal, Score
 *
 * Columns (rally pools — S200 / PlayArea):
 *   Main:     Symbol, Sector, Cap Type, Close, 200 DMA, % Below DMA,
 *             52W Low, 52W High, % From Low, ATH, % Down ATH,
 *             Streak %, % to Next Buy, Days Since Streak
 *
 *   Strategy sub-rows (all pools):
 *             (blank symbol), Strategy Name, Status, Score, Reasons,
 *             Next Buy At, Next Sell At, Streak %, % to Next Buy, Days Since Streak
 *
 * @param {Array}  results   - Array of stock result objects (filteredResults)
 * @param {string} poolCode  - e.g. 'F40', 'E40', 'S200', 'PlayArea'
 */
export function exportPoolToCSV(results, poolCode) {
  if (!results || results.length === 0) return;

  const date       = getTodayDate();
  const fileName   = `${poolCode}_${date}.csv`;
  const isRallyPool = RALLY_POOLS.has(poolCode);

  // ── Section 1: Scan metadata header ─────────────────────────────────────
  const metaRows = [
    [`Pool: ${poolCode}`, `Export Date: ${date}`, `Total Stocks: ${results.length}`],
    [], // blank spacer
  ];

  // ── Section 2: Column headers ────────────────────────────────────────────

  // Base columns shared by every pool
  const BASE_HEADERS = [
    'Symbol', 'Sector', 'Cap Type', 'Close (₹)', '200 DMA',
    '% Below DMA', '52W Low', '52W High', '% From Low',
    'ATH', '% Down ATH',
  ];

  // Tail columns differ by pool type
  const RALLY_TAIL_HEADERS    = ['Streak %', '% to Next Buy', 'Days Since Streak'];
  const STANDARD_TAIL_HEADERS = ['Signal', 'Score'];

  const mainHeaders = isRallyPool
    ? [...BASE_HEADERS, ...RALLY_TAIL_HEADERS]
    : [...BASE_HEADERS, ...STANDARD_TAIL_HEADERS];

  // Strategy sub-row headers — shifted right by 1 blank col for visual indent
  const stratHeaders = [
    '',  // blank Symbol col — visually indented under parent stock
    'Strategy Name', 'Strategy Status', 'Strategy Score', 'Reasons',
    'Next Buy At (₹)', 'Next Sell At (₹)',
    'Streak %', '% to Next Buy', 'Days Since Streak',
  ];

  const allRows = [
    ...metaRows,
    mainHeaders,
  ];

  // ── Section 3: Data rows ─────────────────────────────────────────────────
  results.forEach((stock) => {

    // ── Base cells (same for all pools) ─────────────────────────────────
    const baseValues = [
      stock.symbol                                                              ?? '',
      stock.sector                                                              ?? '',
      stock.cap_type                                                            ?? '',
      stock.close              != null ? stock.close.toFixed(2)                 : '',
      stock.dma_200            != null ? stock.dma_200.toFixed(2)               : '',
      stock.below_200dma_pct   != null ? stock.below_200dma_pct.toFixed(2) + '%': '',
      stock.low_52w            != null ? stock.low_52w.toFixed(2)               : '',
      stock.high_52w           != null ? stock.high_52w.toFixed(2)              : '',
      stock.distance_from_52w_low_pct != null
        ? stock.distance_from_52w_low_pct.toFixed(2) + '%'                      : '',
      stock.ath                != null ? stock.ath.toFixed(2)                   : '',
      stock.down_from_ath_pct  != null ? stock.down_from_ath_pct.toFixed(2) + '%': '',
    ];

    // ── Tail cells (pool-specific) ────────────────────────────────────────
    const tailValues = isRallyPool
      ? [
          // Streak % — magnitude of the most recent qualifying rally
          stock.last_rally_pct       != null ? stock.last_rally_pct.toFixed(2) + '%'  : '',
          // % to Next Buy — how far price is above re-entry low (≤0 = in buy zone)
          stock.pct_to_next_buy      != null
            ? (stock.pct_to_next_buy > 0 ? '+' : '') + stock.pct_to_next_buy.toFixed(2) + '%'
            : '',
          // Days Since Streak — trading days since the last qualifying streak ended
          stock.days_since_last_rally != null ? stock.days_since_last_rally + 'd'      : '',
        ]
      : [
          formatStatus(stock.best_status),
          stock.best_score ?? '',
        ];

    allRows.push([...baseValues, ...tailValues]);

    // ── Strategy accordion sub-rows ───────────────────────────────────────
    if (stock.strategy_results && stock.strategy_results.length > 0) {
      // Print strategy sub-header once per stock block
      allRows.push(stratHeaders);

      stock.strategy_results.forEach((sr) => {
        const reasons  = (sr.reasons || []).join(' | ');
        const isRally  = sr.strategy_id === 'rally_20_percent';

        allRows.push([
          '',                                                    // blank symbol col (indent)
          sr.strategy_name ?? '',
          formatStatus(sr.status),
          sr.score         ?? '',
          reasons,

          // Next Buy / Sell — rally strategy only
          isRally && sr.next_buy_at  != null ? sr.next_buy_at.toFixed(2)   : '',
          isRally && sr.next_sell_at != null ? sr.next_sell_at.toFixed(2)  : '',

          // ── NEW: Streak %, % to Next Buy, Days Since Streak ─────────────
          // These fields live on the strategy result for rally strategy,
          // and on the top-level stock object for rally pools.
          // Pull from sr first; fall back to top-level stock fields.
          (() => {
            const v = sr.last_rally_pct ?? (isRally ? stock.last_rally_pct : null);
            return v != null ? v.toFixed(2) + '%' : '';
          })(),
          (() => {
            const v = sr.pct_to_next_buy ?? (isRally ? stock.pct_to_next_buy : null);
            return v != null
              ? (v > 0 ? '+' : '') + v.toFixed(2) + '%'
              : '';
          })(),
          (() => {
            const v = sr.days_since_last_rally ?? (isRally ? stock.days_since_last_rally : null);
            return v != null ? v + 'd' : '';
          })(),
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
