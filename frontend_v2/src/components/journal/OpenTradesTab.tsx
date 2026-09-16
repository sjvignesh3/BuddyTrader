// -----------------------------------------------------------------------------
// Open trades tab — live positions with capital-based allocation markers.
// Every column header sorts; the filter bar narrows by text / cap / target
// proximity / averaging eligibility. Rows at or within 10% of target are
// tinted and badged. The latest leg of each position carries the ABCD
// "Next leg" signal: the trigger price for the next averaging leg, and — once
// CMP has fallen through it — an eligibility badge plus a 🪜 action that opens
// the trade form prefilled (target = this leg's entry). Advisory only.
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import type { Trade, TradeDraft } from "../../lib/journalApi";
import type { AbcdSignal, JournalCtx, OpenDerived } from "../../lib/journal";
import {
  abcdLegDraft, buildAbcdSignals, deriveOpenTrade, legLabel, num, targetZone,
} from "../../lib/journal";
import { fmtDate, fmtMoney, fmtPct } from "../../lib/money";
import FilterBar, { CapFilter, FilterChip } from "./FilterBar";
import {
  AllocMarker, CapChip, EmptyState, GhostBtn, Pnl, ROW_LINK_CLS, RowActions, RowBtn,
  StockLink, TableShell, Td, Th, useOpenStock, useSort,
} from "./ui";

/** `sig` is the POSITION's signal, carried on every lot of that symbol;
 * `isRef` marks the latest leg, which is the one the signal acts on. */
type Item = {
  t: Trade; d: OpenDerived; sig: AbcdSignal | null; leg: string | null; isRef: boolean;
};

export type OpenFocus = { kind: "near" | "avg"; n: number } | null;

const ACCESSORS: Record<string, (x: Item) => unknown> = {
  type: (x) => x.t.order_type,
  cap: (x) => x.d.cap,
  date: (x) => x.t.buy_date,
  symbol: (x) => x.t.symbol,
  buy: (x) => num(x.t.buy_price),
  qty: (x) => x.t.qty,
  strategy: (x) => x.t.strategy,
  target: (x) => num(x.t.target_price),
  buyValue: (x) => x.d.buyValue,
  alloc: (x) => x.d.allocPct,
  stockAlloc: (x) => x.d.symbolAllocPct,
  cmp: (x) => x.d.cmp,
  curValue: (x) => x.d.currentValue,
  gainAmt: (x) => x.d.gainAmt,
  gainPct: (x) => x.d.gainPct,
  day: (x) => x.d.dayPct,
  toTarget: (x) => x.d.remainingPct,
  // Closest-to-trigger first when ascending (less fall still needed). Every
  // lot of a position carries the same value, so its legs stay together.
  nextLeg: (x) => x.sig?.toTriggerPct ?? null,
  ath: (x) => x.d.athFallPct,
  days: (x) => x.d.days,
  annual: (x) => x.d.annualPct,
};

export default function OpenTradesTab({ rows, ctx, onEdit, onBook, onDelete, onAddLeg, focus }: {
  rows: Trade[];
  ctx: JournalCtx;
  onEdit: (t: Trade) => void;
  onBook: (t: Trade) => void;
  onDelete: (t: Trade) => void;
  /** Opens the trade form prefilled for the next ABCD leg. */
  onAddLeg?: (draft: TradeDraft) => void;
  /** Set by the insights cards to land on the tab with a chip switched on. */
  focus?: OpenFocus;
}) {
  const { sort, toggle, apply } = useSort<Item>(ACCESSORS);
  const openStock = useOpenStock();
  const [search, setSearch] = useState("");
  const [cap, setCap] = useState<CapFilter>("All");
  const [nearOnly, setNearOnly] = useState(false);
  const [avgOnly, setAvgOnly] = useState(false);

  useEffect(() => {
    if (!focus) return;
    setNearOnly(focus.kind === "near");
    setAvgOnly(focus.kind === "avg");
  }, [focus]);

  const signals = useMemo(() => buildAbcdSignals(rows, ctx), [rows, ctx]);

  // Leg letter per lot id — A is the oldest lot of the symbol.
  const legOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const sig of signals.values()) {
      sig.legs.forEach((l, i) => m.set(l.id, legLabel(i)));
    }
    return m;
  }, [signals]);

  const items = useMemo(
    () => rows.map((t) => {
      const sig = signals.get(t.symbol) ?? null;
      return {
        t, d: deriveOpenTrade(t, ctx), sig,
        leg: legOf.get(t.id) ?? null,
        isRef: sig?.ref.id === t.id,
      };
    }),
    [rows, ctx, signals, legOf]);

  const nearCount = useMemo(
    () => items.filter((x) => targetZone(x.d.remainingPct) !== null).length,
    [items]);
  const avgCount = useMemo(
    () => [...signals.values()].filter((s) => s.zone !== null).length,
    [signals]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(({ t, d }) => {
      if (cap !== "All" && d.cap !== cap) return false;
      if (nearOnly && targetZone(d.remainingPct) === null) return false;
      // Eligible positions show ALL their legs — the decision needs the whole ladder.
      if (avgOnly && !signals.get(t.symbol)?.zone) return false;
      if (q && ![t.symbol, t.strategy, t.comments, t.risk_notes, t.order_type]
        .some((f) => f && f.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, signals, search, cap, nearOnly, avgOnly]);

  if (!rows.length) {
    return <EmptyState text="No open trades — convert an opportunity or import your sheet." />;
  }
  const clearFilters = () => {
    setSearch(""); setCap("All"); setNearOnly(false); setAvgOnly(false);
  };
  const s = { sort, onSort: toggle };
  return (
    <div>
      <FilterBar search={search} onSearch={setSearch} cap={cap} onCap={setCap}
                 shown={filtered.length} total={items.length}>
        <FilterChip active={nearOnly} onClick={() => setNearOnly((v) => !v)}
                    activeCls="bg-amber-500 text-white ring-amber-500" count={nearCount}
                    title="Trades at or within 10% of their target">
          🎯 Near target
        </FilterChip>
        <FilterChip active={avgOnly} onClick={() => setAvgOnly((v) => !v)}
                    activeCls="bg-indigo-600 text-white ring-indigo-600" count={avgCount}
                    title="Positions whose next ABCD leg has triggered — CMP is 10% (Large/Mid) or 15% (Small/Micro) below the latest leg's entry">
          🪜 Averaging due
        </FilterChip>
      </FilterBar>
      {!filtered.length ? (
        <EmptyState text="No open trades match the filters."
                    action={<GhostBtn onClick={clearFilters}>Clear filters</GhostBtn>} />
      ) : (
        <TableShell>
          <thead>
            <tr className="bg-brand-soft">
              <Th sortKey="type" {...s}>Type</Th>
              <Th sortKey="cap" {...s}>Cap</Th>
              <Th sortKey="date" {...s}>Buy date</Th>
              <Th sortKey="symbol" {...s}>Stock</Th>
              <Th right sortKey="buy" {...s}>Buy ₹</Th>
              <Th right sortKey="qty" {...s}>Qty</Th>
              <Th sortKey="strategy" {...s}>Strategy</Th>
              <Th right sortKey="target" {...s}>Target ₹</Th>
              <Th right sortKey="buyValue" {...s}>Buy value</Th>
              <Th right sortKey="alloc" {...s}>Alloc %</Th>
              <Th right sortKey="stockAlloc" {...s}>Stock %</Th>
              <Th right sortKey="cmp" {...s}>CMP</Th>
              <Th right sortKey="curValue" {...s}>Cur. value</Th>
              <Th right sortKey="gainAmt" {...s}>Gain ₹</Th>
              <Th right sortKey="gainPct" {...s}>Gain %</Th>
              <Th right sortKey="day" {...s}>Day %</Th>
              <Th right sortKey="toTarget" {...s}>To target</Th>
              <Th right sortKey="nextLeg" {...s}>Next leg</Th>
              <Th right sortKey="ath" {...s}>ATH ↓</Th>
              <Th right sortKey="days" {...s}>Days</Th>
              <Th right sortKey="annual" {...s}>Annual %</Th>
              <Th>Notes</Th><Th />
            </tr>
          </thead>
          <tbody>
            {apply(filtered).map(({ t, d, sig, leg, isRef }) => {
              const note = [t.comments, t.risk_notes].filter(Boolean).join(" · ");
              const zone = targetZone(d.remainingPct);
              // Only the leg that would actually be added carries the tint.
              const abcd = isRef ? sig : null;
              const rowCls = zone === "hit"
                ? "bg-teal-50/70 hover:bg-teal-50"
                : zone === "near"
                  ? "bg-amber-50/70 hover:bg-amber-50"
                  : abcd?.zone === "due"
                    ? "bg-indigo-50/70 hover:bg-indigo-50"
                    : abcd?.zone === "blocked"
                      ? "bg-rose-50/40 hover:bg-rose-50/70"
                      : "hover:bg-brand-soft/60";
              return (
                <tr key={t.id} className={`border-t border-brand-border/60 ${ROW_LINK_CLS} ${rowCls}`}
                    onClick={() => openStock(t.symbol, ctx.snaps.get(t.symbol))}>
                  <Td className="text-brand-mute">{t.order_type ?? "—"}</Td>
                  <Td><CapChip cap={d.cap} /></Td>
                  <Td>{fmtDate(t.buy_date)}</Td>
                  <Td className="font-semibold">
                    <span className="inline-flex items-center gap-1">
                      <StockLink symbol={t.symbol} snap={ctx.snaps.get(t.symbol)} />
                      {zone === "hit" && <span title="Target reached" aria-hidden>🎯</span>}
                      {abcd?.zone === "due" && (
                        <span title={`Averaging leg ${abcd.nextLeg} eligible`} aria-hidden>🪜</span>
                      )}
                    </span>
                  </Td>
                  <Td right>{fmtMoney(t.buy_price)}</Td>
                  <Td right>{t.qty}</Td>
                  <Td>{t.strategy ?? "—"}</Td>
                  <Td right>{fmtMoney(t.target_price)}</Td>
                  <Td right>{fmtMoney(d.buyValue, 0)}</Td>
                  <Td right className="text-brand-mute">{fmtPct(d.allocPct)}</Td>
                  <Td right>
                    <span className="inline-flex items-center gap-1.5">
                      {fmtPct(d.symbolAllocPct)}
                      <AllocMarker state={d.marker} cap={d.cap} totalPct={d.symbolAllocPct} />
                    </span>
                  </Td>
                  <Td right>{fmtMoney(d.cmp)}</Td>
                  <Td right>{fmtMoney(d.currentValue, 0)}</Td>
                  <Td right><Pnl value={d.gainAmt} digits={0} /></Td>
                  <Td right><Pnl value={d.gainPct} suffix="%" /></Td>
                  <Td right><Pnl value={d.dayPct} suffix="%" /></Td>
                  <Td right>
                    {zone ? (
                      <span title={zone === "hit"
                              ? `Target ₹${fmtMoney(t.target_price)} reached — consider booking`
                              : `Within 10% of target — ${fmtPct(d.remainingPct)} to go`}
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full
                                        text-[11px] font-semibold ring-1 ${
                              zone === "hit"
                                ? "bg-teal-600 text-white ring-teal-600"
                                : "bg-amber-100 text-amber-900 ring-amber-300"}`}>
                        {zone === "hit" ? "🎯 Hit" : `⚡ ${fmtPct(d.remainingPct)}`}
                      </span>
                    ) : (
                      <span className="text-teal-800">{fmtPct(d.remainingPct)}</span>
                    )}
                  </Td>
                  <Td right>
                    <NextLegCell sig={sig} leg={leg} isRef={isRef} legs={sig?.legs.length ?? 0} />
                  </Td>
                  <Td right className="text-brand-mute">{fmtPct(d.athFallPct)}</Td>
                  <Td right>{d.days ?? "—"}</Td>
                  <Td right><Pnl value={d.annualPct} suffix="%" digits={1} /></Td>
                  <Td className="max-w-[160px] truncate text-brand-mute">
                    <span title={note}>{note}</span>
                  </Td>
                  <Td>
                    <RowActions>
                      {abcd?.zone === "due" && onAddLeg && (
                        <RowBtn title={`Add averaging leg ${abcd.nextLeg} — form prefilled, target ₹${fmtMoney(abcd.targetPrice)}`}
                                onClick={() => onAddLeg(abcdLegDraft(abcd))}>🪜</RowBtn>
                      )}
                      <RowBtn title="Book (sell fully or partially)" onClick={() => onBook(t)}>💰</RowBtn>
                      <RowBtn title="Edit" onClick={() => onEdit(t)}>✎</RowBtn>
                      <RowBtn title="Delete" danger onClick={() => onDelete(t)}>🗑</RowBtn>
                    </RowActions>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}

/**
 * The position's next ABCD leg. The trigger and badge sit on the reference
 * (latest) lot — that is the leg the next one is measured against. Older legs
 * still show their own letter, so the ladder reads top to bottom and the
 * column never has an unexplained gap.
 */
function NextLegCell({ sig, leg, isRef, legs }: {
  sig: AbcdSignal | null; leg: string | null; isRef: boolean; legs: number;
}) {
  if (!sig) return <span className="text-brand-mute">—</span>;
  if (!isRef) {
    return (
      <span className="text-brand-mute/70"
            title={`Leg ${leg} of ${legs} in ${sig.symbol}. The next-leg trigger is measured from the latest leg (${sig.refLeg}), so it is shown on that row.`}>
        leg {leg}
      </span>
    );
  }
  if (sig.triggerPrice === null || sig.thresholdPct === null) {
    return <span className="text-brand-mute" title="No cap bucket — set one to get the ABCD trigger">—</span>;
  }
  const base = `Leg ${sig.nextLeg} triggers at ₹${fmtMoney(sig.triggerPrice)} — `
    + `${sig.thresholdPct}% below leg ${sig.refLeg} entry ₹${fmtMoney(sig.refEntry)} (${sig.cap} cap). `
    + `Target for leg ${sig.nextLeg}: ₹${fmtMoney(sig.targetPrice)} (leg ${sig.refLeg} entry).`;
  if (sig.zone === "due") {
    const room = sig.maxQty === null
      ? "Set capital to see the room under the cap limit."
      : `Room for ${sig.maxQty} share${sig.maxQty === 1 ? "" : "s"} under the ${sig.cap}-cap limit.`;
    return (
      <span title={`ELIGIBLE — CMP ₹${fmtMoney(sig.cmp)} is ${fmtPct(sig.fallPct)} below leg ${sig.refLeg}. ${base} ${room}`}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px]
                       font-semibold ring-1 bg-indigo-600 text-white ring-indigo-600">
        🪜 {sig.nextLeg} ≤ ₹{fmtMoney(sig.triggerPrice, 0)} → ₹{fmtMoney(sig.targetPrice, 0)}
      </span>
    );
  }
  if (sig.zone === "blocked") {
    return (
      <span title={`Price triggered (CMP ₹${fmtMoney(sig.cmp)} is ${fmtPct(sig.fallPct)} below leg ${sig.refLeg}) but ${sig.symbol} is already at its ${sig.cap}-cap limit — no room for leg ${sig.nextLeg}. ${base}`}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px]
                       font-semibold ring-1 bg-rose-100 text-rose-800 ring-rose-300">
        🪜 {sig.nextLeg} · no room
      </span>
    );
  }
  return (
    <span className="text-brand-mute"
          title={sig.toTriggerPct === null
            ? `${base} No market data yet for the distance to trigger.`
            : `${base} CMP is ${fmtPct(sig.toTriggerPct)} above the trigger.`}>
      {sig.nextLeg} @ ₹{fmtMoney(sig.triggerPrice, 0)}
    </span>
  );
}
