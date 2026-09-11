// -----------------------------------------------------------------------------
// Position Sizer — pre-trade decision support. Enter capital, risk %, entry
// and stop for a stock and see, live: the risk-sized quantity, capital
// deployed, ₹ at risk, the cap-bucket allocation verdict (the journal's own
// rule) with room left, reward targets in R, a GTT entry ladder against
// Plutus levels, an averaging simulator when the stock is already held, and
// how much of the portfolio's open risk this trade would be.
// Every number is derived in lib/sizing.ts from the inputs + the live journal;
// only the inputs are ever saved (sizing_plans). "Convert" reuses the
// Journal's opportunity form and API — no second opportunity model.
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScanResult, Stock } from "../lib/api";
import { useScanResultsForSymbols, useStocks } from "../hooks/usePlutus";
import { bothSpellings, plainSymbol, useJournalCtx } from "../hooks/useJournalCtx";
import { journalApi, type OpportunityDraft } from "../lib/journalApi";
import { effectiveCap, num } from "../lib/journal";
import { fmtMoney } from "../lib/money";
import { buildRows, type StockRow } from "../lib/rows";
import {
  allocationGuard, averageDown, buildLadder, existingPosition, planSummary, planTargets,
  portfolioHeat, riskFor, sizeByRisk, splitQty, suggestLevels,
} from "../lib/sizing";
import { sizingApi, type SizingPlan, type SizingPlanDraft } from "../lib/sizingApi";
import { OwnerOnly } from "../components/AuthGate";
import LoadError from "../components/LoadError";
import { OpportunityModal } from "../components/journal/modals";
import { ConfirmDialog, Field, GhostBtn, PrimaryBtn, TextArea } from "../components/journal/ui";
import { StockPicker, TradeInputs, type TradeForm } from "../components/sizing/inputs";
import {
  AllocationRoom, AveragingCard, Card, HeatCard, SizeVerdict, StockContext,
} from "../components/sizing/results";
import { LadderPlanner, TargetsPlanner, type TrancheForm } from "../components/sizing/planners";
import SavedPlans from "../components/sizing/SavedPlans";

const sqk = { plans: ["sizing", "plans"] as const };

const EMPTY_FORM: TradeForm = { capital: "", riskPct: "1", entry: "", stop: "", qty: "", cap: "" };
const EMPTY_TRANCHES: TrancheForm[] = [{ trigger: "", qty: "" }, { trigger: "", qty: "" }];

const intOrNull = (s: string): number | null => {
  const n = Number(s.trim());
  return s.trim() !== "" && Number.isInteger(n) && n > 0 ? n : null;
};

export default function PositionSizerPage() {
  const qc = useQueryClient();
  const [symbol, setSymbol] = useState("");
  const [f, setF] = useState<TradeForm>(EMPTY_FORM);
  const [entryAuto, setEntryAuto] = useState(true);
  const [capitalInit, setCapitalInit] = useState(false);
  const [targets, setTargets] = useState<string[]>(["", "", ""]);
  const [tranches, setTranches] = useState<TrancheForm[]>(EMPTY_TRANCHES);
  const [notes, setNotes] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [savedPlanId, setSavedPlanId] = useState<number | null>(null);

  // ---- Data --------------------------------------------------------------------
  const j = useJournalCtx(symbol ? [symbol] : []);
  const stocksQ = useStocks();
  const resultsQ = useScanResultsForSymbols(symbol ? bothSpellings([symbol]) : []);
  const plansQ = useQuery({ queryKey: sqk.plans, queryFn: () => sizingApi.plans() });

  const stocks = useMemo(() => stocksQ.data?.stocks ?? [], [stocksQ.data]);
  const snap = symbol ? j.ctx.snaps.get(symbol) : undefined;

  // Capital defaults to the journal's once it arrives (a later edit sticks).
  useEffect(() => {
    if (!capitalInit && j.ctx.capital > 0) {
      setF((p) => (p.capital === "" ? { ...p, capital: String(j.ctx.capital) } : p));
      setCapitalInit(true);
    }
  }, [j.ctx.capital, capitalInit]);

  // Entry mirrors the CMP until the user types their own.
  useEffect(() => {
    if (entryAuto && snap?.close) setF((p) => ({ ...p, entry: String(num(snap.close) ?? "") }));
  }, [snap, entryAuto]);

  const row: StockRow | null = useMemo(() => {
    if (!snap) return null;
    const stockMap = new Map<string, Stock>();
    for (const s of stocks) {
      if (plainSymbol(s.symbol) === symbol) stockMap.set(snap.symbol, s);
    }
    const resultMap = new Map<string, ScanResult[]>();
    for (const r of resultsQ.data?.results ?? []) {
      const list = resultMap.get(snap.symbol) ?? [];
      list.push(r);
      resultMap.set(snap.symbol, list);
    }
    return buildRows([snap], stockMap, resultMap)[0] ?? null;
  }, [snap, stocks, resultsQ.data, symbol]);

  // ---- Derived (all pure, lib/sizing.ts) ------------------------------------------
  const capital = num(f.capital);
  const riskPct = num(f.riskPct);
  const entry = num(f.entry);
  const stop = num(f.stop);
  const cap = effectiveCap(f.cap || null, snap);

  const sizing = useMemo(() => sizeByRisk({ capital, riskPct, entry, stop }),
    [capital, riskPct, entry, stop]);
  const qtyOverride = intOrNull(f.qty);
  const qty = qtyOverride ?? sizing.qty;
  const riskAmount = riskFor(qty, entry, stop);
  const riskPctOfCapital = riskAmount !== null && capital ? (riskAmount / capital) * 100 : null;

  const guard = useMemo(() => allocationGuard({
    symbol, cap, entry, qty: qty > 0 ? qty : null, ctx: j.ctx,
  }), [symbol, cap, entry, qty, j.ctx]);

  const targetRows = useMemo(
    () => planTargets(entry, stop, qty, targets.map((t) => num(t))), [entry, stop, qty, targets]);
  const levels = useMemo(() => suggestLevels(snap), [snap]);
  const heldValue = j.ctx.openInvested.get(symbol) ?? 0;
  const ladder = useMemo(() => buildLadder({
    tranches: tranches.map((t) => ({ trigger: num(t.trigger), qty: intOrNull(t.qty) })),
    capital, heldValue, cap, stop,
  }), [tranches, capital, heldValue, cap, stop]);
  const existing = useMemo(() => (symbol ? existingPosition(j.openTrades, symbol) : null),
    [j.openTrades, symbol]);
  const averaging = useMemo(() => averageDown({
    existing, addQty: qty > 0 ? qty : null, addPrice: entry, stop, capital, cap,
  }), [existing, qty, entry, stop, capital, cap]);
  const heat = useMemo(() => portfolioHeat({
    openTrades: j.openTrades, snaps: j.ctx.snaps, capital, newRisk: riskAmount ?? 0,
  }), [j.openTrades, j.ctx.snaps, capital, riskAmount]);

  // ---- Mutations ---------------------------------------------------------------------
  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  };
  const onErr = (e: unknown) => flash(`⚠ ${e instanceof Error ? e.message : String(e)}`);

  const mSave = useMutation({
    mutationFn: (draft: SizingPlanDraft) => sizingApi.createPlan(draft),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["sizing"] });
      setSavedPlanId(r.plan.id);
      flash(`Plan saved — ${r.plan.symbol} ${r.plan.qty} × ₹${fmtMoney(r.plan.entry)} ✓`);
    },
    onError: onErr,
  });
  const mDelete = useMutation({
    mutationFn: (id: number) => sizingApi.deletePlan(id),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: ["sizing"] });
      if (savedPlanId === id) setSavedPlanId(null);
    },
    onError: onErr,
  });
  const mConvert = useMutation({
    mutationFn: async (p: { planId: number | null; draft: OpportunityDraft }) => {
      const r = await journalApi.createOpportunity(p.draft);
      if (p.planId !== null) {
        await sizingApi.updatePlan(p.planId, { opportunity_id: r.opportunity.id });
      }
      return r;
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["journal"] });
      qc.invalidateQueries({ queryKey: ["sizing"] });
      setConvert(null);
      flash(`${r.opportunity.symbol} added to journal opportunities ✓`);
    },
    onError: onErr,
  });

  // ---- Form helpers --------------------------------------------------------------------
  const set = <K extends keyof TradeForm>(k: K, v: TradeForm[K]) => {
    if (k === "entry") setEntryAuto(false);
    setSavedPlanId(null);
    setF((p) => ({ ...p, [k]: v }));
  };
  const pickSymbol = (s: string) => {
    setSymbol(s);
    setEntryAuto(true);
    setSavedPlanId(null);
    setF((p) => ({ ...p, entry: "", stop: "", qty: "", cap: "" }));
    setTargets(["", "", ""]);
    setTranches(EMPTY_TRANCHES);
  };
  const reset = () => {
    setSymbol(""); setEntryAuto(true); setSavedPlanId(null);
    setF((p) => ({ ...EMPTY_FORM, capital: p.capital, riskPct: p.riskPct }));
    setTargets(["", "", ""]); setTranches(EMPTY_TRANCHES); setNotes("");
  };
  const loadPlan = (p: SizingPlan) => {
    setSymbol(p.symbol);
    setEntryAuto(false);
    setF({ capital: p.capital, riskPct: p.risk_pct, entry: p.entry, stop: p.stop, qty: "",
           cap: p.cap_bucket ?? "" });
    const t = p.targets.map((x) => x.price);
    setTargets([t[0] ?? "", t[1] ?? "", t[2] ?? ""]);
    setTranches(p.ladder.length
      ? p.ladder.map((x) => ({ trigger: x.trigger, qty: String(x.qty) }))
      : EMPTY_TRANCHES);
    setNotes(p.notes ?? "");
    setSavedPlanId(p.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const planDraft = (): SizingPlanDraft => ({
    symbol, cap_bucket: cap, capital: f.capital, risk_pct: f.riskPct,
    entry: f.entry, stop: f.stop, qty,
    targets: targets.filter((t) => (num(t) ?? 0) > 0).map((t) => ({ price: t.trim() })),
    ladder: tranches
      .filter((t) => (num(t.trigger) ?? 0) > 0 && intOrNull(t.qty) !== null)
      .map((t) => ({ trigger: t.trigger.trim(), qty: intOrNull(t.qty)! })),
    notes: notes.trim() || null,
  });
  const canSave = symbol !== "" && sizing.problem === null && qty > 0;

  // ---- Convert to opportunity (the journal's own form + API) -----------------------------
  const [convert, setConvert] = useState<{ planId: number | null; prefill: OpportunityDraft } | null>(null);
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; action: () => void } | null>(null);

  const prefillFromCurrent = (): OpportunityDraft => {
    const firstTarget = targetRows.find((t) => t.valid);
    const firstTranche = ladder.rows[0];
    return {
      symbol, cap_bucket: cap,
      buy_price: f.entry.trim() || null,
      limit_price: firstTranche ? String(firstTranche.trigger) : null,
      qty: qty > 0 ? qty : null,
      target_price: firstTarget ? String(firstTarget.price) : null,
      stop_price: f.stop.trim() || null,
      action_filter: ladder.rows.length ? "GTT" : "Buy Now",
      notes: [notes.trim(), entry && stop && qty
        ? planSummary({ entry, stop, qty, riskPct: riskPct ?? 0, riskAmount: riskAmount ?? 0, targets: targetRows })
        : ""].filter(Boolean).join("\n"),
    };
  };
  const prefillFromPlan = (p: SizingPlan): OpportunityDraft => {
    const e = num(p.entry) ?? 0; const s = num(p.stop) ?? 0;
    const rows = planTargets(e, s, p.qty, p.targets.map((t) => num(t.price)));
    return {
      symbol: p.symbol, cap_bucket: p.cap_bucket, buy_price: p.entry,
      limit_price: p.ladder[0]?.trigger ?? null, qty: p.qty,
      target_price: rows.find((t) => t.valid)?.price.toString() ?? null,
      stop_price: p.stop,
      action_filter: p.ladder.length ? "GTT" : "Buy Now",
      notes: [p.notes ?? "", planSummary({
        entry: e, stop: s, qty: p.qty, riskPct: num(p.risk_pct) ?? 0,
        riskAmount: (e - s) * p.qty, targets: rows,
      })].filter(Boolean).join("\n"),
    };
  };

  // ---- Render ------------------------------------------------------------------------------
  if (j.isLoading) return <LoadError loading error={null} />;
  if (j.error) return <LoadError loading={false} error={j.error} />;

  const plans = plansQ.data?.plans ?? [];

  return (
    <div>
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Position Sizer</h1>
          <p className="text-sm text-brand-mute">
            Capital × risk % ÷ (entry − stop) — then the journal&apos;s cap-bucket rule decides if it fits.
          </p>
        </div>
        <Link to="/journal#portfolio"
              className="px-3.5 py-2 rounded-xl bg-brand-panel ring-1 ring-brand-border shadow-card
                         hover:shadow-pop transition-shadow text-left">
          <span className="block text-[10px] font-bold uppercase tracking-wider text-brand-mute">Journal</span>
          <span className="text-sm font-display font-semibold tabular-nums">
            ₹{fmtMoney(j.ctx.capital, 0)} capital · {j.openTrades.length} open lot{j.openTrades.length === 1 ? "" : "s"}
          </span>
        </Link>
      </div>

      {notice && (
        <div className="mb-3 px-3.5 py-2 rounded-xl bg-teal-50 ring-1 ring-teal-200 text-teal-900 text-sm">{notice}</div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] items-start">
        {/* ---- Inputs ---- */}
        <aside className="lg:sticky lg:top-[72px] space-y-4">
          <Card title="Trade input" right={symbol && <GhostBtn onClick={reset}>Reset</GhostBtn>}>
            <div className="mb-3">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-brand-mute mb-1">Stock</span>
              <StockPicker value={symbol} stocks={stocks} onPick={pickSymbol} />
            </div>
            <TradeInputs f={f} set={set} journalCapital={j.ctx.capital}
                         autoCap={effectiveCap(null, snap)} sizedQty={sizing.qty}
                         entryFromCmp={entryAuto && !!snap} />
            <div className="mt-3">
              <Field label="Notes">
                <TextArea value={notes} placeholder="Thesis, trigger, what would invalidate it…"
                          onChange={(e) => { setNotes(e.target.value); setSavedPlanId(null); }} />
              </Field>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <PrimaryBtn disabled={!canSave || mSave.isPending || savedPlanId !== null}
                          onClick={() => mSave.mutate(planDraft())}
                          title={canSave ? "Keep these inputs as a plan" : "Needs a stock and a valid size"}>
                {savedPlanId !== null ? "Saved ✓" : mSave.isPending ? "Saving…" : "Save plan"}
              </PrimaryBtn>
              <OwnerOnly>
                <GhostBtn disabled={!canSave}
                          onClick={() => setConvert({ planId: savedPlanId, prefill: prefillFromCurrent() })}
                          title="Open the journal's opportunity form prefilled with this plan">
                  🔭 Convert to opportunity
                </GhostBtn>
              </OwnerOnly>
            </div>
          </Card>
        </aside>

        {/* ---- Results ---- */}
        <div className="space-y-4 min-w-0">
          <StockContext symbol={symbol} row={row} snap={snap} cap={cap} existing={existing}
                        loading={!!symbol && (j.snapsLoading || resultsQ.isLoading)} />
          <SizeVerdict s={sizing} qty={qty} riskAmount={riskAmount} riskPct={riskPctOfCapital} capital={capital}
                       pristine={f.entry.trim() === "" || f.stop.trim() === ""} />
          <div className="grid gap-4 md:grid-cols-2">
            <AllocationRoom g={guard} symbol={symbol}
                            onUseMaxQty={(q) => set("qty", String(q))} />
            <HeatCard h={heat} capital={capital} />
          </div>
          {averaging && <AveragingCard a={averaging} cap={cap} />}
          <div className="grid gap-4 xl:grid-cols-2">
            <TargetsPlanner targets={targets} rows={targetRows} riskAmount={riskAmount} entry={entry}
                            setTarget={(i, v) => { setSavedPlanId(null);
                              setTargets((t) => t.map((x, k) => (k === i ? v : x))); }} />
            <LadderPlanner
              tranches={tranches} plan={ladder} levels={levels} cap={cap} capital={capital} held={heldValue}
              setTranche={(i, patch) => { setSavedPlanId(null);
                setTranches((t) => t.map((x, k) => (k === i ? { ...x, ...patch } : x))); }}
              addTranche={() => setTranches((t) => (t.length < 3 ? [...t, { trigger: "", qty: "" }] : t))}
              removeTranche={(i) => setTranches((t) => (t.length > 1 ? t.filter((_, k) => k !== i) : t))}
              splitSized={qty > 0 ? () => {
                const parts = splitQty(qty, tranches.length);
                setTranches((t) => t.map((x, k) => ({ ...x, qty: parts[k] ? String(parts[k]) : "" })));
              } : null}
            />
          </div>
        </div>
      </div>

      <div className="mt-4">
        {plansQ.error ? <LoadError loading={false} error={plansQ.error} /> : (
          <SavedPlans plans={plans} onLoad={loadPlan}
                      onConvert={(p) => setConvert({ planId: p.id, prefill: prefillFromPlan(p) })}
                      onDelete={(p) => setConfirmState({
                        title: `Delete ${p.symbol} plan?`,
                        message: `Removes the saved plan (${p.qty} × ₹${p.entry}, stop ₹${p.stop}). Any journal opportunity made from it stays.`,
                        action: () => mDelete.mutate(p.id),
                      })} />
        )}
      </div>

      {/* Modals */}
      {convert && (
        <OpportunityModal
          initial={null} prefill={convert.prefill} ctx={j.ctx} busy={mConvert.isPending}
          onClose={() => setConvert(null)}
          onSave={(draft) => mConvert.mutate({ planId: convert.planId, draft })}
        />
      )}
      {confirmState && (
        <ConfirmDialog title={confirmState.title} message={confirmState.message}
                       confirmLabel="Delete" danger busy={mDelete.isPending}
                       onCancel={() => setConfirmState(null)}
                       onConfirm={() => { confirmState.action(); setConfirmState(null); }} />
      )}
    </div>
  );
}
