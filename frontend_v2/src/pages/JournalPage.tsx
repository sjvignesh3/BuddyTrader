// -----------------------------------------------------------------------------
// Trading Journal — Opportunities / Open / Closed / Portfolio.
// Manual rows live in the journal tables; market columns (LTP, ATH, day %)
// join in live from daily_snapshots; every % derives from the capital.
// -----------------------------------------------------------------------------
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, Snapshot } from "../lib/api";
import {
  journalApi, Opportunity, OpportunityDraft, Trade, TradeDraft,
} from "../lib/journalApi";
import { buildOpenInvested, num, JournalCtx } from "../lib/journal";
import {
  exportClosedTrades, exportOpenTrades, exportOpportunities,
  downloadCsv, locateSheet, mapSheet, parseCsv,
} from "../lib/journalCsv";
import { fmtMoney } from "../lib/money";
import LoadError from "../components/LoadError";
import JournalInsights from "../components/journal/JournalInsights";
import OpportunitiesTab from "../components/journal/OpportunitiesTab";
import OpenTradesTab from "../components/journal/OpenTradesTab";
import ClosedTradesTab from "../components/journal/ClosedTradesTab";
import PortfolioTab from "../components/journal/PortfolioTab";
import {
  CloseTradeModal, ConvertModal, OpportunityModal, TradeModal,
} from "../components/journal/modals";
import { ConfirmDialog, GhostBtn, PrimaryBtn } from "../components/journal/ui";

type TabKey = "opportunities" | "open" | "closed" | "portfolio";

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "opportunities", label: "Opportunities", icon: "🔭" },
  { key: "open", label: "Open Trades", icon: "📈" },
  { key: "closed", label: "Closed Trades", icon: "🏁" },
  { key: "portfolio", label: "Portfolio", icon: "💼" },
];

/** Restore the tab from the URL hash so a refresh doesn't reset the view. */
const initialTab = (): TabKey => {
  const h = window.location.hash.replace("#", "");
  return TABS.some((t) => t.key === h) ? (h as TabKey) : "opportunities";
};

const jqk = {
  settings: ["journal", "settings"] as const,
  opportunities: ["journal", "opportunities"] as const,
  trades: ["journal", "trades"] as const,
};

export default function JournalPage() {
  const qc = useQueryClient();
  const [tab, setTabState] = useState<TabKey>(initialTab);
  const setTab = (k: TabKey) => {
    setTabState(k);
    window.history.replaceState(null, "", `#${k}`);
  };
  const [notice, setNotice] = useState<string | null>(null);

  // ---- Data ------------------------------------------------------------------
  const settingsQ = useQuery({ queryKey: jqk.settings, queryFn: journalApi.settings });
  const oppsQ = useQuery({
    queryKey: jqk.opportunities,
    queryFn: () => journalApi.opportunities("ACTIVE"),
  });
  const tradesQ = useQuery({ queryKey: jqk.trades, queryFn: () => journalApi.trades() });

  const opportunities = oppsQ.data?.opportunities ?? [];
  const trades = tradesQ.data?.trades ?? [];
  const openTrades = useMemo(() => trades.filter((t) => t.status === "OPEN"), [trades]);
  const closedTrades = useMemo(() => trades.filter((t) => t.status === "CLOSED"), [trades]);

  const symbols = useMemo(() => {
    const s = new Set<string>();
    opportunities.forEach((o) => s.add(o.symbol));
    openTrades.forEach((t) => s.add(t.symbol));
    return [...s].sort();
  }, [opportunities, openTrades]);

  // The DB stores yfinance symbols ("TCS.NS"); the journal uses plain NSE
  // symbols ("TCS"). Query both spellings and normalise the map keys.
  const snapsQ = useQuery({
    queryKey: ["journal", "snapshots", symbols.join(",")],
    queryFn: () => api.latestSnapshotsForSymbols(
      symbols.flatMap((s) => (s.includes(".") ? [s] : [s, `${s}.NS`]))),
    enabled: symbols.length > 0,
    staleTime: 60_000,
  });

  const ctx: JournalCtx = useMemo(() => {
    const snaps = new Map<string, Snapshot>();
    (snapsQ.data?.snapshots ?? []).forEach((s) =>
      snaps.set(s.symbol.replace(/\.(NS|BO)$/i, ""), s));
    return {
      capital: num(settingsQ.data?.settings.capital) ?? 0,
      snaps,
      openInvested: buildOpenInvested(openTrades),
    };
  }, [settingsQ.data, snapsQ.data, openTrades]);

  const missingData = symbols.filter((s) => !ctx.snaps.has(s));

  // ---- Mutations ---------------------------------------------------------------
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["journal"] });
  };
  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  };
  const onErr = (e: unknown) => flash(`⚠ ${e instanceof Error ? e.message : String(e)}`);

  const mSaveOpp = useMutation({
    mutationFn: (p: { id?: number; draft: OpportunityDraft }) =>
      p.id ? journalApi.updateOpportunity(p.id, p.draft)
           : journalApi.createOpportunity(p.draft),
    onSuccess: () => { refresh(); setOppModal(null); },
    onError: onErr,
  });
  const mSaveTrade = useMutation({
    mutationFn: (p: { id?: number; draft: TradeDraft }) =>
      p.id ? journalApi.updateTrade(p.id, p.draft) : journalApi.createTrade(p.draft),
    onSuccess: () => { refresh(); setTradeModal(null); },
    onError: onErr,
  });
  const mConvert = useMutation({
    mutationFn: (p: { id: number; overrides: TradeDraft }) =>
      journalApi.convertOpportunity(p.id, p.overrides),
    onSuccess: () => { refresh(); setConvertOpp(null); flash("Position opened ✓"); },
    onError: onErr,
  });
  const mClose = useMutation({
    mutationFn: (p: { id: number; sell_date: string; sell_price: string; qty: number }) =>
      journalApi.closeTrade(p.id, p),
    onSuccess: () => { refresh(); setBookTrade(null); flash("Trade booked ✓"); },
    onError: onErr,
  });
  const mDelete = useMutation({
    mutationFn: (p: { kind: "opp" | "trade"; id: number }) =>
      p.kind === "opp" ? journalApi.deleteOpportunity(p.id) : journalApi.deleteTrade(p.id),
    onSuccess: refresh,
    onError: onErr,
  });
  const mCapital = useMutation({
    mutationFn: (capital: string) => journalApi.setCapital(capital),
    onSuccess: () => { refresh(); setEditingCapital(false); },
    onError: onErr,
  });
  const mImport = useMutation({
    mutationFn: journalApi.bulkImport,
    onSuccess: (r) => {
      refresh();
      flash(`Imported ${r.imported.opportunities} opportunities, ${r.imported.trades} trades ✓`);
    },
    onError: onErr,
  });

  // ---- Modal state ----------------------------------------------------------------
  const [oppModal, setOppModal] = useState<{ initial: Opportunity | null } | null>(null);
  const [tradeModal, setTradeModal] =
    useState<{ initial: Trade | null; closed: boolean } | null>(null);
  const [convertOpp, setConvertOpp] = useState<Opportunity | null>(null);
  const [bookTrade, setBookTrade] = useState<Trade | null>(null);
  const [editingCapital, setEditingCapital] = useState(false);
  const [capitalDraft, setCapitalDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // In-app confirmation (window.confirm is unreliable in embedded browsers).
  const [confirmState, setConfirmState] = useState<{
    title: string; message: string; confirmLabel: string;
    danger: boolean; action: () => void;
  } | null>(null);
  const askConfirm = (title: string, message: string, confirmLabel: string,
                      danger: boolean, action: () => void) =>
    setConfirmState({ title, message, confirmLabel, danger, action });

  // ---- Import / export --------------------------------------------------------------
  const handleImportFile = async (file: File) => {
    const rows = parseCsv(await file.text());
    const loc = locateSheet(rows);
    if (!loc) {
      flash("⚠ Could not recognise this CSV — expected an Opportunities / Open Trades / Closed Trades export.");
      return;
    }
    const mapped = mapSheet(rows, loc);
    const n = mapped.opportunities.length + mapped.trades.length;
    const label = { opportunities: "Opportunities", open: "Open Trades", closed: "Closed Trades" }[mapped.kind];
    if (!n) { flash("⚠ No importable rows found."); return; }
    askConfirm(
      `Import ${label}?`,
      `Detected a "${label}" sheet with ${n} importable rows` +
      (mapped.skipped ? ` (${mapped.skipped} incomplete rows will be skipped)` : "") +
      `.\n\nRows are ADDED — existing entries are not touched.`,
      `Import ${n} rows`, false,
      () => mImport.mutate({ opportunities: mapped.opportunities, trades: mapped.trades }),
    );
  };

  const handleExport = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    if (tab === "opportunities") {
      downloadCsv(`plutus-opportunities-${stamp}.csv`, exportOpportunities(opportunities));
    } else if (tab === "open") {
      downloadCsv(`plutus-open-trades-${stamp}.csv`, exportOpenTrades(openTrades));
    } else {
      downloadCsv(`plutus-closed-trades-${stamp}.csv`, exportClosedTrades(closedTrades));
    }
  };

  // ---- Render ------------------------------------------------------------------------
  if (settingsQ.isLoading || oppsQ.isLoading || tradesQ.isLoading) {
    return <LoadError loading error={null} />;
  }
  const err = settingsQ.error ?? oppsQ.error ?? tradesQ.error;
  if (err) return <LoadError loading={false} error={err} />;

  const capital = ctx.capital;
  const busy = mSaveOpp.isPending || mSaveTrade.isPending || mConvert.isPending
    || mClose.isPending || mImport.isPending;

  return (
    <div>
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Trading Journal</h1>
          <p className="text-sm text-brand-mute">
            Plans, positions and bookings — every percentage runs off your capital.
          </p>
        </div>
        {/* Capital chip */}
        <div className="flex items-center gap-2">
          {editingCapital ? (
            <span className="inline-flex items-center gap-1.5">
              <input
                autoFocus inputMode="numeric" value={capitalDraft}
                onChange={(e) => setCapitalDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && Number(capitalDraft) > 0) mCapital.mutate(capitalDraft);
                  if (e.key === "Escape") setEditingCapital(false);
                }}
                className="w-32 rounded-lg ring-1 ring-brand-border px-2.5 py-1.5 text-sm
                           tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600/50"
              />
              <PrimaryBtn disabled={!(Number(capitalDraft) > 0) || mCapital.isPending}
                          onClick={() => mCapital.mutate(capitalDraft)}>Set</PrimaryBtn>
              <GhostBtn onClick={() => setEditingCapital(false)}>✕</GhostBtn>
            </span>
          ) : (
            <button
              onClick={() => { setCapitalDraft(String(capital || "")); setEditingCapital(true); }}
              title="Click to change capital — every % recalculates"
              className="px-3.5 py-2 rounded-xl bg-brand-panel ring-1 ring-brand-border
                         shadow-card hover:shadow-pop transition-shadow text-left">
              <span className="block text-[10px] font-bold uppercase tracking-wider text-brand-mute">
                Capital
              </span>
              <span className="text-base font-display font-semibold tabular-nums">
                ₹{fmtMoney(capital, 0)} <span className="text-brand-mute text-xs">✎</span>
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Insights */}
      <JournalInsights
        openTrades={openTrades} closedTrades={closedTrades} ctx={ctx}
        onJumpToOpen={() => setTab("open")}
      />

      {/* Tabs + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        {/* Inactive tabs collapse to icon+count on narrow screens, so the strip
            always fits — no horizontal scrollbar. The active pill expands. */}
        <div role="tablist" aria-label="Journal sections"
             className="inline-flex max-w-full overflow-x-auto no-scrollbar rounded-2xl
                        ring-1 ring-brand-border bg-brand-panel shadow-card p-1.5 gap-1">
          {TABS.map((t) => {
            const active = tab === t.key;
            const count = t.key === "opportunities" ? opportunities.length
              : t.key === "open" ? openTrades.length
              : t.key === "closed" ? closedTrades.length
              : new Set(openTrades.map((x) => x.symbol)).size;
            return (
              <button key={t.key} role="tab" aria-selected={active}
                onClick={() => setTab(t.key)} title={t.label}
                className={`group flex items-center gap-1.5 px-3 sm:px-3.5 py-2 rounded-xl
                            text-sm font-semibold whitespace-nowrap transition-all duration-300 ${
                  active
                    ? "bg-gradient-to-br from-teal-600 to-teal-800 text-white shadow-pop"
                    : "text-brand-mute hover:text-brand-text hover:bg-brand-soft"}`}>
                <span aria-hidden
                      className={`text-base leading-none transition-transform duration-200 ${
                        active ? "scale-110" : "grayscale group-hover:grayscale-0 group-hover:scale-110"}`}>
                  {t.icon}
                </span>
                <span className={active ? "" : "hidden md:inline"}>{t.label}</span>
                <span className={`min-w-[20px] px-1.5 py-0.5 rounded-full text-[10px]
                                  font-bold tabular-nums text-center transition-colors ${
                  active ? "bg-white/20 text-white"
                         : "hidden sm:inline-block bg-brand-soft text-brand-mute ring-1 ring-brand-border"}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          {tab !== "portfolio" && (
            <>
              <GhostBtn onClick={() => fileRef.current?.click()} disabled={busy}>
                ⬆ Import CSV
              </GhostBtn>
              <GhostBtn onClick={handleExport}>⬇ Export</GhostBtn>
            </>
          )}
          {tab === "opportunities" && (
            <PrimaryBtn onClick={() => setOppModal({ initial: null })}>+ Opportunity</PrimaryBtn>
          )}
          {tab === "open" && (
            <PrimaryBtn onClick={() => setTradeModal({ initial: null, closed: false })}>
              + Trade
            </PrimaryBtn>
          )}
          {tab === "closed" && (
            <PrimaryBtn onClick={() => setTradeModal({ initial: null, closed: true })}>
              + Closed trade
            </PrimaryBtn>
          )}
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                 onChange={(e) => {
                   const f = e.target.files?.[0];
                   if (f) void handleImportFile(f);
                   e.target.value = "";
                 }} />
        </div>
      </div>

      {/* Notices */}
      {notice && (
        <div className="mb-3 px-3.5 py-2 rounded-xl bg-teal-50 ring-1 ring-teal-200
                        text-teal-900 text-sm">{notice}</div>
      )}
      {missingData.length > 0 && tab !== "closed" && (
        <details className="mb-3 px-3.5 py-2 rounded-xl bg-amber-50 ring-1 ring-amber-200
                            text-amber-900 text-xs">
          <summary className="cursor-pointer select-none">
            No market data yet for <b>{missingData.length}</b> symbol{missingData.length === 1 ? "" : "s"} —
            their fetched columns show “—”. <span className="underline underline-offset-2">Which?</span>
          </summary>
          <div className="mt-1.5 leading-relaxed">
            <b>{missingData.join(", ")}</b>
            <div className="mt-1 text-amber-800/80">
              Run a sync (Play Area → fetch, or the nightly job) to fill them.
            </div>
          </div>
        </details>
      )}

      {/* Tab body */}
      {tab === "opportunities" && (
        <OpportunitiesTab
          rows={opportunities} ctx={ctx}
          onEdit={(o) => setOppModal({ initial: o })}
          onConvert={setConvertOpp}
          onDelete={(o) => askConfirm(`Delete ${o.symbol}?`,
            `This removes the ${o.symbol} opportunity permanently.`,
            "Delete", true, () => mDelete.mutate({ kind: "opp", id: o.id }))}
        />
      )}
      {tab === "open" && (
        <OpenTradesTab
          rows={openTrades} ctx={ctx}
          onEdit={(t) => setTradeModal({ initial: t, closed: false })}
          onBook={setBookTrade}
          onDelete={(t) => askConfirm(`Delete ${t.symbol}?`,
            `This removes the open trade ${t.symbol} (${t.qty} qty @ ₹${t.buy_price}) permanently.\nTo sell it instead, use Book 💰.`,
            "Delete", true, () => mDelete.mutate({ kind: "trade", id: t.id }))}
        />
      )}
      {tab === "closed" && (
        <ClosedTradesTab
          rows={closedTrades}
          onEdit={(t) => setTradeModal({ initial: t, closed: true })}
          onDelete={(t) => askConfirm(`Delete ${t.symbol}?`,
            `This removes the closed trade ${t.symbol} (${t.qty} qty) permanently.`,
            "Delete", true, () => mDelete.mutate({ kind: "trade", id: t.id }))}
        />
      )}
      {tab === "portfolio" && (
        <PortfolioTab openTrades={openTrades} closedTrades={closedTrades} ctx={ctx} />
      )}

      {/* Modals */}
      {oppModal && (
        <OpportunityModal
          initial={oppModal.initial} ctx={ctx} busy={mSaveOpp.isPending}
          onClose={() => setOppModal(null)}
          onSave={(draft) => mSaveOpp.mutate({ id: oppModal.initial?.id, draft })}
        />
      )}
      {tradeModal && (
        <TradeModal
          initial={tradeModal.initial} closed={tradeModal.closed}
          ctx={ctx} busy={mSaveTrade.isPending}
          onClose={() => setTradeModal(null)}
          onSave={(draft) => mSaveTrade.mutate({ id: tradeModal.initial?.id, draft })}
        />
      )}
      {convertOpp && (
        <ConvertModal
          opp={convertOpp} ctx={ctx} busy={mConvert.isPending}
          onClose={() => setConvertOpp(null)}
          onConvert={(overrides) => mConvert.mutate({ id: convertOpp.id, overrides })}
        />
      )}
      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          danger={confirmState.danger}
          busy={mDelete.isPending || mImport.isPending}
          onCancel={() => setConfirmState(null)}
          onConfirm={() => { confirmState.action(); setConfirmState(null); }}
        />
      )}
      {bookTrade && (
        <CloseTradeModal
          trade={bookTrade} busy={mClose.isPending}
          onClose={() => setBookTrade(null)}
          onCloseTrade={(p) => mClose.mutate({ id: bookTrade.id, ...p })}
        />
      )}
    </div>
  );
}
