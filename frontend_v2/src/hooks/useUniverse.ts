// -----------------------------------------------------------------------------
// Universe queries + mutations. Any membership change invalidates the pool
// views too (["stocks", …], ["snapshots", …]) — the universe is what they
// read, so they must never show a stale member list.
// -----------------------------------------------------------------------------
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { universeApi, type ImportRow, type ScreenCriteria, type StockDraft } from "../lib/universeApi";

export const universeKeys = {
  all: ["universe"] as const,
  root: (includeInactive: boolean) => ["universe", "root", includeInactive] as const,
  criteria: (pool: string) => ["universe", "criteria", pool] as const,
  syncs: (pool?: string) => ["universe", "syncs", pool ?? "all"] as const,
};

export function useUniverse(includeInactive = false) {
  return useQuery({
    queryKey: universeKeys.root(includeInactive),
    queryFn: () => universeApi.get(includeInactive),
    staleTime: 60_000,
  });
}

export function useScreenCriteria(pool: string) {
  return useQuery({
    queryKey: universeKeys.criteria(pool),
    queryFn: () => universeApi.criteria(pool),
    staleTime: 5 * 60_000,
  });
}

export function useUniverseSyncs(pool?: string) {
  return useQuery({
    queryKey: universeKeys.syncs(pool),
    queryFn: () => universeApi.syncs(pool),
    staleTime: 60_000,
  });
}

/** Everything that mutates membership, with cache invalidation wired once. */
export function useUniverseMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: universeKeys.all });
    qc.invalidateQueries({ queryKey: ["stocks"] });
    qc.invalidateQueries({ queryKey: ["snapshots"] });
    qc.invalidateQueries({ queryKey: ["stock"] });
  };
  const addMember = useMutation({
    mutationFn: (v: { pool: string; symbol: string; draft?: StockDraft }) =>
      universeApi.addMember(v.pool, v.symbol, v.draft),
    onSuccess: refresh,
  });
  const removeMember = useMutation({
    mutationFn: (v: { pool: string; symbol: string }) =>
      universeApi.removeMember(v.pool, v.symbol),
    onSuccess: refresh,
  });
  const updateStock = useMutation({
    mutationFn: (v: { symbol: string; draft: StockDraft }) =>
      universeApi.updateStock(v.symbol, v.draft),
    onSuccess: refresh,
  });
  const importMembers = useMutation({
    mutationFn: (v: { pool: string; rows: ImportRow[]; mode: "merge" | "replace"; dryRun: boolean }) =>
      universeApi.importMembers(v.pool, v.rows, v.mode, v.dryRun),
    onSuccess: (r) => { if (!r.dry_run) refresh(); },
  });
  const saveCriteria = useMutation({
    mutationFn: (v: { pool: string; criteria: ScreenCriteria }) =>
      universeApi.saveCriteria(v.pool, v.criteria),
    onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: universeKeys.criteria(v.pool) }),
  });
  const startScreen = useMutation({
    mutationFn: (pool: string) => universeApi.startScreen(pool),
    onSuccess: () => qc.invalidateQueries({ queryKey: universeKeys.all }),
  });
  return { addMember, removeMember, updateStock, importMembers, saveCriteria, startScreen };
}
