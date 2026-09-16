// -----------------------------------------------------------------------------
// Journal insights strip — the at-a-glance numbers above the tabs: capital
// deployment, unrealized/realized P&L, win rate, the near-target radar and
// the best open position. Everything derives live from the trades + capital.
// -----------------------------------------------------------------------------
import { ReactNode, useMemo } from "react";
import type { Trade } from "../../lib/journalApi";
import type { JournalCtx } from "../../lib/journal";
import {
  buildAbcdSignals, buildPortfolio, deriveClosedTrade, deriveOpenTrade, targetZone,
} from "../../lib/journal";
import { fmtMoney, fmtPct } from "../../lib/money";
import { Pnl } from "./ui";

export default function JournalInsights({ openTrades, closedTrades, ctx, onJumpToOpen }: {
  openTrades: Trade[]; closedTrades: Trade[]; ctx: JournalCtx;
  /** Clicking a radar card jumps to the Open Trades tab with that chip on. */
  onJumpToOpen: (focus: "near" | "avg") => void;
}) {
  const s = useMemo(() => {
    const { totals } = buildPortfolio(openTrades, ctx);
    const open = openTrades.map((t) => ({ t, d: deriveOpenTrade(t, ctx) }));
    const near = open.filter((x) => targetZone(x.d.remainingPct) === "near").length;
    const hit = open.filter((x) => targetZone(x.d.remainingPct) === "hit").length;
    const abcd = [...buildAbcdSignals(openTrades, ctx).values()];
    const avgDue = abcd.filter((x) => x.zone === "due");
    const avgBlocked = abcd.filter((x) => x.zone === "blocked").length;
    const best = open.reduce<{ symbol: string; gainPct: number } | null>(
      (acc, x) => x.d.gainPct !== null && (!acc || x.d.gainPct > acc.gainPct)
        ? { symbol: x.t.symbol, gainPct: x.d.gainPct } : acc,
      null);
    const closed = closedTrades.map(deriveClosedTrade);
    const realized = closed.reduce((sum, d) => sum + (d.gain ?? 0), 0);
    // Bookings happen at target, so win rate is meaningless — speed is the
    // interesting number: how long a trade takes to reach its target.
    const withDays = closed.filter((d) => d.days !== null);
    const avgDays = withDays.length
      ? withDays.reduce((sum, d) => sum + (d.days ?? 0), 0) / withDays.length : null;
    const withGainPct = closed.filter((d) => d.gainPct !== null);
    const avgGainPct = withGainPct.length
      ? withGainPct.reduce((sum, d) => sum + (d.gainPct ?? 0), 0) / withGainPct.length : null;
    return {
      totals,
      unrealizedPct: totals.invested ? (totals.pnl / totals.invested) * 100 : null,
      near, hit, best, realized, avgDays, avgGainPct,
      avgDue, avgBlocked,
      closedCount: closed.length,
    };
  }, [openTrades, closedTrades, ctx]);

  if (!openTrades.length && !closedTrades.length) return null;

  const radarCount = s.near + s.hit;
  const pnlTone = !openTrades.length ? undefined
    : s.totals.pnl >= 0
      ? "bg-gradient-to-br from-teal-50 to-brand-panel"
      : "bg-gradient-to-br from-rose-50 to-brand-panel";

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3 mb-4">
      <Card label="Capital deployed"
            sub={s.totals.deployedPct !== null
              ? `${fmtPct(s.totals.deployedPct)} of capital` : undefined}>
        ₹{fmtMoney(s.totals.invested, 0)}
        <div className="mt-1.5 h-1.5 rounded-full bg-brand-soft overflow-hidden">
          <div className="h-full rounded-full bg-teal-600 transition-[width] duration-500"
               style={{ width: `${Math.min(100, Math.max(0, s.totals.deployedPct ?? 0))}%` }} />
        </div>
      </Card>
      <Card label="Unrealized P&L" tone={pnlTone}
            sub={<Pnl value={s.unrealizedPct} suffix="%" />}>
        {openTrades.length ? <Pnl value={s.totals.pnl} digits={0} /> : "—"}
      </Card>
      <Card label="Realized P&L"
            sub={s.closedCount ? `${s.closedCount} booking${s.closedCount === 1 ? "" : "s"}` : "no bookings yet"}>
        {s.closedCount ? <Pnl value={s.realized} digits={0} /> : "—"}
      </Card>
      <Card label="Avg days to target"
            sub={s.avgGainPct !== null
              ? <><Pnl value={s.avgGainPct} suffix="%" digits={1} /> avg booking</>
              : "book a trade first"}>
        {s.avgDays !== null ? `${Math.round(s.avgDays)}d` : "—"}
      </Card>
      <Card label="Target radar" onClick={() => onJumpToOpen("near")}
            tone={radarCount ? "bg-gradient-to-br from-amber-50 to-brand-panel" : undefined}
            title="Open trades at or within 10% of target — click to review"
            sub={radarCount
              ? `${s.hit} hit · ${s.near} within 10%`
              : "nothing close yet"}>
        {radarCount ? <span>🎯 {radarCount}</span> : "0"}
      </Card>
      <Card label="Averaging radar" onClick={() => onJumpToOpen("avg")}
            tone={s.avgDue.length ? "bg-gradient-to-br from-indigo-50 to-brand-panel" : undefined}
            title="Positions whose next ABCD leg has triggered — 10% (Large/Mid) or 15% (Small/Micro) below the latest leg. Advisory: check fundamentals before adding."
            sub={s.avgDue.length
              ? s.avgDue.slice(0, 3).map((x) => `${x.symbol} ${x.nextLeg}`).join(" · ")
                + (s.avgDue.length > 3 ? ` +${s.avgDue.length - 3}` : "")
                + (s.avgBlocked ? ` · ${s.avgBlocked} no room` : "")
              : s.avgBlocked
                ? `${s.avgBlocked} triggered, no room under cap limit`
                : "no leg due"}>
        {s.avgDue.length ? <span>🪜 {s.avgDue.length}</span> : "0"}
      </Card>
      <Card label="Best open trade"
            sub={s.best ? <Pnl value={s.best.gainPct} suffix="%" /> : undefined}>
        {s.best ? s.best.symbol : "—"}
      </Card>
    </div>
  );
}

function Card({ label, tone, sub, onClick, title, children }: {
  label: string; tone?: string; sub?: ReactNode;
  onClick?: () => void; title?: string; children: ReactNode;
}) {
  const cls = `rounded-2xl ring-1 ring-brand-border shadow-card px-4 py-3 text-left
               ${tone ?? "bg-brand-panel"}
               ${onClick ? "hover:shadow-pop transition-shadow cursor-pointer" : ""}`;
  const body = (
    <>
      <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
        {label}
      </div>
      <div className="mt-1 text-lg font-display font-semibold tabular-nums leading-tight">
        {children}
      </div>
      {sub !== undefined && <div className="mt-0.5 text-[11px] text-brand-mute">{sub}</div>}
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} title={title} className={cls}>{body}</button>
    : <div title={title} className={cls}>{body}</div>;
}
