// -----------------------------------------------------------------------------
// Shared Journal context for the tools that sit on top of it (Position Sizer,
// Net Worth). Fetches capital + all trades, then the latest snapshot for every
// symbol with an open lot, and folds them into the same JournalCtx the Journal
// page builds — so allocation %, holdings and portfolio value are computed by
// exactly one set of rules (lib/journal.ts).
//
// Cache keys live under ["journal", …] on purpose: a write from any tool
// invalidates the whole journal family, exactly like JournalPage does.
// -----------------------------------------------------------------------------
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Snapshot } from "../lib/api";
import { journalApi, type Trade } from "../lib/journalApi";
import {
  buildOpenInvested, journalSnaps, num, snapshotSymbols, type JournalCtx,
} from "../lib/journal";
import type { Market } from "../lib/market";
import { jkey } from "../lib/moneyContext";

/** yfinance stores "TCS.NS"; the journal uses plain "TCS". */
export const plainSymbol = (s: string): string => s.replace(/\.(NS|BO)$/i, "");

/** Query both spellings so either storage convention resolves. */
export const bothSpellings = (symbols: string[]): string[] =>
  symbols.flatMap((s) => (s.includes(".") ? [s] : [s, `${s}.NS`]));

export function useJournalCtx(extraSymbols: string[] = [], market: Market = "IN") {
  // Callers pass literals; key on the joined string so identity churn
  // doesn't re-run the memo (and re-fire the snapshot query) every render.
  const extraKey = extraSymbols.map((x) => plainSymbol(x.toUpperCase())).filter(Boolean).join(",");
  const settingsQ = useQuery({
    queryKey: ["journal", "settings"] as const,
    queryFn: journalApi.settings,
  });
  const tradesQ = useQuery({
    queryKey: jkey(market, "trades"),
    queryFn: () => journalApi.trades(undefined, market),
  });

  const trades: Trade[] = useMemo(() => tradesQ.data?.trades ?? [], [tradesQ.data]);
  const openTrades = useMemo(() => trades.filter((t) => t.status === "OPEN"), [trades]);
  const closedTrades = useMemo(() => trades.filter((t) => t.status === "CLOSED"), [trades]);

  const symbols = useMemo(() => {
    const s = new Set<string>();
    openTrades.forEach((t) => s.add(t.symbol));
    extraKey.split(",").forEach((x) => x && s.add(x));
    return [...s].sort();
  }, [openTrades, extraKey]);

  const snapsQ = useQuery({
    queryKey: jkey(market, "snapshots", symbols.join(",")),
    queryFn: () => api.latestSnapshotsForSymbols(
      market === "US" ? snapshotSymbols(symbols, "US") : bothSpellings(symbols)),
    enabled: symbols.length > 0,
    staleTime: 60_000,
  });

  const ctx: JournalCtx = useMemo(() => {
    // Each journal sees ITS market's snapshots only — a plain symbol must
    // never resolve to the other market's ticker of the same spelling. US
    // rows are also tagged with the US rule cap.
    let snaps: Map<string, Snapshot>;
    if (market === "US") {
      snaps = journalSnaps(snapsQ.data?.snapshots ?? [], "US");
    } else {
      snaps = journalSnaps(snapsQ.data?.snapshots ?? [], "IN");
    }
    const settings = settingsQ.data?.settings;
    return {
      capital: num(market === "US" ? settings?.capital_usd : settings?.capital) ?? 0,
      snaps,
      openInvested: buildOpenInvested(openTrades),
      market,
    };
  }, [settingsQ.data, snapsQ.data, openTrades, market]);

  return {
    ctx,
    openTrades,
    closedTrades,
    snapshotDate: snapsQ.data?.snapshot_date ?? null,
    isLoading: settingsQ.isLoading || tradesQ.isLoading,
    snapsLoading: snapsQ.isLoading,
    error: settingsQ.error ?? tradesQ.error ?? null,
    snapsError: snapsQ.error ?? null,
  };
}
