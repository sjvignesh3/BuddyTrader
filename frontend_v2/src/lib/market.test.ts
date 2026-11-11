import { describe, expect, it } from "vitest";
import {
  currencySymbol, dailyJobType, fmtMarketCap, fmtPrice, marketOf, plainSymbol,
  poolMarket, tvChartUrl, tvSymbol,
} from "./market";

describe("marketOf", () => {
  it("reads the market off the symbol", () => {
    expect(marketOf("TCS.NS")).toBe("IN");
    expect(marketOf("500325.BO")).toBe("IN");
    expect(marketOf("tcs.ns")).toBe("IN");
    expect(marketOf("NVDA")).toBe("US");
    expect(marketOf("BRK-B")).toBe("US");
  });
  it("a pool without the column is Indian", () => {
    expect(poolMarket({})).toBe("IN");
    expect(poolMarket(undefined)).toBe("IN");
    expect(poolMarket({ market: "US" })).toBe("US");
  });
  it("plain symbol strips only the Indian suffix", () => {
    expect(plainSymbol("TCS.NS")).toBe("TCS");
    expect(plainSymbol("NVDA")).toBe("NVDA");
    expect(plainSymbol("BRK-B")).toBe("BRK-B");
  });
  it("per-market facts", () => {
    expect(currencySymbol("IN")).toBe("₹");
    expect(currencySymbol("US")).toBe("$");
    expect(dailyJobType("IN")).toBe("daily_sync");
    expect(dailyJobType("US")).toBe("daily_sync_us");
  });
});

describe("formatting", () => {
  it("groups digits the market's way", () => {
    expect(fmtPrice(1234567.5, "IN")).toBe("12,34,567.50");
    expect(fmtPrice(1234567.5, "US")).toBe("1,234,567.50");
    expect(fmtPrice("859.99", "US")).toBe("859.99");
    expect(fmtPrice(null, "US")).toBe("—");
    expect(fmtPrice("abc", "IN")).toBe("—");
  });
  it("market cap: crores for India, T / B / M for the US", () => {
    expect(fmtMarketCap("17253400000000", "IN")).toBe(`₹17,25,340${String.fromCharCode(160)}Cr`);
    expect(fmtMarketCap(4078186790912, "US")).toBe("$4.08T");
    expect(fmtMarketCap("122367426560", "US")).toBe("$122.4B");
    expect(fmtMarketCap(850_000_000, "US")).toBe("$850M");
    expect(fmtMarketCap(null, "US")).toBe("—");
    expect(fmtMarketCap(0, "IN")).toBe("—");
  });
});

describe("TradingView", () => {
  it("builds exchange-qualified symbols", () => {
    expect(tvSymbol("SNDK", "NASDAQ")).toBe("NASDAQ:SNDK");
    expect(tvSymbol("CAT", "NYSE")).toBe("NYSE:CAT");
    expect(tvSymbol("BRK-B", "NYSE")).toBe("NYSE:BRK.B");
    expect(tvSymbol("NVDA", null)).toBe("NVDA");
    expect(tvSymbol("NVDA", "NSE")).toBe("NVDA");          // a wrong exchange is ignored
    expect(tvSymbol("DIXON.NS", "NSE")).toBe("NSE:DIXON");
    expect(tvSymbol("500325.BO")).toBe("BSE:500325");
  });
  it("links to the chart page", () => {
    expect(tvChartUrl("SNDK", "NASDAQ"))
      .toBe("https://www.tradingview.com/chart/?symbol=NASDAQ%3ASNDK");
    expect(tvChartUrl("DIXON.NS"))
      .toBe("https://in.tradingview.com/chart/?symbol=NSE%3ADIXON");
  });
});
