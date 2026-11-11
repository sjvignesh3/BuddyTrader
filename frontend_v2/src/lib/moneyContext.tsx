// -----------------------------------------------------------------------------
// Which market the journal UI under this point is showing — and therefore
// which currency sign, digit grouping and quantity rule it uses.
//
// The default is India, so every screen that never mounts a provider (Net
// Worth, Expenses, the Indian journal…) formats exactly as it always did.
// The Journal page, the Position Sizer and a US stock page wrap their subtree
// in <MoneyProvider market="US"> and the shared journal components pick it up
// through useMoney() — no market prop threaded through every table and modal.
//
// Nothing is converted: a US amount is dollars, an Indian one rupees.
// -----------------------------------------------------------------------------
import { createContext, useContext, type ReactNode } from "react";
import { currencySymbol, fmtPrice, type Market } from "./market";
import { fmtMoney as fmtInr } from "./money";

export interface Money {
  market: Market;
  /** "₹" or "$". */
  cur: string;
  /** Amount in the market's digit grouping, WITHOUT the currency sign. */
  fmtMoney: (value: string | number | null | undefined, digits?: number) => string;
  /** Number-formatting locale for this market ("en-IN" | "en-US"). */
  locale: string;
  /** US shares may be fractional (4 decimals); Indian ones are whole. */
  fractionalQty: boolean;
  /**
   * Fewest decimals an AMOUNT is shown with. India 0: totals and gains read
   * in whole rupees. US 2: a small dollar account moves in cents, so "+0"
   * would hide a real +$0.46 — every US amount shows cents.
   */
  minDigits: number;
  /** A round figure the owner typed (capital) — never padded with ".00". */
  fmtWhole: (value: string | number | null | undefined) => string;
}

/** Quantity for display: "10", "2.5", "0.3333" — never trailing zeros. */
export function fmtQty(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return String(Math.round(n * 10_000) / 10_000);
}

/** Parse a typed quantity. India: positive whole number (rounded, as the
 *  forms always did). US: positive, kept to 4 decimals. Blank / junk → null. */
export function qtyOrNull(market: Market, s: string): number | null {
  const t = s.trim().replace(/,/g, "");
  if (t === "") return null;
  const raw = Number(t);
  if (!Number.isFinite(raw)) return null;
  const n = market === "US" ? Math.round(raw * 10_000) / 10_000 : Math.round(raw);
  return n > 0 ? n : null;
}

/** Non-empty but not a valid quantity — the "block Save" state. */
export function badQty(market: Market, s: string): boolean {
  return s.trim() !== "" && qtyOrNull(market, s) === null;
}

export function moneyFor(market: Market): Money {
  return market === "US"
    ? { market, cur: currencySymbol("US"), locale: "en-US", fractionalQty: true,
        minDigits: 2,
        fmtMoney: (v, digits = 2) => fmtPrice(v, "US", Math.max(digits, 2)),
        // Whole dollars when the figure is round, cents when it is not.
        fmtWhole: (v) => fmtPrice(v, "US", Number.isInteger(Number(v)) ? 0 : 2) }
    : { market: "IN", cur: currencySymbol("IN"), locale: "en-IN", fractionalQty: false,
        minDigits: 0,
        fmtMoney: (v, digits = 2) => fmtInr(v, digits),
        fmtWhole: (v) => fmtInr(v, 0) };
}

const IN_MONEY = moneyFor("IN");
const US_MONEY = moneyFor("US");
const MoneyContext = createContext<Money>(IN_MONEY);

export function MoneyProvider({ market, children }: { market: Market; children: ReactNode }) {
  return (
    <MoneyContext.Provider value={market === "US" ? US_MONEY : IN_MONEY}>
      {children}
    </MoneyContext.Provider>
  );
}

/** Currency + quantity rules of the nearest MoneyProvider (India by default). */
export function useMoney(): Money {
  return useContext(MoneyContext);
}

/** React-query key for a journal resource: India keeps the historic keys
 *  (["journal", …]); US gets ["journal", "US", …]. Invalidating ["journal"]
 *  still refreshes both. */
export function jkey(market: Market, ...parts: (string | number)[]): (string | number)[] {
  return market === "US" ? ["journal", "US", ...parts] : ["journal", ...parts];
}
