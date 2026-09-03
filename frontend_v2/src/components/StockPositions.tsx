// -----------------------------------------------------------------------------
// "My positions" panel inside the expanded stock row (Market Analysis) —
// the Trading Journal's open lots and booked history for this one stock.
// -----------------------------------------------------------------------------
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { journalApi } from "../lib/journalApi";
import { deriveClosedTrade, num } from "../lib/journal";
import { fmtDate, fmtMoney, fmtPct } from "../lib/money";

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

export default function StockPositions({ symbol, cmp }: {
  symbol: string;
  /** current close from the snapshot row (may be null) */
  cmp: number | null;
}) {
  const plain = plainSymbol(symbol);
  const q = useQuery({
    queryKey: ["journal", "trades", "symbol", plain],
    queryFn: () => journalApi.tradesBySymbol(plain),
    staleTime: 30_000,
  });

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
  const trades = q.data?.trades ?? [];
  const open = trades.filter((t) => t.status === "OPEN");
  const closed = trades.filter((t) => t.status === "CLOSED");

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
        <Link to="/journal"
              className="ml-auto self-center text-[11px] font-semibold px-3 py-1.5 rounded-lg
                         bg-brand-soft ring-1 ring-brand-border text-brand-accent
                         hover:bg-teal-50 hover:ring-teal-300 transition-colors"
              onClick={(e) => e.stopPropagation()}>
          Open journal →
        </Link>
      </div>

      {/* Open lots */}
      {open.length > 0 && (
        <div className="rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-card overflow-x-auto">
          <div className="px-3 pt-2 text-[10px] font-bold uppercase tracking-wider text-brand-mute">
            Open lots ({open.length})
          </div>
          <table className="min-w-full">
            <thead><tr>
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
                return (
                  <tr key={t.id} className="border-t border-brand-border/60">
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
    </div>
  );
}
