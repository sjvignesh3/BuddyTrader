// -----------------------------------------------------------------------------
// IPOs tab — every application (per account), its allotment, listing and
// sells, plus the track record: hit rate, listing gains, what was booked,
// days held, money locked, and whether holding beat selling at the open.
// Self-contained: owns its queries, mutations and modals.
// -----------------------------------------------------------------------------
import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { journalApi, type Ipo, type IpoDraft, type IpoSell, type IpoSellDraft } from "../../lib/journalApi";
import {
  accountsOf, deriveIpo, summarizeIpos, type IpoDerived, type IpoStage,
} from "../../lib/ipo";
import { num } from "../../lib/journal";
import { fmtDate, fmtMoney } from "../../lib/money";
import LoadError from "../LoadError";
import { FilterChip } from "./FilterBar";
import { IpoModal, IpoSellModal } from "./ipoModals";
import {
  ConfirmDialog, EmptyState, GhostBtn, Pnl, PrimaryBtn, RowActions, RowBtn, TableShell, Td, Th,
  useSort,
} from "./ui";

export const IPO_QUERY_KEY = ["journal", "ipos"] as const;

type Item = { ipo: Ipo; d: IpoDerived };
type StageFilter = "All" | "Pending" | "Holding" | "Sold" | "Not allotted";

const STAGE_STYLE: Record<IpoStage, string> = {
  Applied: "bg-amber-50 text-amber-800 ring-amber-300",
  "Not allotted": "bg-stone-100 text-stone-600 ring-stone-300",
  Allotted: "bg-sky-50 text-sky-800 ring-sky-300",
  Holding: "bg-violet-50 text-violet-800 ring-violet-300",
  "Partly sold": "bg-violet-50 text-violet-800 ring-violet-300",
  Sold: "bg-teal-50 text-teal-800 ring-teal-300",
};

const inStage = (f: StageFilter, s: IpoStage) =>
  f === "All" ? true
  : f === "Pending" ? s === "Applied"
  : f === "Holding" ? s === "Allotted" || s === "Holding" || s === "Partly sold"
  : f === "Sold" ? s === "Sold"
  : s === "Not allotted";

const ACCESSORS: Record<string, (x: Item) => unknown> = {
  stage: (x) => x.d.stage,
  account: (x) => x.ipo.account,
  name: (x) => x.ipo.ipo_name,
  applied: (x) => x.ipo.apply_date,
  issue: (x) => x.d.issue,
  blocked: (x) => x.d.blocked,
  allotted: (x) => x.d.allotted || null,
  invested: (x) => x.d.invested || null,
  listed: (x) => x.ipo.listing_date,
  listGain: (x) => x.d.listingGainPct,
  avgSell: (x) => x.d.avgSell,
  pnl: (x) => (x.d.allotted ? x.d.totalPnl : null),
  ret: (x) => x.d.returnPct,
  days: (x) => x.d.daysHeld,
  lock: (x) => x.d.lockDays,
  perDay: (x) => x.d.perDay,
};

export default function IpoTab() {
  const qc = useQueryClient();
  const ipoQ = useQuery({ queryKey: IPO_QUERY_KEY, queryFn: journalApi.ipos });
  const ipos = useMemo(() => ipoQ.data?.ipos ?? [], [ipoQ.data]);

  // Live price only for listed IPOs with shares still held.
  const heldSymbols = useMemo(() => [...new Set(ipos
    .filter((i) => i.status === "ALLOTTED" && i.symbol && i.listing_date
      && (i.shares_allotted ?? 0) > i.sells.reduce((n, s) => n + s.qty, 0))
    .map((i) => i.symbol!))].sort(), [ipos]);
  const quotesQ = useQuery({
    queryKey: ["journal", "ipo-quotes", heldSymbols.join(",")],
    queryFn: () => journalApi.ipoQuotes(heldSymbols),
    enabled: heldSymbols.length > 0,
    staleTime: 5 * 60_000,
  });

  const items: Item[] = useMemo(() => ipos.map((ipo) => {
    const q = ipo.symbol ? quotesQ.data?.quotes[ipo.symbol] : undefined;
    return { ipo, d: deriveIpo(ipo, num(q?.ltp)) };
  }), [ipos, quotesQ.data]);

  // ---- Filters ---------------------------------------------------------------------
  const accounts = useMemo(() => accountsOf(ipos), [ipos]);
  const [account, setAccount] = useState<string>("All");
  const [stage, setStage] = useState<StageFilter>("All");
  const [search, setSearch] = useState("");
  const byAccount = items.filter((x) => account === "All" || x.ipo.account === account);
  const q = search.trim().toLowerCase();
  const filtered = byAccount.filter((x) => inStage(stage, x.d.stage)
    && (!q || [x.ipo.ipo_name, x.ipo.symbol, x.ipo.notes].some((v) => v?.toLowerCase().includes(q))));
  // The track record follows the account + search, not the stage chip — so
  // "Sold" still shows the real hit rate.
  const summary = summarizeIpos(byAccount.filter((x) => !q
    || [x.ipo.ipo_name, x.ipo.symbol, x.ipo.notes].some((v) => v?.toLowerCase().includes(q))));
  const { sort, toggle, apply } = useSort<Item>(ACCESSORS);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const flip = (id: number) => setOpen((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  // ---- Mutations -------------------------------------------------------------------
  const [notice, setNotice] = useState<string | null>(null);
  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 4000);
  };
  const onErr = (e: unknown) =>
    flash(`⚠ ${(e instanceof Error ? e.message : String(e)).replace(/^\w+ \S+: /, "")}`);
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: IPO_QUERY_KEY }),
    qc.invalidateQueries({ queryKey: ["journal", "ipo-quotes"] }),
  ]);

  const [ipoModal, setIpoModal] = useState<{ initial: Ipo | null } | null>(null);
  const [sellModal, setSellModal] = useState<{ item: Item; sell: IpoSell | null } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; message: string; action: () => void } | null>(null);

  const mSaveIpo = useMutation({
    mutationFn: (p: { id?: number; draft: IpoDraft }) =>
      p.id ? journalApi.updateIpo(p.id, p.draft) : journalApi.createIpo(p.draft),
    onSuccess: (_r, p) => { void refresh(); setIpoModal(null); flash(p.id ? "IPO updated ✓" : "IPO added ✓"); },
    onError: onErr,
  });
  const mSaveSell = useMutation({
    mutationFn: (p: { ipoId: number; sellId?: number; draft: IpoSellDraft }) =>
      p.sellId ? journalApi.updateIpoSell(p.sellId, p.draft) : journalApi.addIpoSell(p.ipoId, p.draft),
    onSuccess: (_r, p) => {
      void refresh(); setSellModal(null);
      setOpen((s) => new Set(s).add(p.ipoId));
      flash(p.sellId ? "Sell updated ✓" : "Sell recorded ✓");
    },
    onError: onErr,
  });
  const mDelete = useMutation({
    mutationFn: (p: { kind: "ipo" | "sell"; id: number }): Promise<unknown> =>
      p.kind === "ipo" ? journalApi.deleteIpo(p.id) : journalApi.deleteIpoSell(p.id),
    onSuccess: () => { void refresh(); },
    onError: onErr,
  });
  const mFetch = useMutation({
    mutationFn: async (ipo: Ipo) => {
      const l = await journalApi.ipoListing(ipo.symbol!, ipo.apply_date);
      return journalApi.updateIpo(ipo.id, {
        listing_date: l.listing_date, listing_open: l.listing_open,
        listing_close: l.listing_close ?? ipo.listing_close,
      });
    },
    onSuccess: (r) => { void refresh(); flash(`Listing data saved for ${r.ipo.ipo_name} ✓`); },
    onError: onErr,
  });

  // ---- Render ----------------------------------------------------------------------
  if (ipoQ.isLoading) return <LoadError loading error={null} />;
  if (ipoQ.error) return <LoadError loading={false} error={ipoQ.error} />;

  const addBtn = <PrimaryBtn onClick={() => setIpoModal({ initial: null })}>+ IPO application</PrimaryBtn>;
  const stageCount = (f: StageFilter) => byAccount.filter((x) => inStage(f, x.d.stage)).length;

  return (
    <div className="space-y-3">
      {/* Filters + add */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Account">
          {["All", ...accounts].map((a) => (
            <FilterChip key={a} active={account === a} onClick={() => setAccount(a)}
                        count={a === "All" ? items.length : items.filter((x) => x.ipo.account === a).length}>
              {a === "All" ? "All accounts" : a}
            </FilterChip>
          ))}
        </div>
        <span className="w-px h-5 bg-brand-border mx-1 hidden sm:block" />
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Stage">
          {(["Pending", "Holding", "Sold", "Not allotted"] as StageFilter[]).map((s) => (
            <FilterChip key={s} active={stage === s} count={stageCount(s)}
                        onClick={() => setStage((p) => (p === s ? "All" : s))}>
              {s}
            </FilterChip>
          ))}
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder="Search IPO, symbol, notes…" aria-label="Search IPOs"
               className="ml-auto w-full sm:w-56 rounded-lg ring-1 ring-brand-border bg-white px-2.5
                          py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600/50" />
        {addBtn}
      </div>

      {notice && (
        <div className="px-3.5 py-2 rounded-xl bg-teal-50 ring-1 ring-teal-200 text-teal-900 text-sm">
          {notice}
        </div>
      )}

      {!ipos.length ? (
        <EmptyState text="No IPO applications yet — add one when you apply, then update it at allotment and listing."
                    action={addBtn} />
      ) : (
        <>
          <TrackRecord s={summary} />
          {quotesQ.data && Object.keys(quotesQ.data.errors).length > 0 && (
            <p className="text-xs text-amber-800 bg-amber-50 ring-1 ring-amber-200 rounded-lg px-3 py-1.5">
              No live price for {Object.keys(quotesQ.data.errors).join(", ")} — unrealised P&amp;L shows “—”.
            </p>
          )}
          {!filtered.length ? (
            <EmptyState text="No IPOs match the filters."
                        action={<GhostBtn onClick={() => { setAccount("All"); setStage("All"); setSearch(""); }}>
                          Clear filters</GhostBtn>} />
          ) : (
            <TableShell>
              <thead>
                <tr className="bg-brand-soft">
                  <Th sortKey="stage" sort={sort} onSort={toggle}>Stage</Th>
                  <Th sortKey="name" sort={sort} onSort={toggle}>IPO</Th>
                  <Th sortKey="account" sort={sort} onSort={toggle}>Account</Th>
                  <Th sortKey="applied" sort={sort} onSort={toggle}>Applied</Th>
                  <Th right sortKey="issue" sort={sort} onSort={toggle}>Issue ₹</Th>
                  <Th right sortKey="blocked" sort={sort} onSort={toggle}>Blocked ₹</Th>
                  <Th right sortKey="allotted" sort={sort} onSort={toggle}>Allotted</Th>
                  <Th right sortKey="invested" sort={sort} onSort={toggle}>Invested ₹</Th>
                  <Th sortKey="listed" sort={sort} onSort={toggle}>Listed</Th>
                  <Th right sortKey="listGain" sort={sort} onSort={toggle}>Listing gain</Th>
                  <Th right sortKey="avgSell" sort={sort} onSort={toggle}>Sold @ avg</Th>
                  <Th right sortKey="pnl" sort={sort} onSort={toggle}>P&amp;L ₹</Th>
                  <Th right sortKey="ret" sort={sort} onSort={toggle}>Return</Th>
                  <Th right sortKey="days" sort={sort} onSort={toggle}>Days held</Th>
                  <Th right sortKey="lock" sort={sort} onSort={toggle}>Money locked</Th>
                  <Th right sortKey="perDay" sort={sort} onSort={toggle}>₹ / day</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {apply(filtered).map((x) => {
                  const { ipo, d } = x;
                  const expanded = open.has(ipo.id);
                  const canFetch = ipo.status === "ALLOTTED" && ipo.symbol && !ipo.listing_open;
                  return (
                    <Fragment key={ipo.id}>
                      <tr onClick={() => flip(ipo.id)} aria-expanded={expanded}
                          className="border-t border-brand-border/60 hover:bg-brand-soft/60 cursor-pointer">
                        <Td>
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 ${STAGE_STYLE[d.stage]}`}>
                            {d.stage}
                          </span>
                        </Td>
                        <Td className="font-semibold">
                          <span className="text-brand-mute text-[10px] mr-1">{expanded ? "▾" : "▸"}</span>
                          {ipo.ipo_name}
                          {ipo.symbol && <span className="ml-1.5 text-[11px] font-normal text-brand-mute">{ipo.symbol}</span>}
                        </Td>
                        <Td>{ipo.account}</Td>
                        <Td>{fmtDate(ipo.apply_date)}</Td>
                        <Td right>{fmtMoney(ipo.issue_price)}</Td>
                        <Td right className="text-brand-mute">{fmtMoney(d.blocked, 0)}</Td>
                        <Td right>{d.allotted || "—"}</Td>
                        <Td right>{d.invested ? fmtMoney(d.invested, 0) : "—"}</Td>
                        <Td>
                          {canFetch ? (
                            <RowActions>
                              <button onClick={() => mFetch.mutate(ipo)} disabled={mFetch.isPending}
                                      title={`Fetch listing-day prices for ${ipo.symbol}`}
                                      className="px-2 py-0.5 rounded text-[11px] font-semibold ring-1 ring-teal-300
                                                 bg-teal-50 text-teal-800 hover:bg-teal-100 disabled:opacity-50">
                                {mFetch.isPending && mFetch.variables?.id === ipo.id ? "Fetching…" : "↻ Fetch"}
                              </button>
                            </RowActions>
                          ) : fmtDate(ipo.listing_date)}
                        </Td>
                        <Td right>
                          <Pnl value={d.listingGainPct} suffix="%" digits={1} />
                        </Td>
                        <Td right>
                          {d.avgSell !== null ? (
                            <span title={`${d.soldQty} of ${d.allotted} sold`}>
                              {fmtMoney(d.avgSell)}
                              {d.held > 0 && <span className="text-[10px] text-brand-mute"> ({d.soldQty})</span>}
                            </span>
                          ) : "—"}
                        </Td>
                        <Td right>
                          {d.allotted ? (
                            <span title={d.unrealised !== null
                              ? `Booked ₹${fmtMoney(d.realised, 0)} + unrealised ₹${fmtMoney(d.unrealised, 0)} @ LTP ₹${fmtMoney(d.ltp)}`
                              : undefined}>
                              <Pnl value={d.soldQty || d.unrealised !== null ? d.totalPnl : null} digits={0} />
                              {d.unrealised !== null && <span className="text-[10px] text-brand-mute">*</span>}
                            </span>
                          ) : <span className="text-brand-mute">—</span>}
                        </Td>
                        <Td right>
                          <Pnl value={d.soldQty || d.unrealised !== null ? d.returnPct : null} suffix="%" digits={1} />
                        </Td>
                        <Td right>{d.daysHeld ?? "—"}</Td>
                        <Td right className="text-brand-mute">{d.lockDays !== null ? `${d.lockDays}d` : "—"}</Td>
                        <Td right><Pnl value={d.perDay} digits={0} /></Td>
                        <Td>
                          <RowActions>
                            {d.held > 0 && (
                              <RowBtn title="Record a sell" onClick={() => setSellModal({ item: x, sell: null })}>💰</RowBtn>
                            )}
                            <RowBtn title="Edit" onClick={() => setIpoModal({ initial: ipo })}>✎</RowBtn>
                            <RowBtn title="Delete" danger onClick={() => setConfirm({
                              title: `Delete ${ipo.ipo_name}?`,
                              message: `This removes the ${ipo.account} application${ipo.sells.length
                                ? ` and its ${ipo.sells.length} sell${ipo.sells.length === 1 ? "" : "s"}` : ""} permanently.`,
                              action: () => mDelete.mutate({ kind: "ipo", id: ipo.id }),
                            })}>🗑</RowBtn>
                          </RowActions>
                        </Td>
                      </tr>
                      {expanded && (
                        <tr className="bg-brand-soft/40">
                          <td colSpan={17} className="px-4 py-3">
                            {/* Pinned left so it stays in view when the wide table is scrolled. */}
                            <div className="sticky left-4 w-fit max-w-[min(900px,calc(100vw-5rem))] overflow-x-auto">
                            <IpoDetail item={x}
                              onEditSell={(s) => setSellModal({ item: x, sell: s })}
                              onDeleteSell={(s) => setConfirm({
                                title: "Delete this sell?",
                                message: `${s.qty} shares sold on ${fmtDate(s.sell_date)} at ₹${fmtMoney(s.sell_price)} — removed permanently; the shares count as held again.`,
                                action: () => mDelete.mutate({ kind: "sell", id: s.id }),
                              })} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </TableShell>
          )}
          <p className="text-[11px] text-brand-mute">
            Gross figures — charges are not deducted. * includes unrealised P&amp;L at the latest price.
            Money locked runs from application to refund / final sell (or today).
          </p>
        </>
      )}

      {ipoModal && (
        <IpoModal initial={ipoModal.initial} accounts={accounts} busy={mSaveIpo.isPending}
                  onClose={() => setIpoModal(null)}
                  onSave={(draft) => mSaveIpo.mutate({ id: ipoModal.initial?.id, draft })} />
      )}
      {sellModal && (
        <IpoSellModal ipo={sellModal.item.ipo} d={sellModal.item.d} sell={sellModal.sell}
                      busy={mSaveSell.isPending} onClose={() => setSellModal(null)}
                      onSave={(draft) => mSaveSell.mutate({
                        ipoId: sellModal.item.ipo.id, sellId: sellModal.sell?.id, draft,
                      })} />
      )}
      {confirm && (
        <ConfirmDialog title={confirm.title} message={confirm.message} confirmLabel="Delete" danger
                       busy={mDelete.isPending} onCancel={() => setConfirm(null)}
                       onConfirm={() => { confirm.action(); setConfirm(null); }} />
      )}
    </div>
  );
}

// ---- Track record cards ------------------------------------------------------------

function Stat({ label, sub, children }: { label: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-4 py-2.5 rounded-xl bg-brand-panel ring-1 ring-brand-border shadow-card min-w-[130px]">
      <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">{label}</div>
      <div className="text-base font-display font-semibold mt-0.5 tabular-nums">{children}</div>
      {sub && <div className="text-[11px] text-brand-mute mt-0.5">{sub}</div>}
    </div>
  );
}

function TrackRecord({ s }: { s: ReturnType<typeof summarizeIpos> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <Stat label="Allotment hit rate"
            sub={`${s.allotted} allotted of ${s.decided} results${s.pending ? ` · ${s.pending} pending` : ""}`}>
        {s.hitRate !== null ? `${s.hitRate.toFixed(0)}%` : "—"}
      </Stat>
      <Stat label="Booked profit"
            sub={s.unrealised ? <>+ unrealised <Pnl value={s.unrealised} digits={0} /></> : `${s.wins} of ${s.soldCount} sold in profit`}>
        <Pnl value={s.realised} digits={0} />
      </Stat>
      <Stat label="Avg listing gain" sub="listing open vs issue price">
        <Pnl value={s.avgListingGainPct} suffix="%" digits={1} />
      </Stat>
      <Stat label="Avg booked return" sub={s.avgDaysHeld !== null ? `held ${s.avgDaysHeld.toFixed(1)} days on average` : "across fully sold IPOs"}>
        <Pnl value={s.avgSoldReturnPct} suffix="%" digits={1} />
      </Stat>
      <Stat label="Holding vs selling at open"
            sub={s.edgeVsListing === null ? "once an IPO is fully sold"
              : s.edgeVsListing >= 0 ? "holding earned more" : "selling at open would've earned more"}>
        <Pnl value={s.edgeVsListing} digits={0} />
      </Stat>
      <Stat label="Money in IPOs now"
            sub={`₹${fmtMoney(s.blockedNow, 0)} blocked · ₹${fmtMoney(s.investedNow, 0)} held`}>
        ₹{fmtMoney(s.blockedNow + s.investedNow, 0)}
      </Stat>
    </div>
  );
}

// ---- Expanded row ---------------------------------------------------------------------

function IpoDetail({ item, onEditSell, onDeleteSell }: {
  item: Item;
  onEditSell: (s: IpoSell) => void;
  onDeleteSell: (s: IpoSell) => void;
}) {
  const { ipo, d } = item;
  const facts: [string, React.ReactNode][] = [
    ["Lots", `${ipo.lots_applied} × ${ipo.lot_size} shares`],
    [ipo.status === "NOT_ALLOTTED" ? "Refunded" : "Allotment", fmtDate(ipo.allotment_date)],
    ["Listing open", ipo.listing_open ? <>₹{fmtMoney(ipo.listing_open)} (<Pnl value={d.listingGainPct} suffix="%" digits={1} />)</> : "—"],
    ["Listing close", ipo.listing_close ? <>₹{fmtMoney(ipo.listing_close)} (<Pnl value={d.listingCloseGainPct} suffix="%" digits={1} />)</> : "—"],
  ];
  if (d.listingOpenPnl !== null) {
    facts.push(["If sold all at open", <Pnl key="o" value={d.listingOpenPnl} digits={0} />]);
  }
  if (d.edgeVsListing !== null) {
    facts.push(["Holding vs open", <Pnl key="e" value={d.edgeVsListing} digits={0} />]);
  }
  if (d.held > 0 && d.ltp !== null) {
    facts.push([`${d.held} held @ LTP`, <>₹{fmtMoney(d.ltp)} (<Pnl value={d.unrealised} digits={0} />)</>]);
  }

  return (
    <div className="space-y-3 text-[13px]">
      <dl className="flex flex-wrap gap-x-6 gap-y-1.5">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">{k}</dt>
            <dd className="tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {ipo.sells.length > 0 ? (
        <table className="text-[13px] tabular-nums">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
              <th className="text-left pr-6 pb-1">Sold on</th>
              <th className="text-right pr-6 pb-1">Day</th>
              <th className="text-right pr-6 pb-1">Qty</th>
              <th className="text-right pr-6 pb-1">Price ₹</th>
              <th className="text-right pr-6 pb-1">P&amp;L ₹</th>
              <th className="text-right pr-6 pb-1">Return</th>
              <th className="text-left pr-6 pb-1">Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ipo.sells.map((s) => {
              const px = num(s.sell_price) ?? 0;
              const day = ipo.listing_date
                ? Math.round((Date.parse(`${s.sell_date}T00:00:00Z`) - Date.parse(`${ipo.listing_date}T00:00:00Z`)) / 86_400_000)
                : null;
              return (
                <tr key={s.id} className="border-t border-brand-border/50">
                  <td className="pr-6 py-1">{fmtDate(s.sell_date)}</td>
                  <td className="pr-6 py-1 text-right text-brand-mute"
                      title="Days after listing (0 = listing day)">{day === null ? "—" : day === 0 ? "listing" : `+${day}`}</td>
                  <td className="pr-6 py-1 text-right">{s.qty}</td>
                  <td className="pr-6 py-1 text-right">{fmtMoney(s.sell_price)}</td>
                  <td className="pr-6 py-1 text-right"><Pnl value={s.qty * (px - d.issue)} digits={0} /></td>
                  <td className="pr-6 py-1 text-right"><Pnl value={d.issue ? ((px - d.issue) / d.issue) * 100 : null} suffix="%" digits={1} /></td>
                  <td className="pr-6 py-1 text-brand-mute whitespace-normal max-w-[280px]">{s.notes ?? ""}</td>
                  <td className="py-1">
                    <RowActions>
                      <RowBtn title="Edit sell" onClick={() => onEditSell(s)}>✎</RowBtn>
                      <RowBtn title="Delete sell" danger onClick={() => onDeleteSell(s)}>🗑</RowBtn>
                    </RowActions>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="text-brand-mute text-xs">
          {ipo.status === "ALLOTTED" ? "No sells yet — use 💰 to record one (partial exits are fine)."
            : ipo.status === "APPLIED" ? "Awaiting allotment — edit ✎ once the result is out."
            : "Not allotted — counts towards your hit rate and money-locked days."}
        </p>
      )}
      {ipo.notes && <p className="text-xs text-brand-text/80 whitespace-pre-line">📝 {ipo.notes}</p>}
    </div>
  );
}
