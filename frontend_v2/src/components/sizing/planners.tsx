// -----------------------------------------------------------------------------
// Position Sizer planners — reward targets (R multiples) and the GTT entry
// ladder with Plutus level suggestions (200-DMA envelope, rally low, 52w low).
// -----------------------------------------------------------------------------
import { fmtMoney, fmtPct } from "../../lib/money";
import type { LadderPlan, SuggestedLevel, TargetRow } from "../../lib/sizing";
import { AllocMarker, GhostBtn, NumInput } from "../journal/ui";
import type { CapBucket } from "../../lib/journalApi";
import { Card } from "./results";

const rs = (n: number | null | undefined, d = 0) => n === null || n === undefined ? "—" : `₹${fmtMoney(n, d)}`;

// ---- Targets ---------------------------------------------------------------------

export function TargetsPlanner({ targets, setTarget, rows, riskAmount, entry }: {
  targets: string[];
  setTarget: (i: number, v: string) => void;
  rows: TargetRow[];
  riskAmount: number | null;
  entry: number | null;
}) {
  const bestR = rows.filter((r) => r.valid && r.rMultiple !== null)
    .reduce<number | null>((m, r) => (m === null || r.rMultiple! > m ? r.rMultiple! : m), null);
  return (
    <Card title="Reward targets"
          right={bestR !== null && (
            <span className={`text-[10px] font-semibold ${bestR >= 2 ? "text-teal-800" : "text-amber-800"}`}>
              best {bestR.toFixed(1)}R {bestR >= 2 ? "· reward justifies the risk" : "· thin reward for the risk"}
            </span>
          )}>
      <div className="grid grid-cols-3 gap-2">
        {targets.map((t, i) => (
          <label key={i} className="block">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-brand-mute mb-1">T{i + 1}</span>
            <NumInput prefix="₹" inputMode="decimal" placeholder="0.00" value={t}
                      invalid={t.trim() !== "" && !(Number(t) > 0) || (Number(t) > 0 && entry !== null && Number(t) <= entry)}
                      onChange={(e) => setTarget(i, e.target.value)} />
          </label>
        ))}
      </div>
      {entry !== null && (
        <div className="flex gap-1 mt-2">
          {[5, 10, 20].map((p) => (
            <button key={p} type="button"
                    onClick={() => {
                      const slot = targets.findIndex((t) => t.trim() === "");
                      setTarget(slot === -1 ? targets.length - 1 : slot, (entry * (1 + p / 100)).toFixed(2));
                    }}
                    className="px-2 py-0.5 rounded-full text-[10px] font-medium ring-1 bg-brand-soft
                               text-brand-mute ring-brand-border hover:text-brand-text">
              +{p}%
            </button>
          ))}
        </div>
      )}
      {rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
                <th className="text-left py-1">Target</th>
                <th className="text-right py-1">Price</th>
                <th className="text-right py-1">Gain / sh</th>
                <th className="text-right py-1">Total gain</th>
                <th className="text-right py-1">Gain %</th>
                <th className="text-right py-1">R</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className={`border-t border-brand-border/50 tabular-nums ${r.valid ? "" : "text-rose-700"}`}>
                  <td className="py-1.5 font-semibold">{r.label}{!r.valid && <span className="ml-1 text-[10px]">below entry</span>}</td>
                  <td className="py-1.5 text-right font-mono">{rs(r.price, 2)}</td>
                  <td className="py-1.5 text-right font-mono">{rs(r.gainPerShare, 2)}</td>
                  <td className="py-1.5 text-right font-mono font-semibold">{rs(r.totalGain)}</td>
                  <td className="py-1.5 text-right font-mono">{fmtPct(r.gainPct, 1)}</td>
                  <td className="py-1.5 text-right font-mono">
                    {r.rMultiple === null ? "—" : (
                      <span className={r.rMultiple >= 2 ? "text-teal-800 font-semibold" : r.rMultiple >= 1 ? "" : "text-rose-700"}>
                        {r.rMultiple.toFixed(1)}R
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {riskAmount !== null && (
            <p className="mt-2 text-[11px] text-brand-mute">
              1R = {rs(riskAmount)} — the amount lost if the stop is hit. A target at 2R makes twice what it risks.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-brand-mute">
          Add a target to see the gain, gain % and R multiple against the stop.
        </p>
      )}
    </Card>
  );
}

// ---- GTT ladder ---------------------------------------------------------------------

export interface TrancheForm { trigger: string; qty: string }

export function LadderPlanner({ tranches, setTranche, addTranche, removeTranche, splitSized, levels,
                                plan, cap, capital, held }: {
  tranches: TrancheForm[];
  setTranche: (i: number, patch: Partial<TrancheForm>) => void;
  addTranche: () => void;
  removeTranche: (i: number) => void;
  /** Fill tranche quantities by splitting the risk-sized qty evenly. */
  splitSized: (() => void) | null;
  levels: SuggestedLevel[];
  plan: LadderPlan;
  cap: CapBucket | null;
  capital: number | null;
  held: number;
}) {
  return (
    <Card title="GTT entry ladder"
          right={<span className="text-[10px] text-brand-mute">{tranches.length} tranche{tranches.length === 1 ? "" : "s"}</span>}>
      {/* Suggested levels — from Plutus data only; unavailable ones say so */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {levels.map((l) => (
          <button key={l.key} type="button" disabled={l.price === null}
                  title={l.price === null ? `${l.label}: ${l.hint}` : `${l.label} — ${l.hint}. Click to fill the next empty trigger.`}
                  onClick={() => {
                    if (l.price === null) return;
                    const slot = tranches.findIndex((t) => t.trigger.trim() === "");
                    setTranche(slot === -1 ? tranches.length - 1 : slot, { trigger: l.price.toFixed(2) });
                  }}
                  className={`px-2 py-1 rounded-lg text-[11px] ring-1 text-left ${
                    l.price === null
                      ? "bg-brand-soft text-brand-mute/60 ring-brand-border/60 cursor-not-allowed line-through"
                      : "bg-brand-soft text-brand-text ring-brand-border hover:bg-teal-50 hover:ring-teal-300"}`}>
            <span className="font-medium">{l.label}</span>{" "}
            <span className="font-mono tabular-nums">{l.price === null ? "n/a" : `₹${fmtMoney(l.price, 2)}`}</span>
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {tranches.map((t, i) => (
          <div key={i} className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2">
            <span className="text-[11px] font-bold text-brand-mute w-5">#{i + 1}</span>
            <NumInput prefix="₹" inputMode="decimal" placeholder="trigger" value={t.trigger}
                      invalid={t.trigger.trim() !== "" && !(Number(t.trigger) > 0)}
                      onChange={(e) => setTranche(i, { trigger: e.target.value })} />
            <NumInput inputMode="numeric" placeholder="qty" value={t.qty}
                      invalid={t.qty.trim() !== "" && !(Number.isInteger(Number(t.qty)) && Number(t.qty) > 0)}
                      onChange={(e) => setTranche(i, { qty: e.target.value })} />
            <button type="button" onClick={() => removeTranche(i)} disabled={tranches.length <= 1}
                    className="w-6 h-6 grid place-items-center rounded text-xs text-brand-mute hover:text-rose-600
                               hover:bg-rose-50 disabled:opacity-30" title="Remove tranche">✕</button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {tranches.length < 3 && <GhostBtn onClick={addTranche}>+ Tranche</GhostBtn>}
        {splitSized && <GhostBtn onClick={splitSized} title="Split the risk-sized quantity evenly">Split sized qty</GhostBtn>}
      </div>

      {plan.rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
                <th className="text-left py-1">Tranche</th>
                <th className="text-right py-1">Trigger</th>
                <th className="text-right py-1">Qty</th>
                <th className="text-right py-1">Capital</th>
                <th className="text-right py-1">Cum. avg</th>
                <th className="text-right py-1">Cumulative</th>
                {cap && <th className="text-right py-1">Limit</th>}
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={r.index} className="border-t border-brand-border/50 tabular-nums">
                  <td className="py-1.5 font-semibold">{r.index}</td>
                  <td className="py-1.5 text-right font-mono">{rs(r.trigger, 2)}</td>
                  <td className="py-1.5 text-right font-mono">{r.qty}</td>
                  <td className="py-1.5 text-right font-mono">{rs(r.capital)}</td>
                  <td className="py-1.5 text-right font-mono text-brand-mute">{rs(r.cumAvg, 2)}</td>
                  <td className="py-1.5 text-right font-mono">
                    {r.cumPct === null ? rs(r.cumCapital) : fmtPct(r.cumPct)}
                  </td>
                  {cap && (
                    <td className="py-1.5 text-right">
                      <span className="inline-flex items-center gap-1.5 font-mono">
                        {fmtPct(r.totalPct)}
                        <AllocMarker state={r.state} cap={cap} totalPct={r.totalPct} />
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className={`mt-2 text-[11px] ${plan.state === "over" ? "text-rose-700" : "text-brand-mute"}`}>
            Full ladder: <b className="font-mono text-brand-text">{plan.totalQty}</b> shares for{" "}
            <b className="font-mono text-brand-text">{rs(plan.totalCapital)}</b> at an average of{" "}
            <b className="font-mono text-brand-text">{rs(plan.avgPrice, 2)}</b>
            {capital !== null && plan.totalPct !== null && <> — {fmtPct(plan.totalPct)} of capital{held > 0 ? " incl. what you hold" : ""}</>}
            {plan.roomValue !== null && (
              plan.roomValue < 0
                ? <>. <b>Over the {cap} cap limit by {rs(-plan.roomValue)}</b> once every tranche fills.</>
                : <>. {rs(plan.roomValue)} of room stays under the {cap} cap limit.</>
            )}
          </p>
        </div>
      )}
    </Card>
  );
}
