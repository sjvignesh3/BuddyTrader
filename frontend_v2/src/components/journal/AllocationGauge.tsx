// -----------------------------------------------------------------------------
// Live allocation gauge for the journal forms — answers "how many shares can I
// buy?" while you type. Shows what this symbol already holds in OPEN trades,
// what the typed buy × qty adds, and both against the cap-bucket limit
// (Large 5% / Mid 3% / Small 2% / Micro 1.5% of capital, per stock).
// -----------------------------------------------------------------------------
import type { CapBucket } from "../../lib/journalApi";
import type { JournalCtx } from "../../lib/journal";
import { planAllocation } from "../../lib/journal";
import { fmtMoney } from "../../lib/money";

/** The limit tick sits here on the track, leaving room to show an overshoot. */
const LIMIT_POS = 0.72;

export default function AllocationGauge({
  symbol, cap, buyPrice, qty, ctx, excludeHeld = 0, onUseMaxQty,
}: {
  symbol: string;
  /** Effective cap bucket (form choice, else the snapshot's). */
  cap: CapBucket | null;
  buyPrice: number | null;
  qty: number | null;
  ctx: JournalCtx;
  excludeHeld?: number;
  /** Wired to the qty field — one click sizes the position to the limit. */
  onUseMaxQty?: (q: number) => void;
}) {
  const a = planAllocation({ symbol, cap, buyPrice, qty, ctx, excludeHeld });

  if (!a.capital) {
    return (
      <Shell>
        <p className="text-[11px] text-brand-mute">
          Set your capital in the journal header to see allocation here.
        </p>
      </Shell>
    );
  }

  // Track scale: the limit sits at LIMIT_POS, so anything past it reads as
  // an overshoot. Without a cap bucket, scale to the plan itself.
  const scale = a.limitPct !== null
    ? a.limitPct / LIMIT_POS
    : Math.max(a.totalPct ?? 0, 1) / LIMIT_POS;
  const w = (pct: number) => `${Math.min(100, Math.max(0, (pct / scale) * 100))}%`;

  const held = a.heldPct ?? 0;
  const add = a.addPct ?? 0;
  const limit = a.limitPct ?? Infinity;
  const heldIn = Math.min(held, limit);
  const heldOver = Math.max(0, held - limit);
  const addIn = Math.min(add, Math.max(0, limit - held));
  const addOver = add - addIn;

  const tone = a.state === "over" ? "text-rose-700"
    : a.state === "warn" ? "text-amber-700" : "text-teal-800";

  return (
    <Shell>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
          Allocation{symbol ? ` — ${symbol}` : ""}
        </span>
        <span className="text-[10px] text-brand-mute">
          {cap
            ? <>{cap} cap · limit <b className="text-brand-text">{a.limitPct}%</b> of ₹{fmtMoney(a.capital, 0)}</>
            : <>no cap bucket — pick one for the limit</>}
        </span>
      </div>

      {/* Bar: held (solid) + this plan (striped), red past the limit */}
      <div className="relative h-3 rounded-full bg-white ring-1 ring-brand-border overflow-hidden">
        <div className="flex h-full">
          <Seg width={w(heldIn)} className="bg-teal-700" />
          <Seg width={w(heldOver)} className="bg-rose-400" />
          <Seg width={w(addIn)} className="bg-teal-400 bg-[repeating-linear-gradient(45deg,rgba(255,255,255,.55)_0_3px,transparent_3px_6px)]" />
          <Seg width={w(addOver)} className="bg-rose-500 bg-[repeating-linear-gradient(45deg,rgba(255,255,255,.45)_0_3px,transparent_3px_6px)]" />
        </div>
        {a.limitPct !== null && (
          <div aria-hidden
               className="absolute inset-y-0 w-px bg-brand-text/70"
               style={{ left: `${LIMIT_POS * 100}%` }} />
        )}
      </div>

      {/* Numbers */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
        <span className="inline-flex items-center gap-1 text-brand-mute">
          <Dot className="bg-teal-700" />
          Held <b className="text-brand-text font-mono">{fmt(a.heldPct)}</b>
          <span className="font-mono">(₹{fmtMoney(a.heldValue, 0)})</span>
        </span>
        {a.addPct !== null && (
          <span className="inline-flex items-center gap-1 text-brand-mute">
            <Dot className="bg-teal-400" />
            This plan <b className="text-brand-text font-mono">+{fmt(a.addPct)}</b>
            <span className="font-mono">(₹{fmtMoney(a.addValue, 0)})</span>
          </span>
        )}
        {a.totalPct !== null && (
          <span className={`ml-auto font-semibold ${tone}`}>
            Total <span className="font-mono">{fmt(a.totalPct)}</span>
            {a.limitPct !== null && <span className="text-brand-mute"> of {a.limitPct}%</span>}
          </span>
        )}
      </div>

      {/* The verdict — what qty the rule allows */}
      {a.limitPct !== null && a.maxQty !== null && (
        <p className={`mt-1.5 text-[11px] leading-relaxed ${
          a.state === "over" ? "text-rose-700" : "text-brand-mute"}`}>
          {a.state === "over" ? (
            <>
              ⚠ Over the {cap}-cap limit by{" "}
              <b className="font-mono">{fmt((a.totalPct ?? 0) - a.limitPct)}</b> —
              this price allows <b className="font-mono">{a.maxQty}</b> share
              {a.maxQty === 1 ? "" : "s"}
              {a.qtyDelta !== null && a.qtyDelta < 0 && <> ({-a.qtyDelta} too many)</>}.
            </>
          ) : (
            <>
              ✓ Room for <b className="font-mono text-brand-text">{a.maxQty}</b> share
              {a.maxQty === 1 ? "" : "s"} at this price
              {a.qtyDelta !== null && a.qtyDelta > 0 && qty !== null && (
                <> — <b className="font-mono">{a.qtyDelta}</b> more than planned</>
              )}
              {a.roomValue !== null && a.roomValue > 0 && (
                <> · <span className="font-mono">₹{fmtMoney(a.roomValue, 0)}</span> left under the limit</>
              )}
            </>
          )}
          {onUseMaxQty && a.maxQty > 0 && a.maxQty !== qty && (
            <button type="button" onClick={() => onUseMaxQty(a.maxQty!)}
                    className="ml-1.5 px-1.5 py-0.5 rounded font-semibold text-teal-800
                               bg-teal-50 ring-1 ring-teal-200 hover:bg-teal-100">
              Use {a.maxQty}
            </button>
          )}
        </p>
      )}
    </Shell>
  );
}

const fmt = (p: number | null) => (p === null ? "—" : `${p.toFixed(2)}%`);

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg bg-brand-soft ring-1 ring-brand-border/60 px-3 py-2.5">
      {children}
    </div>
  );
}

function Seg({ width, className }: { width: string; className: string }) {
  return <div className={`h-full transition-[width] duration-300 ${className}`}
              style={{ width }} />;
}

function Dot({ className }: { className: string }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${className}`} />;
}
