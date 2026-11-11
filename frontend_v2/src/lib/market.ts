// -----------------------------------------------------------------------------
// Markets — India (IN) and the US, display side. Mirrors plutus/markets.py.
//
// A stock's market is read off its symbol: Indian symbols carry an exchange
// suffix ("TCS.NS", "500325.BO"); US symbols are the plain Yahoo ticker
// ("NVDA", "BRK-B"). A pool carries its market in `pools.market` (absent on a
// database that has not had migration 026 applied — treated as IN).
//
// Nothing is converted between currencies: a US price is shown in dollars,
// an Indian one in rupees, and the two are never added together.
// -----------------------------------------------------------------------------
import type { Pool, Stock } from "./api";

export type Market = "IN" | "US";

const IN_SUFFIX = /\.(NS|BO)$/i;
const NBSP = String.fromCharCode(160);

export function marketOf(symbol: string | null | undefined): Market {
  return symbol && IN_SUFFIX.test(symbol.trim()) ? "IN" : "US";
}

export function poolMarket(pool: Pick<Pool, "market"> | null | undefined): Market {
  return pool?.market === "US" ? "US" : "IN";
}

/** Symbol without the Indian exchange suffix — what people read and type. */
export function plainSymbol(symbol: string): string {
  return symbol.replace(IN_SUFFIX, "");
}

export function currencySymbol(market: Market): string {
  return market === "US" ? "$" : "₹";
}

/** Daily-sync job type per market (sync_jobs.job_type). */
export function dailyJobType(market: Market): string {
  return market === "US" ? "daily_sync_us" : "daily_sync";
}

/** A price in the market's own digit grouping — no currency sign. */
export function fmtPrice(value: number | string | null | undefined,
                         market: Market, digits = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(market === "US" ? "en-US" : "en-IN", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

/**
 * Market cap from the ABSOLUTE value the API sends (rupees or dollars):
 * "₹17,25,340 Cr" for India, "$4.08T" / "$122.4B" / "$850M" for the US.
 */
export function fmtMarketCap(value: number | string | null | undefined,
                             market: Market): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (market === "IN") {
    return `₹${(n / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 0 })}${NBSP}Cr`;
  }
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  return `$${(n / 1e6).toFixed(0)}M`;
}

/**
 * Exchange-qualified TradingView symbol: "NASDAQ:SNDK", "NYSE:CAT",
 * "NSE:DIXON", "BSE:500325". US share classes use a dot there ("NYSE:BRK.B")
 * where Yahoo uses a dash. An unknown US exchange falls back to the bare
 * ticker, which TradingView resolves by itself.
 */
export function tvSymbol(symbol: string, exchange?: string | null): string {
  if (marketOf(symbol) === "IN") {
    return `${/\.BO$/i.test(symbol) ? "BSE" : "NSE"}:${plainSymbol(symbol)}`;
  }
  const ticker = symbol.replace("-", ".");
  const ex = (exchange ?? "").toUpperCase();
  return ex === "NASDAQ" || ex === "NYSE" || ex === "AMEX" ? `${ex}:${ticker}` : ticker;
}

/** Full TradingView chart page for a stock. */
export function tvChartUrl(symbol: string, exchange?: string | null): string {
  const host = marketOf(symbol) === "IN" ? "in.tradingview.com" : "www.tradingview.com";
  return `https://${host}/chart/?symbol=${encodeURIComponent(tvSymbol(symbol, exchange))}`;
}

/** Symbol → listing exchange, for building TradingView links from a row. */
export function exchangeMap(stocks: Stock[] | undefined): Map<string, string> {
  return new Map((stocks ?? []).map((s) => [s.symbol, s.exchange]));
}
