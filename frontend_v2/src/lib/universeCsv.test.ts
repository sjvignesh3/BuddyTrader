import { describe, expect, it } from "vitest";
import { parseUniverseCsv, universeToCsv } from "./universeCsv";
import type { UniverseStock } from "./universeApi";

const MASTER = [
  "List,Sector,Short Form,Category,For TV,Market Cap,,Ticker,Cap Type,,,,SNo,Stategy,Flagship 40 (F40)",
  'EICHERMOT,AUTO,E40,Emerging 40,"EICHERMOT,",Large Cap,,RELIANCE,Large Cap,,,,1,Long Envelope,X',
  'HDFCBANK,BANKS,F40,Flagship 40,"HDFCBANK,",Large Cap,,HDFCBANK,Large Cap,,,,2,Short Envelope,X',
  'TCS,Normal,S200,Smartpick 200,"TCS,",Large Cap,,BHARTIARTL,Large Cap,,,,3,Envelope + Knox,X',
  'BAJFINANCE,NBFC,S200,Smartpick 200,"BAJFINANCE,",Large Cap,,ICICIBANK,Large Cap,,,,4,52W High Low,X',
  ',,,,,,,INFY,Large Cap,,,,5,,',                       // right-hand table only
].join("\n");

describe("parseUniverseCsv", () => {
  it("reads the master template and keeps only the requested pool", () => {
    const p = parseUniverseCsv(MASTER, "S200");
    expect(p.layout).toBe("master-template");
    expect(p.rows.map((r) => r.symbol)).toEqual(["TCS", "BAJFINANCE"]);
    expect(p.rows[0]).toEqual({ symbol: "TCS", sector: "Normal", cap_type: "Large Cap" });
    expect(p.skippedOtherPool).toBe(2);
    expect(p.columns).toEqual(["symbol", "sector", "cap_type"]);
  });

  it("reads a plain header with group and cap columns", () => {
    const p = parseUniverseCsv(
      "Symbol,Name,Sector,Cap,Group\nhdfcbank,HDFC Bank,BANKS,Large,Banks\nTCS,,IT,#N/A,\n", "F40");
    expect(p.layout).toBe("plain");
    expect(p.rows).toEqual([
      { symbol: "hdfcbank", name: "HDFC Bank", sector: "BANKS", cap_type: "Large", sector_group: "Banks" },
      { symbol: "TCS", sector: "IT" },
    ]);
  });

  it("falls back to a one-column symbol list", () => {
    const p = parseUniverseCsv("TCS\nINFY.NS\nnot a symbol\n", "E40");
    expect(p.layout).toBe("symbols-only");
    expect(p.rows.map((r) => r.symbol)).toEqual(["TCS", "INFY.NS"]);
  });

  it("explains an empty pool filter", () => {
    expect(() => parseUniverseCsv(MASTER, "PlayArea")).toThrow(/No rows tagged "PlayArea"/);
  });
});

describe("universeToCsv", () => {
  const stock = (symbol: string, pools: string[]): UniverseStock => ({
    id: 1, symbol, name: "", sector: "IT", industry: null, exchange: "NSE", active: true,
    pools, cap_type_manual: "Large", sector_group: "Normal", metadata: {},
  });
  it("round-trips through the importer", () => {
    const csv = universeToCsv([stock("TCS.NS", ["F40", "S200"]), stock("INFY.NS", ["E40"])], "F40");
    expect(csv.split("\n")).toEqual([
      "Symbol,Name,Sector,Cap,Group,Pools,Active",
      "TCS,,IT,Large,Normal,F40 S200,yes",
    ]);
    const back = parseUniverseCsv(csv, "F40");
    expect(back.rows).toEqual([{ symbol: "TCS", sector: "IT", cap_type: "Large", sector_group: "Normal" }]);
  });
});
