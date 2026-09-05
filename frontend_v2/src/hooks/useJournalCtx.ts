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
import { buildOpenInvested, num, type JournalCtx } from "../lib/journal";

/** yfinance stores "TCS.NS"; the journal uses plain "TCS". */
export const plainSymbol = (s: string): string => s.replace(/\.(NS|BO)$/i, "");

/** Query both spellings so either storage convention resolves. */
export const bothSpellings = (symbols: string[]): string[] =>
  symbols.flatMap((s) => (s.includes(".") ? [s] : [s, `${s}.NS`]));

export function useJournalCtx(extraSymbols: string[] = []) {
  // Callers pass literals; key on the joined string so identity churn
  // doesn't re-run the memo (and re-fire the snapshot query) every render.
  const extraKey = extraSymbols.map((x) => plainSymbol(x.toUpperCase())).filter(Boolean).join(",");
  const settingsQ = useQuery({
    queryKey: ["journal", "settings"] as const,
    queryFn: journalApi.settings,
  });
  const tradesQ = useQuery({
    queryKey: ["journal", "trades"] as const,
    queryFn: () => journalApi.trades(),
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
    queryKey: ["journal", "snapshots", symbols.join(",")] as const,
    queryFn: () => api.latestSnapshotsForSymbols(bothSpellings(symbols)),
    enabled: symbols.length > 0,
    staleTime: 60_000,
  });

  const ctx: JournalCtx = useMemo(() => {
    const snaps = new Map<string, Snapshot>();
    (snapsQ.data?.snapshots ?? []).forEach((s) => snaps.set(plainSymbol(s.symbol), s));
    return {
      capital: num(settingsQ.data?.settings.capital) ?? 0,
      snaps,
      openInvested: buildOpenInvested(openTrades),
    };
  }, [settingsQ.data, snapsQ.data, openTrades]);

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
