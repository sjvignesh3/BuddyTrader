// -----------------------------------------------------------------------------
// "My positions" panel on the stock page — the Trading Journal's open lots and
// booked history for this one stock, plus the ABCD averaging signal: which
// leg comes next, where it triggers, and (once CMP has fallen through) an
// "Add leg" action that opens the journal's trade form prefilled with the
// previous leg's entry as target. This page is where fundamentals are
// checked, so the advisory signal lives here as well as in the journal.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Snapshot } from "../lib/api";
import { journalApi, type TradeDraft } from "../lib/journalApi";
import {
  abcdLegDraft, buildOpenInvested, deriveAbcd, deriveClosedTrade, legLabel, num,
  type AbcdSignal, type JournalCtx,
} from "../lib/journal";
import { fmtDate, fmtMoney, fmtPct } from "../lib/money";
import { TradeModal } from "./journal/modals";
import { OwnerOnly } from "./AuthGate";

function plainSymbol(symbol: string): string {
  return symbol.replace(/\.(NS|BO)$/i, "");
}

function PnlText({ v, suffix = "", digits = 2 }: {
  v: number | null; suffix?: string; digits?: number;
}) {
  if (v === null) return <span className="text-brand-mute">—</span>;
  const cls = v > 0 ? "text-teal-700" : v < 0 ? "text-rose-600" : "text-brand-mute";
  return (
    <span className={`${cls} font-semibold tabular-nums`}>
      {v > 0 ? "+" : ""}{v.toLocaleString("en-IN", {
        minimumFractionDigits: digits, maximumFractionDigits: digits })}{suffix}
    </span>
  );
}

const th = "px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-wider text-brand-mute whitespace-nowrap text-left";
const thR = th + " text-right";
const td = "px-2.5 py-1.5 whitespace-nowrap text-[11.5px] tabular-nums";
const tdR = td + " text-right";

export default function StockPositions({ symbol, cmp, snapshot }: {
  symbol: string;
  /** current close from the snapshot row (may be null) */
  cmp: number | null;
  /** The stock's latest snapshot — feeds the ABCD cap bucket + CMP. */
  snapshot?: Snapshot;
}) {
  const plain = plainSymbol(symbol);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["journal", "trades", "symbol", plain],
    queryFn: () => journalApi.tradesBySymbol(plain),
    staleTime: 30_000,
  });
  const settingsQ = useQuery({
    queryKey: ["journal", "settings"],
    queryFn: journalApi.settings,
    staleTime: 60_000,
    retry: 1,
  });
  const [legDraft, setLegDraft] = useState<TradeDraft | null>(null);
  const mAddLeg = useMutation({
    mutationFn: (draft: TradeDraft) => journalApi.createTrade(draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal"] });
      setLegDraft(null);
    },
  });

  const trades = useMemo(() => q.data?.trades ?? [], [q.data]);
  const open = useMemo(() => trades.filter((t) => t.status === "OPEN"), [trades]);
  const closed = trades.filter((t) => t.status === "CLOSED");

  // Mini journal context — this stock's snapshot + its open lots only.
  const ctx: JournalCtx = useMemo(() => ({
    capital: num(settingsQ.data?.settings.capital) ?? 0,
    snaps: new Map(snapshot ? [[plain, snapshot]] : []),
    openInvested: buildOpenInvested(open),
  }), [plain, snapshot, settingsQ.data, open]);
  const abcd = useMemo(() => deriveAbcd(open, ctx), [open, ctx]);

  if (q.isLoading) {
    return <div className="text-xs text-brand-mute py-6 text-center">Loading journal…</div>;
  }
  if (q.error) {
    return (
      <div className="text-xs text-rose-600 py-6 text-center">
        Could not load journal data — is the API running?
      </div>
    );
  }

  if (!trades.length) {
    return (
      <div className="py-8 text-center">
        <div className="text-2xl mb-1.5">📓</div>
        <p className="text-xs text-brand-mute mb-3">
          No journal entries for {plain} — you don't hold it and never have.
        </p>
        <Link to="/journal"
              className="text-[11px] font-semibold text-brand-accent hover:underline">
          Open Trading Journal →
        </Link>
      </div>
    );
  }

  const invested = open.reduce((s, t) => s + (num(t.buy_price) ?? 0) * t.qty, 0);
  const qty = open.reduce((s, t) => s + t.qty, 0);
  const curValue = cmp !== null ? cmp * qty : null;
  const unrealized = curValue !== null ? curValue - invested : null;
  const realized = closed.reduce((s, t) => s + (deriveClosedTrade(t).gain ?? 0), 0);
  const legOf = new Map(abcd?.legs.map((l, i) => [l.id, legLabel(i)]) ?? []);

  return (
    <div className="space-y-3">
      {/* Summary strip */}
      <div className="flex flex-wrap gap-2">
        {[
          ["Open qty", <span key="q" className="tabular-nums font-bold">{qty}</span>],
          ["Invested", <span key="i" className="tabular-nums font-bold">₹{fmtMoney(invested, 0)}</span>],
          ["Cur. value", <span key="c" className="tabular-nums font-bold">{curValue !== null ? `₹${fmtMoney(curValue, 0)}` : "—"}</span>],
          ["Unrealized", <PnlText key="u" v={unrealized} digits={0} />],
          ["Realized", <PnlText key="r" v={closed.length ? realized : null} digits={0} />],
        ].map(([label, node]) => (
          <div key={String(label)}
               className="bg-brand-soft ring-1 ring-brand-border rounded-lg px-2.5 py-1.5 text-center min-w-[80px]">
            <div className="text-[9px] uppercase tracking-wider text-brand-mute">{label}</div>
            <div className="text-xs mt-0.5">{node}</div>
          </div>
        ))}
        <Link to="/journal#open"
              className="ml-auto self-center text-[11px] font-semibold px-3 py-1.5 rounded-lg
                         bg-brand-soft ring-1 ring-brand-border text-brand-accent
                         hover:bg-teal-50 hover:ring-teal-300 transition-colors"
              onClick={(e) => e.stopPropagation()}>
          Open journal →
        </Link>
      </div>

      {/* ABCD averaging — the next leg for this position */}
      {abcd && (
        <AbcdPanel sig={abcd} onAddLeg={() => setLegDraft(abcdLegDraft(abcd))} />
      )}
      {mAddLeg.error != null && (
        <div className="text-[11px] text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded-lg px-3 py-1.5">
          ⚠ {mAddLeg.error instanceof Error ? mAddLeg.error.message : String(mAddLeg.error)}
        </div>
      )}

      {/* Open lots */}
      {open.length > 0 && (
        <div className="rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-card overflow-x-auto">
          <div className="px-3 pt-2 text-[10px] font-bold uppercase tracking-wider text-brand-mute">
            Open lots ({open.length})
          </div>
          <table className="min-w-full">
            <thead><tr>
              <th className={th}>Leg</th>
              <th className={th}>Buy date</th><th className={thR}>Buy ₹</th>
              <th className={thR}>Qty</th><th className={th}>Strategy</th>
              <th className={thR}>Target ₹</th><th className={thR}>Invested</th>
              <th className={thR}>Gain</th><th className={thR}>To target</th>
            </tr></thead>
            <tbody>
              {open.map((t) => {
                const buy = num(t.buy_price) ?? 0;
                const target = num(t.target_price);
                const gainPct = cmp !== null && buy ? ((cmp - buy) / buy) * 100 : null;
                const remPct = cmp !== null && target ? ((target - cmp) / cmp) * 100 : null;
                const isRef = abcd?.ref.id === t.id;
                return (
                  <tr key={t.id} className={`border-t border-brand-border/60 ${
                    isRef && abcd?.zone === "due" ? "bg-indigo-50/60" : ""}`}>
                    <td className={td + " font-bold text-brand-mute"}>
                      {legOf.get(t.id) ?? "—"}
                      {isRef && <span className="ml-1 font-normal text-[9px]" title="Reference leg — the next leg triggers below this entry">ref</span>}
                    </td>
                    <td className={td}>{fmtDate(t.buy_date)}</td>
                    <td className={tdR}>{fmtMoney(t.buy_price)}</td>
                    <td className={tdR}>{t.qty}</td>
                    <td className={td}>{t.strategy ?? "—"}</td>
                    <td className={tdR}>{fmtMoney(t.target_price)}</td>
                    <td className={tdR}>{fmtMoney(buy * t.qty, 0)}</td>
                    <td className={tdR}><PnlText v={gainPct} suffix="%" /></td>
                    <td className={tdR + " text-teal-800"}>{fmtPct(remPct)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Booked history */}
      {closed.length > 0 && (
        <div className="rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-card overflow-x-auto">
          <div className="px-3 pt-2 text-[10px] font-bold uppercase tracking-wider text-brand-mute">
            Booked ({closed.length})
          </div>
          <table className="min-w-full">
            <thead><tr>
              <th className={th}>Buy date</th><th className={thR}>Buy ₹</th>
              <th className={thR}>Qty</th><th className={th}>Sell date</th>
              <th className={thR}>Sell ₹</th><th className={thR}>Gain ₹</th>
              <th className={thR}>Gain %</th><th className={thR}>Days</th>
            </tr></thead>
            <tbody>
              {closed.map((t) => {
                const d = deriveClosedTrade(t);
                return (
                  <tr key={t.id} className="border-t border-brand-border/60">
                    <td className={td}>{fmtDate(t.buy_date)}</td>
                    <td className={tdR}>{fmtMoney(t.buy_price)}</td>
                    <td className={tdR}>{t.qty}</td>
                    <td className={td}>{fmtDate(t.sell_date)}</td>
                    <td className={tdR}>{fmtMoney(t.sell_price)}</td>
                    <td className={tdR}><PnlText v={d.gain} digits={0} /></td>
                    <td className={tdR}><PnlText v={d.gainPct} suffix="%" /></td>
                    <td className={tdR}>{d.days ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {legDraft && (
        <TradeModal
          initial={null} prefill={legDraft} ctx={ctx} busy={mAddLeg.isPending}
          onClose={() => setLegDraft(null)}
          onSave={(draft) => mAddLeg.mutate(draft)}
        />
      )}
    </div>
  );
}

/** The ABCD line for this position: eligible / blocked / waiting. */
function AbcdPanel({ sig, onAddLeg }: { sig: AbcdSignal; onAddLeg: () => void }) {
  if (sig.triggerPrice === null || sig.thresholdPct === null) {
    return (
      <div className="text-[11px] text-brand-mute px-1">
        🪜 ABCD: no cap bucket for {sig.symbol} — set one on a lot to get the next-leg trigger.
      </div>
    );
  }
  const prev = `leg ${sig.refLeg} entry ₹${fmtMoney(sig.refEntry)}`;
  if (sig.zone === "due") {
    return (
      <div className="rounded-xl bg-indigo-50 ring-1 ring-indigo-200 px-3.5 py-2.5 text-[11.5px] text-indigo-950">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-bold">🪜 Leg {sig.nextLeg} eligible</span>
          <span className="text-indigo-900/80">
            CMP ₹{fmtMoney(sig.cmp)} is <b>{fmtPct(sig.fallPct)}</b> below {prev}
            {" "}(threshold {sig.thresholdPct}% · {sig.cap} cap).
          </span>
          <OwnerOnly>
            <button type="button" onClick={onAddLeg}
                    className="ml-auto text-[11px] font-bold px-3 py-1.5 rounded-lg bg-indigo-600
                               text-white shadow-card hover:bg-indigo-700 transition-colors">
              ＋ Add leg {sig.nextLeg}
            </button>
          </OwnerOnly>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-indigo-900/80">
          <span>Trigger <b className="font-mono">≤ ₹{fmtMoney(sig.triggerPrice)}</b></span>
          <span>Target <b className="font-mono">₹{fmtMoney(sig.targetPrice)}</b> ({prev.split(" entry")[0]} entry)</span>
          <span>
            Room {sig.maxQty === null
              ? "unknown — set capital in the journal"
              : <><b className="font-mono">{sig.maxQty}</b> share{sig.maxQty === 1 ? "" : "s"} under the {sig.cap}-cap limit</>}
          </span>
          <span className="basis-full italic text-indigo-900/60">
            Advisory — check the fundamentals above before adding.
          </span>
        </div>
      </div>
    );
  }
  if (sig.zone === "blocked") {
    return (
      <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 px-3.5 py-2.5 text-[11.5px] text-rose-900">
        <span className="font-bold">🪜 Leg {sig.nextLeg} triggered, no room</span>{" "}
        <span className="text-rose-900/80">
          CMP ₹{fmtMoney(sig.cmp)} is {fmtPct(sig.fallPct)} below {prev}, but {sig.symbol} is already
          at its {sig.cap}-cap allocation limit. Trigger ≤ ₹{fmtMoney(sig.triggerPrice)} · target ₹{fmtMoney(sig.targetPrice)}.
        </span>
      </div>
    );
  }
  return (
    <div className="text-[11px] text-brand-mute px-1">
      🪜 ABCD: leg <b>{sig.nextLeg}</b> triggers at <b className="font-mono">₹{fmtMoney(sig.triggerPrice)}</b>
      {" "}({sig.thresholdPct}% below {prev})
      {sig.toTriggerPct !== null && <> — CMP is {fmtPct(sig.toTriggerPct)} above</>}
      {" "}· target ₹{fmtMoney(sig.targetPrice)}.
    </div>
  );
}
