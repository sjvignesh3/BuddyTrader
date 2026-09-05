// -----------------------------------------------------------------------------
// Net Worth — the unifying financial dashboard.
//   Equity (journal open lots × latest close, via the journal's own
//   buildPortfolio) + manual assets − liabilities = net worth.
// Expenses feed the burn rate (runway) and savings rate; monthly snapshots
// are the only persisted derivation and power trends, ETAs and insights.
// Every number is computed client-side in lib/networth.ts from raw rows.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useJournalCtx } from "../hooks/useJournalCtx";
import { expensesApi } from "../lib/expensesApi";
import {
  addMonths, buildCategoryMaps, buildMonthlyStats, monthLabel, thisMonthKey, todayIso,
} from "../lib/expenses";
import { buildPortfolio } from "../lib/journal";
import { fmtMoney } from "../lib/money";
import {
  allocation, averageBurn, averageRate, baselineSnapshot, buildNetWorthInsights, changeSince,
  computeNetWorth, concentrationChecks, incomeByMonth, liquidAssets, milestoneProgress,
  monthKeyOf, num, portfolioXirr, runway, savingsSeries, snapshotBreakdown, sortSnapshots,
  sumAssets, sumLiabilities,
} from "../lib/networth";
import {
  networthApi, type Asset, type AssetDraft, type IncomeRow, type Liability,
  type LiabilityDraft, type Milestone, type MilestoneDraft, type NetWorthSnapshot,
  type SettingsDraft,
} from "../lib/networthApi";
import LoadError from "../components/LoadError";
import { ConfirmDialog } from "../components/journal/ui";
import OverviewTab from "../components/networth/OverviewTab";
import { AssetsTab, LiabilitiesTab } from "../components/networth/HoldingsTabs";
import HistoryTab from "../components/networth/HistoryTab";
import GoalsTab from "../components/networth/GoalsTab";
import {
  AssetModal, FreedomSettingsModal, IncomeModal, LiabilityModal, MilestoneModal,
  UpdateValueModal,
} from "../components/networth/modals";
import type { TrendPoint } from "../components/networth/ui";

type TabKey = "overview" | "assets" | "liabilities" | "history" | "goals";

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "overview", label: "Overview", icon: "🏛️" },
  { key: "assets", label: "Assets", icon: "💰" },
  { key: "liabilities", label: "Liabilities", icon: "💳" },
  { key: "history", label: "History", icon: "📈" },
  { key: "goals", label: "Goals", icon: "🎯" },
];

const initialTab = (): TabKey => {
  const h = window.location.hash.replace("#", "");
  return TABS.some((t) => t.key === h) ? (h as TabKey) : "overview";
};

const nqk = {
  assets: ["networth", "assets"] as const,
  liabilities: ["networth", "liabilities"] as const,
  snapshots: ["networth", "snapshots"] as const,
  income: ["networth", "income"] as const,
  milestones: ["networth", "milestones"] as const,
  settings: ["networth", "settings"] as const,
};

export default function NetWorthPage() {
  const qc = useQueryClient();
  const [tab, setTabState] = useState<TabKey>(initialTab);
  const setTab = (k: TabKey) => {
    setTabState(k);
    window.history.replaceState(null, "", `#${k}`);
  };
  const [notice, setNotice] = useState<string | null>(null);

  // ---- Data --------------------------------------------------------------------------
  const j = useJournalCtx();
  const assetsQ = useQuery({ queryKey: nqk.assets, queryFn: () => networthApi.assets(true) });
  const liabsQ = useQuery({ queryKey: nqk.liabilities, queryFn: () => networthApi.liabilities(true) });
  const snapsQ = useQuery({ queryKey: nqk.snapshots, queryFn: networthApi.snapshots });
  const incomeQ = useQuery({ queryKey: nqk.income, queryFn: networthApi.income });
  const milestonesQ = useQuery({ queryKey: nqk.milestones, queryFn: networthApi.milestones });
  const settingsQ = useQuery({ queryKey: nqk.settings, queryFn: networthApi.settings });
  // Expense rows/categories share the tracker's cache keys so both tools stay in sync.
  const expensesQ = useQuery({ queryKey: ["expenses", "rows"] as const, queryFn: () => expensesApi.expenses() });
  const categoriesQ = useQuery({ queryKey: ["expenses", "categories"] as const, queryFn: expensesApi.categories });

  const assets = useMemo(() => assetsQ.data?.assets ?? [], [assetsQ.data]);
  const liabilities = useMemo(() => liabsQ.data?.liabilities ?? [], [liabsQ.data]);
  const snapshots = useMemo(() => snapsQ.data?.snapshots ?? [], [snapsQ.data]);
  const incomeRows = useMemo(() => incomeQ.data?.income ?? [], [incomeQ.data]);
  const milestones = useMemo(() => milestonesQ.data?.milestones ?? [], [milestonesQ.data]);
  const settings = settingsQ.data?.settings ?? null;

  // ---- Derived (lib/journal.ts + lib/networth.ts) ------------------------------------------
  const currentMonth = thisMonthKey();
  const portfolio = useMemo(() => buildPortfolio(j.openTrades, j.ctx), [j.openTrades, j.ctx]);
  const equity = portfolio.totals.currentValue;
  const totals = useMemo(() => computeNetWorth({
    equity, assets: sumAssets(assets), liabilities: sumLiabilities(liabilities),
  }), [equity, assets, liabilities]);

  const maps = useMemo(() => buildCategoryMaps(categoriesQ.data?.categories ?? []), [categoriesQ.data]);
  const monthly = useMemo(() => buildMonthlyStats(expensesQ.data?.expenses ?? [], maps),
    [expensesQ.data, maps]);

  const baseline = useMemo(() => baselineSnapshot(snapshots, currentMonth), [snapshots, currentMonth]);
  const delta = changeSince(totals.netWorth, baseline ? num(baseline.net_worth) : null);
  const alloc = useMemo(() => allocation(equity, assets), [equity, assets]);
  const liquid = liquidAssets(assets);
  const burn = useMemo(() => averageBurn(monthly, currentMonth, 3), [monthly, currentMonth]);
  const rw = runway(liquid, burn.avg);

  const monthKeys = useMemo(
    () => Array.from({ length: 12 }, (_, i) => addMonths(currentMonth, i - 11)), [currentMonth]);
  const savings = useMemo(
    () => savingsSeries(monthKeys, incomeByMonth(incomeRows), monthly), [monthKeys, incomeRows, monthly]);
  const avgRate3 = averageRate(savings, 3);
  const derivedSavings = useMemo(() => {
    const pts = savings.filter((p) => p.income !== null).slice(-3);
    return pts.length ? pts.reduce((s, p) => s + ((p.income ?? 0) - p.expenses), 0) / pts.length : null;
  }, [savings]);

  const xirr = useMemo(() => portfolioXirr([...j.openTrades, ...j.closedTrades], equity, todayIso()),
    [j.openTrades, j.closedTrades, equity]);
  const health = useMemo(() => concentrationChecks({ holdings: portfolio.holdings, totals, assets, runway: rw }),
    [portfolio.holdings, totals, assets, rw]);
  const insights = useMemo(() => buildNetWorthInsights({
    totals, snaps: snapshots, currentMonth, monthly, savings, holdings: portfolio.holdings, runway: rw,
  }), [totals, snapshots, currentMonth, monthly, savings, portfolio.holdings, rw]);

  // Trend = past snapshots + today's live point (replaces this month's snapshot if one exists).
  const trend: TrendPoint[] = useMemo(() => {
    const pts: TrendPoint[] = sortSnapshots(snapshots)
      .filter((s) => monthKeyOf(s.snapshot_date) !== currentMonth)
      .map((s) => ({ key: monthKeyOf(s.snapshot_date), label: monthLabel(monthKeyOf(s.snapshot_date), true),
                     value: num(s.net_worth) }));
    if (totals.totalAssets > 0 || totals.liabilities > 0 || pts.length) {
      pts.push({ key: currentMonth, label: monthLabel(currentMonth, true), value: totals.netWorth, live: true });
    }
    return pts;
  }, [snapshots, currentMonth, totals]);

  // ---- Mutations ---------------------------------------------------------------------------
  const refresh = () => qc.invalidateQueries({ queryKey: ["networth"] });
  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  };
  const onErr = (e: unknown) => flash(`⚠ ${e instanceof Error ? e.message : String(e)}`);

  const mAsset = useMutation({
    mutationFn: (p: { id?: number; draft: AssetDraft }) =>
      p.id ? networthApi.updateAsset(p.id, p.draft) : networthApi.createAsset(p.draft),
    onSuccess: () => { refresh(); setAssetModal(null); setValueModal(null); },
    onError: onErr,
  });
  const mLiab = useMutation({
    mutationFn: (p: { id?: number; draft: LiabilityDraft }) =>
      p.id ? networthApi.updateLiability(p.id, p.draft) : networthApi.createLiability(p.draft),
    onSuccess: () => { refresh(); setLiabModal(null); },
    onError: onErr,
  });
  const mDelete = useMutation({
    mutationFn: (p: { kind: "asset" | "liability" | "snapshot" | "milestone" | "income"; id: number }) =>
      p.kind === "asset" ? networthApi.deleteAsset(p.id)
        : p.kind === "liability" ? networthApi.deleteLiability(p.id)
        : p.kind === "snapshot" ? networthApi.deleteSnapshot(p.id)
        : p.kind === "milestone" ? networthApi.deleteMilestone(p.id)
        : networthApi.deleteIncome(p.id),
    onSuccess: refresh,
    onError: onErr,
  });
  const mSnapshot = useMutation({
    mutationFn: async () => {
      const r = await networthApi.takeSnapshot({
        snapshot_date: todayIso(),
        equity_value: totals.equity.toFixed(2),
        assets_value: totals.assets.toFixed(2),
        liabilities_value: totals.liabilities.toFixed(2),
        net_worth: totals.netWorth.toFixed(2),
        breakdown: snapshotBreakdown(equity, assets, liabilities, portfolio.holdings),
      });
      // Stamp newly-crossed milestones with the month they were reached.
      await Promise.all(milestones
        .filter((m) => !m.achieved_on && milestoneProgress(m, totals.netWorth).achieved)
        .map((m) => networthApi.updateMilestone(m.id, { achieved_on: todayIso() })));
      return r;
    },
    onSuccess: (r) => {
      refresh();
      flash(`${r.replaced ? "Replaced" : "Saved"} the ${monthLabel(monthKeyOf(r.snapshot.snapshot_date))} snapshot — net worth ₹${fmtMoney(r.snapshot.net_worth, 0)} ✓`);
    },
    onError: onErr,
  });
  const mMilestone = useMutation({
    mutationFn: (p: { id?: number; draft: MilestoneDraft }) =>
      p.id ? networthApi.updateMilestone(p.id, p.draft) : networthApi.createMilestone(p.draft),
    onSuccess: () => { refresh(); setMilestoneModal(null); },
    onError: onErr,
  });
  const mIncome = useMutation({
    mutationFn: (p: { month: string; amount: string; notes: string | null }) =>
      networthApi.setIncome(p.month, p.amount, p.notes),
    onSuccess: () => { refresh(); setIncomeModal(null); },
    onError: onErr,
  });
  const mSettings = useMutation({
    mutationFn: (draft: SettingsDraft) => networthApi.updateSettings(draft),
    onSuccess: () => { refresh(); setFreedomModal(false); },
    onError: onErr,
  });

  // ---- Modal state ---------------------------------------------------------------------------
  const [assetModal, setAssetModal] = useState<{ initial: Asset | null } | null>(null);
  const [valueModal, setValueModal] = useState<Asset | null>(null);
  const [liabModal, setLiabModal] = useState<{ initial: Liability | null } | null>(null);
  const [milestoneModal, setMilestoneModal] = useState<{ initial: Milestone | null } | null>(null);
  const [incomeModal, setIncomeModal] = useState<{ monthKey: string; existing: IncomeRow | null } | null>(null);
  const [freedomModal, setFreedomModal] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    title: string; message: string; confirmLabel: string; action: () => void;
  } | null>(null);
  const askDelete = (title: string, message: string, action: () => void) =>
    setConfirmState({ title, message, confirmLabel: "Delete", action });

  // ---- Render ----------------------------------------------------------------------------------
  if (j.isLoading || assetsQ.isLoading || liabsQ.isLoading || snapsQ.isLoading
      || incomeQ.isLoading || milestonesQ.isLoading || settingsQ.isLoading) {
    return <LoadError loading error={null} />;
  }
  const err = j.error ?? assetsQ.error ?? liabsQ.error ?? snapsQ.error ?? incomeQ.error
    ?? milestonesQ.error ?? settingsQ.error;
  if (err) return <LoadError loading={false} error={err} />;

  const snapshotThisMonth = snapshots.some((s) => monthKeyOf(s.snapshot_date) === currentMonth);

  return (
    <div>
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Net Worth</h1>
          <p className="text-sm text-brand-mute">
            Equity + assets − liabilities, and whether your wealth is actually growing.
          </p>
        </div>
        <div className="text-[11px] text-brand-mute text-right">
          <div>Equity from {portfolio.holdings.length} holding{portfolio.holdings.length === 1 ? "" : "s"}
            {j.snapshotDate ? ` · prices as of ${j.snapshotDate}` : ""}</div>
          <div>{snapshotThisMonth ? `${monthLabel(currentMonth, true)} snapshot taken` : `No ${monthLabel(currentMonth, true)} snapshot yet`}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div role="tablist" aria-label="Net worth sections"
             className="inline-flex max-w-full overflow-x-auto no-scrollbar rounded-2xl
                        ring-1 ring-brand-border bg-brand-panel shadow-card p-1.5 gap-1">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button key={t.key} role="tab" aria-selected={active} onClick={() => setTab(t.key)} title={t.label}
                className={`group flex items-center gap-1.5 px-3 sm:px-3.5 py-2 rounded-xl
                            text-sm font-semibold whitespace-nowrap transition-all duration-300 ${
                  active ? "bg-gradient-to-br from-teal-600 to-teal-800 text-white shadow-pop"
                    : "text-brand-mute hover:text-brand-text hover:bg-brand-soft"}`}>
                <span aria-hidden className={`text-base leading-none transition-transform duration-200 ${
                  active ? "scale-110" : "grayscale group-hover:grayscale-0 group-hover:scale-110"}`}>{t.icon}</span>
                <span className={active ? "" : "hidden md:inline"}>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {notice && (
        <div className="mb-3 px-3.5 py-2 rounded-xl bg-teal-50 ring-1 ring-teal-200 text-teal-900 text-sm">{notice}</div>
      )}
      {j.snapsError && (
        <div className="mb-3 px-3.5 py-2 rounded-xl bg-amber-50 ring-1 ring-amber-200 text-amber-900 text-xs">
          Could not load market prices — equity is shown at cost until the API is reachable.
        </div>
      )}

      {/* Tab body */}
      {tab === "overview" && (
        <OverviewTab
          totals={totals} delta={delta}
          baselineLabel={baseline ? monthLabel(monthKeyOf(baseline.snapshot_date), true) : null}
          trend={trend} alloc={alloc} insights={insights} health={health}
          runway={rw} burn={burn} liquid={liquid} savings={savings} avgRate3={avgRate3} xirr={xirr}
          snapshotCount={snapshots.length} hasExpenses={monthly.size > 0}
          onTakeSnapshot={() => mSnapshot.mutate()} snapshotBusy={mSnapshot.isPending}
        />
      )}
      {tab === "assets" && (
        <AssetsTab assets={assets}
          onAdd={() => setAssetModal({ initial: null })}
          onEdit={(a) => setAssetModal({ initial: a })}
          onUpdateValue={setValueModal}
          onArchive={(a) => mAsset.mutate({ id: a.id, draft: { archived: !a.archived } })}
          onDelete={(a) => askDelete(`Delete ${a.name}?`,
            `Removes ${a.name} (₹${fmtMoney(a.current_value, 0)}) permanently. Archive instead to keep it out of totals but on record.`,
            () => mDelete.mutate({ kind: "asset", id: a.id }))} />
      )}
      {tab === "liabilities" && (
        <LiabilitiesTab liabilities={liabilities}
          onAdd={() => setLiabModal({ initial: null })}
          onEdit={(l) => setLiabModal({ initial: l })}
          onArchive={(l) => mLiab.mutate({ id: l.id, draft: { archived: !l.archived } })}
          onDelete={(l) => askDelete(`Delete ${l.name}?`,
            `Removes ${l.name} (₹${fmtMoney(l.outstanding, 0)} outstanding) permanently.`,
            () => mDelete.mutate({ kind: "liability", id: l.id }))} />
      )}
      {tab === "history" && (
        <HistoryTab snapshots={snapshots} trend={trend} savings={savings}
          onTakeSnapshot={() => mSnapshot.mutate()} snapshotBusy={mSnapshot.isPending}
          onDelete={(s: NetWorthSnapshot) => askDelete(`Delete the ${monthLabel(monthKeyOf(s.snapshot_date))} snapshot?`,
            "This removes a historical record — trends and ETAs will lose this point.",
            () => mDelete.mutate({ kind: "snapshot", id: s.id }))} />
      )}
      {tab === "goals" && (
        <GoalsTab milestones={milestones} netWorth={totals.netWorth} snapshots={snapshots}
          currentMonth={currentMonth} income={incomeRows} savings={savings}
          settings={settings} derivedSavings={derivedSavings}
          onAddMilestone={() => setMilestoneModal({ initial: null })}
          onEditMilestone={(m) => setMilestoneModal({ initial: m })}
          onDeleteMilestone={(m) => askDelete(`Remove the ${m.label} milestone?`,
            "Your net worth is untouched — only the goal is removed.",
            () => mDelete.mutate({ kind: "milestone", id: m.id }))}
          onSetIncome={(monthKey) => setIncomeModal({
            monthKey, existing: incomeRows.find((r) => monthKeyOf(r.month) === monthKey) ?? null })}
          onDeleteIncome={(r) => askDelete(`Remove ${monthLabel(monthKeyOf(r.month))} income?`,
            "The savings rate for that month will show as not available.",
            () => mDelete.mutate({ kind: "income", id: r.id }))}
          onEditFreedom={() => setFreedomModal(true)} />
      )}

      {/* Modals */}
      {assetModal && (
        <AssetModal initial={assetModal.initial} busy={mAsset.isPending}
                    onClose={() => setAssetModal(null)}
                    onSave={(draft) => mAsset.mutate({ id: assetModal.initial?.id, draft })} />
      )}
      {valueModal && (
        <UpdateValueModal asset={valueModal} busy={mAsset.isPending}
                          onClose={() => setValueModal(null)}
                          onSave={(draft) => mAsset.mutate({ id: valueModal.id, draft })} />
      )}
      {liabModal && (
        <LiabilityModal initial={liabModal.initial} busy={mLiab.isPending}
                        onClose={() => setLiabModal(null)}
                        onSave={(draft) => mLiab.mutate({ id: liabModal.initial?.id, draft })} />
      )}
      {milestoneModal && (
        <MilestoneModal initial={milestoneModal.initial} busy={mMilestone.isPending}
                        onClose={() => setMilestoneModal(null)}
                        onSave={(draft) => mMilestone.mutate({ id: milestoneModal.initial?.id, draft })} />
      )}
      {incomeModal && (
        <IncomeModal monthKey={incomeModal.monthKey} existing={incomeModal.existing} busy={mIncome.isPending}
                     onClose={() => setIncomeModal(null)}
                     onSave={(month, amount, notes) => mIncome.mutate({ month, amount, notes })} />
      )}
      {freedomModal && settings && (
        <FreedomSettingsModal settings={settings} defaultSavings={derivedSavings} busy={mSettings.isPending}
                              onClose={() => setFreedomModal(false)}
                              onSave={(draft) => mSettings.mutate(draft)} />
      )}
      {confirmState && (
        <ConfirmDialog title={confirmState.title} message={confirmState.message}
                       confirmLabel={confirmState.confirmLabel} danger busy={mDelete.isPending}
                       onCancel={() => setConfirmState(null)}
                       onConfirm={() => { confirmState.action(); setConfirmState(null); }} />
      )}
    </div>
  );
}
