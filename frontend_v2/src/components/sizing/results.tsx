// -----------------------------------------------------------------------------
// Position Sizer result cards — the verdict (qty · capital · ₹ risk), the
// stock context strip, the Allocation Room card with a plain-₹ explanation
// of any breach, the averaging-down simulator and position heat. Every
// number comes from lib/sizing.ts / lib/journal.ts; nothing is computed here.
// -----------------------------------------------------------------------------
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import type { Snapshot } from "../../lib/api";
import { convictionOf, whyLine } from "../../lib/conviction";
import { CAP_LIMITS } from "../../lib/journal";
import type { CapBucket } from "../../lib/journalApi";
import { fmtMoney, fmtPct } from "../../lib/money";
import type { StockRow } from "../../lib/rows";
import type {
  AllocationGuard, Averaging, ExistingPosition, PortfolioHeat, Sizing,
} from "../../lib/sizing";
import { CapChip, Pnl } from "../journal/ui";
import ScoreRing from "../ScoreRing";
import SignalBadge from "../SignalBadge";

// ---- Shared shells ---------------------------------------------------------------

export function Card({ title, right, tone, children, className = "" }: {
  title: string; right?: ReactNode; tone?: string; children: ReactNode; className?: string;
}) {
  return (
    <section className={`p-4 rounded-2xl ring-1 ring-brand-border shadow-card min-w-0 ${
      tone ?? "bg-brand-panel"} ${className}`}>
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-brand-mute">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">{label}</div>
      <div className={`mt-0.5 text-lg font-display font-semibold tabular-nums leading-tight ${tone ?? ""}`}>
        {value}
      </div>
      {sub !== undefined && <div className="text-[11px] text-brand-mute mt-0.5">{sub}</div>}
    </div>
  );
}

const rs = (n: number | null | undefined, d = 0) => n === null || n === undefined ? "—" : `₹${fmtMoney(n, d)}`;

// ---- Verdict ----------------------------------------------------------------------

export function SizeVerdict({ s, qty, riskAmount, riskPct, capital, pristine = false }: {
  s: Sizing;
  /** Entry or stop not typed yet — show a hint instead of a validation warning. */
  pristine?: boolean;
  /** Effective qty (risk-sized or the user's override). */
  qty: number;
  /** ₹ risk at the effective qty (null when the stop is invalid). */
  riskAmount: number | null;
  riskPct: number | null;
  capital: number | null;
}) {
  const invalid = s.problem !== null;
  const deployed = s.problem === null ? qty * (s.deployed / Math.max(1, s.qty)) : 0;
  const deployedPct = capital && deployed ? (deployed / capital) * 100 : null;
  const overridden = s.problem === null && qty !== s.qty;
  const overBudget = riskAmount !== null && s.riskBudget !== null && riskAmount > s.riskBudget + 0.005;

  return (
    <Card title="Position size"
          tone={invalid ? "bg-brand-panel" : overBudget || s.exceedsCapital
            ? "bg-gradient-to-br from-rose-50 to-brand-panel"
            : "bg-gradient-to-br from-teal-50 to-brand-panel"}
          right={s.riskBudget !== null && (
            <span className="text-[10px] text-brand-mute">
              risk budget <b className="text-brand-text font-mono">{rs(s.riskBudget)}</b>
            </span>
          )}>
      {invalid ? (
        <div className="py-3">
          <div className="text-2xl font-display font-semibold text-brand-mute">—</div>
          {pristine && (s.problem === "entry" || s.problem === "stop") ? (
            <p className="mt-1.5 text-[12px] text-brand-mute bg-brand-soft ring-1 ring-brand-border/60 rounded-lg px-3 py-2">
              Enter an entry and a stop — the quantity, capital and ₹ at risk appear as you type.
            </p>
          ) : (
            <p className="mt-1.5 text-[12px] text-amber-800 bg-amber-50 ring-1 ring-amber-200 rounded-lg px-3 py-2">
              {s.message}
            </p>
          )}
          {s.problem === "zero_qty" && s.maxAffordableQty !== null && (
            <p className="mt-1.5 text-[11px] text-brand-mute">
              Capital alone would afford {s.maxAffordableQty} shares — but the stop is too far for
              this risk budget.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-end gap-3 flex-wrap">
            <div className="text-4xl font-display font-bold tabular-nums leading-none">{qty}</div>
            <div className="text-sm text-brand-mute pb-1">
              shares{overridden && <> · sized <b className="font-mono text-brand-text">{s.qty}</b></>}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Capital deployed" value={rs(deployed)}
                  sub={deployedPct !== null ? `${fmtPct(deployedPct)} of capital` : undefined}
                  tone={s.exceedsCapital || (capital !== null && deployed > capital) ? "text-rose-700" : undefined} />
            <Stat label="₹ at risk" value={rs(riskAmount)}
                  sub={riskPct !== null ? `${fmtPct(riskPct)} of capital` : undefined}
                  tone={overBudget ? "text-rose-700" : undefined} />
            <Stat label="Risk / share" value={rs(s.riskPerShare, 2)}
                  sub={s.stopDistancePct !== null ? `${fmtPct(s.stopDistancePct, 1)} below entry` : undefined} />
            <Stat label="Capital left"
                  value={capital !== null ? rs(capital - deployed) : "—"}
                  tone={capital !== null && capital - deployed < 0 ? "text-rose-700" : undefined} />
          </div>
          {(s.exceedsCapital || (capital !== null && deployed > capital)) && (
            <p className="mt-3 text-[12px] text-rose-800 bg-rose-50 ring-1 ring-rose-200 rounded-lg px-3 py-2">
              ⚠ This size needs more capital than you have — the stop is very tight relative to the
              risk budget. Capital affords at most <b className="font-mono">{s.maxAffordableQty}</b> shares.
            </p>
          )}
          {overBudget && (
            <p className="mt-3 text-[12px] text-rose-800 bg-rose-50 ring-1 ring-rose-200 rounded-lg px-3 py-2">
              ⚠ Your qty override risks <b className="font-mono">{rs(riskAmount)}</b> — above the
              {" "}<b className="font-mono">{rs(s.riskBudget)}</b> budget this risk % allows.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

// ---- Stock context ------------------------------------------------------------------

export function StockContext({ symbol, row, snap, cap, existing, loading }: {
  symbol: string;
  row: StockRow | null;
  snap: Snapshot | undefined;
  cap: CapBucket | null;
  existing: ExistingPosition | null;
  loading: boolean;
}) {
  if (!symbol) {
    return (
      <Card title="Stock context">
        <p className="text-sm text-brand-mute">Pick a stock to pull in CMP, cap bucket, signal and your current position.</p>
      </Card>
    );
  }
  if (loading) return <Card title="Stock context"><p className="text-sm text-brand-mute">Loading market data…</p></Card>;
  if (!snap || !row) {
    return (
      <Card title={`Stock context — ${symbol}`}>
        <p className="text-sm text-amber-800">
          No snapshot for {symbol} yet — entry won&apos;t prefill and the cap bucket must be picked by hand.
          Run a sync from Market Analysis to fetch it.
        </p>
        {existing && <ExistingLine existing={existing} />}
      </Card>
    );
  }
  const conviction = convictionOf(row);
  return (
    <Card title={`Stock context — ${symbol}`}
          right={<Link to={`/stocks/${encodeURIComponent(snap.symbol)}`}
                       className="text-[11px] font-semibold text-brand-accent hover:underline">
                   Stock page →
                 </Link>}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Stat label="CMP" value={rs(row.close, 2)}
              sub={row.trendPct !== null ? <Pnl value={row.trendPct} suffix="% wk" /> : undefined} />
        <Stat label="Cap" value={<CapChip cap={cap} />}
              sub={cap ? `limit ${CAP_LIMITS[cap]}% / stock` : "unknown — pick one"} />
        <Stat label="vs 200 DMA"
              value={row.belowDmaPct === null ? "—"
                : <span className={row.belowDmaPct >= 14 ? "text-teal-700" : row.belowDmaPct >= 9 ? "text-amber-700" : ""}>
                    {row.belowDmaPct >= 0 ? "−" : "+"}{Math.abs(row.belowDmaPct).toFixed(1)}%
                  </span>}
              sub={row.dma200 !== null ? `DMA ${rs(row.dma200, 0)}` : undefined} />
        <Stat label="Off ATH"
              value={row.downFromAthPct === null ? "—" : `${row.downFromAthPct.toFixed(0)}%`}
              sub={row.ath !== null ? `ATH ${rs(row.ath, 0)}` : undefined} />
        <div className="flex items-center gap-4">
          <div className="text-center">
            <SignalBadge status={row.bestStatus} />
            <div className="text-[9px] uppercase tracking-wider text-brand-mute mt-1">Signal</div>
          </div>
          <div className="text-center">
            <ScoreRing points={row.score} size={40} />
            <div className="text-[9px] uppercase tracking-wider text-brand-mute mt-1">Funda</div>
          </div>
          {conviction && (
            <div className="text-center">
              <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ring-1 ${
                conviction === "PRIME" ? "bg-teal-700 text-white ring-teal-700"
                  : conviction === "STRONG" ? "bg-teal-50 text-teal-800 ring-teal-300"
                  : "bg-amber-50 text-amber-800 ring-amber-300"}`}>{conviction}</span>
              <div className="text-[9px] uppercase tracking-wider text-brand-mute mt-1">Conviction</div>
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-[11px] text-brand-mute">{whyLine(row)}</p>
      {existing && <ExistingLine existing={existing} cmp={row.close} />}
    </Card>
  );
}

function ExistingLine({ existing, cmp }: { existing: ExistingPosition; cmp?: number | null }) {
  const cur = cmp ? cmp * existing.qty : null;
  return (
    <div className="mt-3 pt-3 border-t border-brand-border/60 flex flex-wrap gap-x-5 gap-y-2 text-[12px]">
      <span className="font-semibold">💼 Already holding</span>
      <span>{existing.qty} shares · {existing.lots} lot{existing.lots === 1 ? "" : "s"}</span>
      <span>avg <b className="font-mono">{rs(existing.avg, 2)}</b></span>
      <span>invested <b className="font-mono">{rs(existing.invested)}</b></span>
      {cur !== null && <span>now <Pnl value={cur - existing.invested} digits={0} /></span>}
      <span className="text-brand-mute">
        {existing.stop !== null ? <>stop ₹{fmtMoney(existing.stop, 2)}</> : "no stop on record"}
      </span>
    </div>
  );
}

// ---- Allocation Room -----------------------------------------------------------------

export function AllocationRoom({ g, symbol, onUseMaxQty }: {
  g: AllocationGuard; symbol: string; onUseMaxQty?: (q: number) => void;
}) {
  if (!g.capital) {
    return <Card title="Allocation room"><p className="text-sm text-brand-mute">Enter capital to see the allocation limit.</p></Card>;
  }
  if (!g.cap) {
    return (
      <Card title="Allocation room">
        <p className={`text-sm ${symbol ? "text-amber-800" : "text-brand-mute"}`}>
          {symbol
            ? <>No cap bucket for {symbol} — pick one above to apply the per-stock limit.</>
            : <>Pick a stock (or a cap bucket) to see the per-stock limit and the room left under it.</>}
        </p>
        {g.heldValue > 0 && (
          <p className="mt-1.5 text-[12px] text-brand-mute">
            Currently holding {rs(g.heldValue)} ({fmtPct(g.heldPct)} of capital).
          </p>
        )}
      </Card>
    );
  }
  const limit = g.limitValue ?? 0;
  const held = g.heldValue;
  const add = g.addValue ?? 0;
  const room = g.roomValue ?? 0;
  const tone = g.state === "over" ? "bg-gradient-to-br from-rose-50 to-brand-panel"
    : g.state === "warn" ? "bg-gradient-to-br from-amber-50 to-brand-panel"
    : "bg-brand-panel";
  const w = (v: number) => `${Math.min(100, Math.max(0, (v / (limit * 1.25)) * 100))}%`;

  return (
    <Card title="Allocation room" tone={tone}
          right={<span className="text-[10px] text-brand-mute">
            {g.cap} cap · {g.limitPct}% of ₹{fmtMoney(g.capital, 0)}
          </span>}>
      <div className="grid grid-cols-3 gap-3">
        <Stat label={`${g.cap} cap limit`} value={rs(limit)} />
        <Stat label="Current position" value={rs(held)} sub={`${fmtPct(g.heldPct)} of capital`} />
        <Stat label={room < 0 ? "Over by" : "Room left"}
              value={rs(Math.abs(room))}
              tone={room < 0 ? "text-rose-700" : g.state === "warn" ? "text-amber-700" : "text-teal-800"}
              sub={add > 0 ? `after this ${rs(add)} plan` : "before this plan"} />
      </div>
      <div className="relative mt-3 h-3 rounded-full bg-white ring-1 ring-brand-border overflow-hidden">
        <div className="flex h-full">
          <div className="bg-teal-700 h-full" style={{ width: w(Math.min(held, limit)) }} />
          <div className="bg-rose-400 h-full" style={{ width: w(Math.max(0, held - limit)) }} />
          <div className="bg-teal-400 h-full bg-[repeating-linear-gradient(45deg,rgba(255,255,255,.55)_0_3px,transparent_3px_6px)]"
               style={{ width: w(Math.min(add, Math.max(0, limit - held))) }} />
          <div className="bg-rose-500 h-full bg-[repeating-linear-gradient(45deg,rgba(255,255,255,.45)_0_3px,transparent_3px_6px)]"
               style={{ width: w(Math.max(0, add - Math.max(0, limit - held))) }} />
        </div>
        <div aria-hidden className="absolute inset-y-0 w-px bg-brand-text/70" style={{ left: "80%" }} />
      </div>
      {g.state === "over" && g.excessValue !== null ? (
        <div className="mt-3 text-[12px] text-rose-900 bg-rose-50 ring-1 ring-rose-200 rounded-lg px-3 py-2.5">
          <div className="font-bold">⚠ Position exceeds the {g.cap} cap limit</div>
          <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono tabular-nums text-[11.5px]">
            <span className="text-rose-800/80 font-sans">Current allocation</span><span className="text-right">{rs(held)}</span>
            <span className="text-rose-800/80 font-sans">Proposed allocation</span><span className="text-right">{rs(add)}</span>
            <span className="text-rose-800/80 font-sans">Total</span><span className="text-right font-bold">{rs(g.totalValue)}</span>
            <span className="text-rose-800/80 font-sans">Maximum allowed</span><span className="text-right">{rs(limit)}</span>
            <span className="text-rose-800/80 font-sans">Excess</span><span className="text-right font-bold">{rs(g.excessValue)}</span>
          </div>
          {g.maxQty !== null && (
            <p className="mt-1.5 font-sans">
              At this price the rule allows <b className="font-mono">{g.maxQty}</b> share{g.maxQty === 1 ? "" : "s"}.
              {onUseMaxQty && g.maxQty > 0 && (
                <button type="button" onClick={() => onUseMaxQty(g.maxQty!)}
                        className="ml-1.5 px-1.5 py-0.5 rounded font-semibold text-rose-900 bg-white ring-1 ring-rose-300 hover:bg-rose-100">
                  Use {g.maxQty}
                </button>
              )}
            </p>
          )}
        </div>
      ) : (
        <p className={`mt-2.5 text-[12px] ${g.state === "warn" ? "text-amber-800" : "text-brand-mute"}`}>
          {g.state === "warn" ? "Close to the limit — " : "✓ Within the limit — "}
          total {fmtPct(g.totalPct)} of {g.limitPct}%
          {g.maxQty !== null && <>; this price allows up to <b className="font-mono text-brand-text">{g.maxQty}</b> shares</>}.
        </p>
      )}
    </Card>
  );
}

// ---- Position heat -----------------------------------------------------------------------

export function HeatCard({ h, capital }: { h: PortfolioHeat; capital: number | null }) {
  const noBook = h.lotsWithStop === 0 && h.lotsWithoutStop === 0;
  return (
    <Card title="Position heat"
          right={<span className="text-[10px] text-brand-mute">open risk from lots with a stop</span>}>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-brand-soft ring-1 ring-brand-border/60 px-3 py-2.5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">Capital risk</div>
          <div className="mt-0.5 text-lg font-display font-semibold tabular-nums">{rs(h.newRisk)}</div>
          <div className="text-[11px] text-brand-mute">
            {capital ? `${fmtPct((h.newRisk / capital) * 100)} of total capital` : "this trade"}
          </div>
        </div>
        <div className="rounded-xl bg-brand-soft ring-1 ring-brand-border/60 px-3 py-2.5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">Portfolio risk</div>
          <div className="mt-0.5 text-lg font-display font-semibold tabular-nums">
            {h.newShare === null ? "—" : `${h.newShare.toFixed(0)}%`}
          </div>
          <div className="text-[11px] text-brand-mute">
            of {rs(h.combinedRisk)} aggregate open risk
            {h.combinedPct !== null && <> ({fmtPct(h.combinedPct)} of capital)</>}
          </div>
        </div>
      </div>
      <p className="mt-2.5 text-[11px] text-brand-mute">
        {noBook
          ? "No open lots in the journal — this trade would be your entire open risk."
          : <>
              Existing open risk <b className="font-mono text-brand-text">{rs(h.openRisk)}</b> across{" "}
              {h.lotsWithStop} lot{h.lotsWithStop === 1 ? "" : "s"} with a stop
              {h.lotsWithoutStop > 0 && (
                <> · <span className="text-amber-800" title={h.symbolsWithoutStop.join(", ")}>
                  {h.lotsWithoutStop} lot{h.lotsWithoutStop === 1 ? "" : "s"} without a stop
                  ({h.symbolsWithoutStop.slice(0, 5).join(", ")}
                  {h.symbolsWithoutStop.length > 5 && ` +${h.symbolsWithoutStop.length - 5} more`}) carry
                  unmeasured risk — add stops in the journal to see true portfolio heat</span></>
              )}.
            </>}
      </p>
    </Card>
  );
}

// ---- Averaging down --------------------------------------------------------------------------

export function AveragingCard({ a, cap }: { a: Averaging; cap: CapBucket | null }) {
  const tone = a.state === "over" ? "text-rose-700" : a.state === "warn" ? "text-amber-700" : "text-teal-800";
  return (
    <Card title="Averaging simulator" right={<span className="text-[10px] text-brand-mute">existing + proposed</span>}>
      <div className="grid grid-cols-3 gap-2 text-[12px]">
        <div className="rounded-xl bg-brand-soft ring-1 ring-brand-border/60 px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">Existing position</div>
          <div className="mt-1 font-mono tabular-nums">{a.existingQty} × {rs(a.existingAvg, 2)}</div>
          <div className="text-brand-mute">{rs(a.existingValue)}</div>
        </div>
        <div className="rounded-xl bg-teal-50 ring-1 ring-teal-200 px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-teal-800">Proposed addition</div>
          <div className="mt-1 font-mono tabular-nums">{a.addQty} × {rs(a.addPrice, 2)}</div>
          <div className="text-teal-900/70">{rs(a.addValue)}</div>
        </div>
        <div className="rounded-xl bg-brand-panel ring-1 ring-brand-border px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">Blended</div>
          <div className="mt-1 font-mono tabular-nums font-semibold">{a.newQty} × {rs(a.newAvg, 2)}</div>
          <div className="text-brand-mute">
            avg <Pnl value={a.avgChangePct} suffix="%" digits={1} />
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        <span>Total deployed <b className="font-mono">{rs(a.totalValue)}</b></span>
        <span className={tone}>
          Allocation <b className="font-mono">{fmtPct(a.newAllocPct)}</b>
          {cap && <span className="text-brand-mute"> of {CAP_LIMITS[cap]}% ({cap})</span>}
          {a.state === "over" && " — over the limit"}
        </span>
        {a.riskAtStop !== null && (
          <span>Risk if stop hits <b className="font-mono">{rs(a.riskAtStop)}</b>
            {a.riskPctOfCapital !== null && <span className="text-brand-mute"> ({fmtPct(a.riskPctOfCapital)})</span>}
          </span>
        )}
      </div>
    </Card>
  );
}
