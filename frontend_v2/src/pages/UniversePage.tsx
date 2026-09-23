// -----------------------------------------------------------------------------
// Universe — the one list every Market Analysis pool, scan and journal lookup
// reads from. Per pool: members table, add / edit / remove, CSV import with
// a consent preview, CSV export. S200 additionally shows its screening
// criteria and the Screener sync entry point.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import LoadError from "../components/LoadError";
import { OwnerOnly } from "../components/AuthGate";
import ImportModal from "../components/universe/ImportModal";
import PasteModal from "../components/universe/PasteModal";
import ScreenCriteriaCard from "../components/universe/ScreenCriteriaCard";
import StockFormModal from "../components/universe/StockFormModal";
import UniverseTable from "../components/universe/UniverseTable";
import { ConfirmDialog, GhostBtn, PrimaryBtn } from "../components/journal/ui";
import { useUniverse, useUniverseMutations } from "../hooks/useUniverse";
import { fmtDateTime } from "../lib/money";
import { plainSymbol, type ImportResult, type PasteResult, type UniverseStock } from "../lib/universeApi";
import { downloadCsv, universeToCsv } from "../lib/universeCsv";

const POOL_META: Record<string, { icon: string; kind: string; blurb: string }> = {
  F40: { icon: "🏛️", kind: "Qualitative · Large & Mid", blurb: "Hand-picked flagship names. Edit freely." },
  E40: { icon: "🌱", kind: "Qualitative · Mid & Small", blurb: "Hand-picked emerging names. Edit freely." },
  S200: { icon: "📈", kind: "Quantitative · every quarter",
          blurb: "Built by screening. Imported by hand until the Screener sync is wired." },
  PlayArea: { icon: "⚡", kind: "Tactical", blurb: "Browser watchlist lives on the pool page." },
};
const TABS = ["F40", "E40", "S200", "ALL"] as const;

export default function UniversePage() {
  const [showInactive, setShowInactive] = useState(false);
  const { data, isLoading, error } = useUniverse(showInactive);
  const m = useUniverseMutations();
  const [tab, setTab] = useState<(typeof TABS)[number]>("F40");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<{ initial: UniverseStock | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [removing, setRemoving] = useState<UniverseStock | null>(null);
  const [flash, setFlash] = useState<{ text: string; err?: boolean } | null>(null);

  const pool = tab === "ALL" ? null : tab;
  const stocks = useMemo(() => {
    const all = data?.stocks ?? [];
    return pool ? all.filter((s) => (s.pools ?? []).includes(pool)) : all;
  }, [data, pool]);

  const say = (text: string, err = false) => {
    setFlash({ text, err });
    window.setTimeout(() => setFlash(null), 6000);
  };
  const onErr = (e: unknown) => say(e instanceof Error ? e.message : String(e), true);

  if (isLoading || error || !data) return <LoadError loading={isLoading} error={error} />;

  const editable = pool !== null && data.editable_pools.includes(pool);
  const lastSync = pool ? data.last_syncs[pool] : undefined;
  const busy = m.addMember.isPending || m.updateStock.isPending || m.removeMember.isPending
    || m.importMembers.isPending || m.pasteMembers.isPending;

  const exportCsv = () =>
    downloadCsv(`plutus-universe-${pool ?? "all"}-${new Date().toISOString().slice(0, 10)}.csv`,
                universeToCsv(data.stocks, pool));

  const onPasteClosed = (r?: PasteResult) => {
    setPasting(false);
    if (r) say(`${r.pool}: +${r.diff.added.length} added, −${r.diff.removed.length} removed (${r.fetched} looked up${r.failed ? `, ${r.failed} without details` : ""}).`);
  };

  const onImportClosed = (r?: ImportResult) => {
    setImporting(false);
    if (r) say(`Imported into ${r.pool}: +${r.diff.added.length} added, ${r.diff.updated.length} updated, −${r.diff.removed.length} removed.`);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <div className="text-[11px] text-brand-mute">
            <Link to="/pools" className="hover:underline">Market Analysis</Link> › Universe
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Universe</h1>
          <p className="text-sm text-brand-mute mt-0.5 max-w-2xl">
            The single source of truth. Every pool view, scan and the journal's symbol picker read
            this list — {data.stocks.length} active stock{data.stocks.length === 1 ? "" : "s"} across{" "}
            {Object.entries(data.counts).filter(([, n]) => n > 0).map(([p, n]) => `${p} ${n}`).join(" · ")}.
          </p>
        </div>
        <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-brand-mute select-none">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          show retired stocks
        </label>
      </div>

      {/* Pool tabs */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="inline-flex max-w-full overflow-x-auto rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-card p-1 gap-0.5">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)}
                    className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold whitespace-nowrap transition-colors ${
                      tab === t ? "bg-teal-700 text-white shadow-card"
                                : "text-brand-mute hover:text-brand-text hover:bg-brand-soft"}`}>
              {t === "ALL" ? "All" : `${POOL_META[t]?.icon ?? ""} ${t}`}
              <span className={`text-[10px] font-normal ml-1.5 ${tab === t ? "text-teal-100" : "text-brand-mute"}`}>
                {t === "ALL" ? data.stocks.length : data.counts[t] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <div className="relative">
          <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-brand-mute text-xs">🔍</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
                 placeholder="Search symbol, name, sector…"
                 className="w-60 max-w-full rounded-lg ring-1 ring-brand-border bg-white pl-8 pr-3 py-1.5 text-sm
                            focus:outline-none focus:ring-2 focus:ring-teal-600/50 placeholder:text-brand-mute/60" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <GhostBtn onClick={exportCsv}>⤓ Export CSV</GhostBtn>
          {editable && (
            <OwnerOnly>
              <GhostBtn onClick={() => setPasting(true)}>📋 Paste symbols</GhostBtn>
              <GhostBtn onClick={() => setImporting(true)}>⤒ Import CSV</GhostBtn>
              <PrimaryBtn onClick={() => setForm({ initial: null })}>+ Add stock</PrimaryBtn>
            </OwnerOnly>
          )}
        </div>
      </div>

      {/* Pool card */}
      {pool && (
        <div className="mb-4 space-y-3">
          <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3 flex flex-wrap items-center gap-3">
            <span className="text-2xl">{POOL_META[pool]?.icon}</span>
            <div>
              <div className="font-display font-semibold">
                {data.pools.find((p) => p.code === pool)?.name ?? pool}
                <span className="ml-2 text-[10px] uppercase tracking-widest text-brand-mute font-semibold">{POOL_META[pool]?.kind}</span>
              </div>
              <div className="text-xs text-brand-mute">{POOL_META[pool]?.blurb}</div>
            </div>
            <div className="ml-auto text-[11px] text-brand-mute text-right">
              {lastSync
                ? <>Last {lastSync.kind === "screen" ? "sync" : "import"} ({lastSync.mode}):{" "}
                    <b className="text-brand-text">{fmtDateTime(lastSync.applied_at ?? lastSync.created_at)}</b>
                    <br />+{lastSync.diff?.added?.length ?? 0} added · −{lastSync.diff?.removed?.length ?? 0} removed</>
                : "Edited by hand · no import recorded yet"}
            </div>
          </div>
          {pool === "S200" && <ScreenCriteriaCard pool={pool} lastSync={lastSync} />}
        </div>
      )}

      {flash && (
        <div className={`mb-3 text-[12px] rounded-lg px-3 py-2 ring-1 ${flash.err
          ? "text-rose-700 bg-rose-50 ring-rose-200" : "text-teal-800 bg-teal-50 ring-teal-200"}`}>
          {flash.text}
        </div>
      )}

      <UniverseTable stocks={stocks} pool={pool} journalRefs={data.journal_refs} search={search}
                     onEdit={(s) => setForm({ initial: s })} onRemove={setRemoving} />

      {/* Modals */}
      {form && (
        <StockFormModal pool={pool ?? "F40"} initial={form.initial} existing={data.stocks} busy={busy}
          onClose={() => setForm(null)}
          onSave={(symbol, draft) => {
            if (form.initial) {
              m.updateStock.mutate({ symbol: form.initial.symbol, draft }, {
                onSuccess: () => { setForm(null); say(`Saved ${plainSymbol(form.initial!.symbol)}.`); },
                onError: onErr,
              });
            } else if (pool) {
              m.addMember.mutate({ pool, symbol, draft }, {
                onSuccess: (r) => {
                  setForm(null);
                  say(r.already_member ? `${plainSymbol(r.stock.symbol)} was already in ${pool} — fields updated.`
                                       : `Added ${plainSymbol(r.stock.symbol)} to ${pool}.`);
                },
                onError: onErr,
              });
            }
          }} />
      )}
      {pasting && pool && (
        <PasteModal pool={pool} busy={m.pasteMembers.isPending}
          onPreview={(text, refresh, mode) => m.pasteMembers.mutateAsync({ pool, text, dryRun: true, refresh, mode })}
          onApply={(text, refresh, mode) => m.pasteMembers.mutateAsync({ pool, text, dryRun: false, refresh, mode })}
          onClose={onPasteClosed} />
      )}
      {importing && pool && (
        <ImportModal pool={pool} busy={m.importMembers.isPending}
          onPreview={(rows, mode) => m.importMembers.mutateAsync({ pool, rows, mode, dryRun: true })}
          onApply={(rows, mode) => m.importMembers.mutateAsync({ pool, rows, mode, dryRun: false })}
          onClose={onImportClosed} />
      )}
      {removing && pool && (
        <ConfirmDialog
          title={`Remove ${plainSymbol(removing.symbol)} from ${pool}?`}
          confirmLabel="Remove" danger busy={m.removeMember.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => m.removeMember.mutate({ pool, symbol: removing.symbol }, {
            onSuccess: (r) => {
              setRemoving(null);
              say(r.retired
                ? `${plainSymbol(r.stock.symbol)} left ${pool} and was retired (no pool left). Nothing is deleted.`
                : `${plainSymbol(r.stock.symbol)} left ${pool}.`);
            },
            onError: onErr,
          })}
          message={
            (removing.pools ?? []).filter((p) => p !== pool).length
              ? `It stays in ${(removing.pools ?? []).filter((p) => p !== pool).join(", ")}.`
              : data.journal_refs[plainSymbol(removing.symbol)]
                ? `This is its last pool, but the Trading Journal still holds it, so it stays active and its price keeps syncing.`
                : `This is its last pool. The stock is retired (kept, not deleted) and stops syncing until it is added again.`
          } />
      )}
    </div>
  );
}
