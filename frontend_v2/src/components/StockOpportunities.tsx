// -----------------------------------------------------------------------------
// "My opportunities" panel on the stock page — the Trading Journal's plans for
// THIS stock, as cards (mobile-friendly), with the same derived numbers the
// Opportunities tab computes (LTP, to-trigger, potential, allocation vs the
// cap-bucket limit). ➕ opens the journal's opportunity form prefilled from
// the live snapshot; convert/edit/delete reuse the journal's modals & API.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Snapshot } from "../lib/api";
import type {
  Opportunity, OpportunityDraft, TradeDraft,
} from "../lib/journalApi";
import { journalApi } from "../lib/journalApi";
import {
  buildOpenInvested, deriveOpportunity, normalizeCap, num,
  type JournalCtx, type OppDerived,
} from "../lib/journal";
import type { StockRow } from "../lib/rows";
import { ConvertModal, OpportunityModal } from "./journal/modals";
import { AllocMarker, CapChip, ConfirmDialog, Pnl, RowBtn } from "./journal/ui";
import { fmtDate, fmtMoney, fmtPct } from "../lib/money";

const STATUS_STYLE: Record<string, string> = {
  ACTIVE: "bg-teal-50 text-teal-800 ring-teal-300",
  CONVERTED: "bg-sky-50 text-sky-800 ring-sky-300",
  DROPPED: "bg-stone-100 text-stone-500 ring-stone-200",
};
const ACTION_STYLE: Record<string, string> = {
  "Buy Now": "bg-teal-700 text-white ring-teal-700",
  GTT: "bg-teal-50 text-teal-800 ring-teal-300",
  "Analyse Now": "bg-amber-50 text-amber-800 ring-amber-300",
  Later: "bg-stone-100 text-stone-500 ring-stone-200",
};

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-brand-mute">{label}</div>
      <div className="text-xs font-mono tabular-nums font-semibold mt-0.5">{children}</div>
    </div>
  );
}

function OppCard({ o, d, onEdit, onConvert, onDelete }: {
  o: Opportunity; d: OppDerived;
  onEdit: () => void; onConvert: () => void; onDelete: () => void;
}) {
  const active = o.status === "ACTIVE";
  return (
    <div className={`rounded-xl ring-1 bg-brand-panel shadow-card px-3.5 py-3 ${
      active ? "ring-teal-200" : "ring-brand-border opacity-90"}`}>
      {/* header — when · status · action · row buttons */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold">{fmtDate(o.opp_date)}</span>
        <span className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold ring-1 ${
          STATUS_STYLE[o.status] ?? STATUS_STYLE.DROPPED}`}>
          {o.status}
        </span>
        {o.action_filter && (
          <span className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-semibold ring-1 ${
            ACTION_STYLE[o.action_filter] ?? ""}`}>
            {o.action_filter}
          </span>
        )}
        <CapChip cap={d.cap} />
        {o.strategy && (
          <span className="text-[10px] text-brand-mute truncate max-w-[140px]">
            · {o.strategy}
          </span>
        )}
        <span className="ml-auto inline-flex gap-0.5">
          {active && (
            <RowBtn title="Take position (convert to open trade)" onClick={onConvert}>🛒</RowBtn>
          )}
          <RowBtn title="Edit" onClick={onEdit}>✎</RowBtn>
          <RowBtn title="Delete" danger onClick={onDelete}>🗑</RowBtn>
        </span>
      </div>

      {/* the plan */}
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-x-3 gap-y-2 mt-2.5 pt-2.5 border-t border-brand-border/60">
        <Cell label="Buy ₹">{fmtMoney(o.buy_price)}</Cell>
        <Cell label="Limit ₹">{fmtMoney(o.limit_price)}</Cell>
        <Cell label="Qty">{o.qty ?? "—"}</Cell>
        <Cell label="Target ₹">{fmtMoney(o.target_price)}</Cell>
        <Cell label="LTP">{fmtMoney(d.ltp)}</Cell>
        <Cell label="To trigger">
          <span className={d.toTrigPct !== null && d.toTrigPct <= 0
            ? "text-teal-700" : ""}>{fmtPct(d.toTrigPct)}</span>
        </Cell>
        <Cell label="Potential"><Pnl value={d.potentialPct} suffix="%" /></Cell>
        <Cell label="Gain ₹">{fmtMoney(d.potentialGain, 0)}</Cell>
      </div>

      {/* allocation + notes */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[10px] text-brand-mute">
        <span>
          Needs <b className="text-brand-text font-mono">₹{fmtMoney(d.capitalNeeded, 0)}</b>
          {d.additionPct !== null && <> · adds {fmtPct(d.additionPct)}</>}
          {d.totalPct !== null && (
            <>
              {" "}· total {fmtPct(d.totalPct)} of capital{" "}
              <AllocMarker state={d.marker} cap={d.cap} totalPct={d.totalPct} />
            </>
          )}
        </span>
        {o.notes && (
          <span className="basis-full text-brand-mute italic">📝 {o.notes}</span>
        )}
      </div>
    </div>
  );
}

export default function StockOpportunities({ symbol, row }: {
  /** plain NSE symbol (journal convention) */
  symbol: string;
  row: StockRow;
}) {
  const qc = useQueryClient();
  const [modal, setModal] = useState<"add" | Opportunity | null>(null);
  const [convertOpp, setConvertOpp] = useState<Opportunity | null>(null);
  const [deleteOpp, setDeleteOpp] = useState<Opportunity | null>(null);

  // All statuses — the stock page tells the full story, converted/dropped included.
  const oppsQ = useQuery({
    queryKey: ["journal", "opportunities", "all"],
    queryFn: () => journalApi.opportunities(),
    staleTime: 30_000,
    retry: 1,
  });
  const settingsQ = useQuery({
    queryKey: ["journal", "settings"],
    queryFn: journalApi.settings,
    staleTime: 60_000,
    retry: 1,
  });
  const tradesQ = useQuery({
    queryKey: ["journal", "trades", "symbol", symbol],
    queryFn: () => journalApi.tradesBySymbol(symbol),
    staleTime: 30_000,
    retry: 1,
  });

  const mine = useMemo(() => {
    const rank: Record<string, number> = { ACTIVE: 0, CONVERTED: 1, DROPPED: 2 };
    return (oppsQ.data?.opportunities ?? [])
      .filter((o) => o.symbol === symbol)
      .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3)
        || (b.opp_date ?? "").localeCompare(a.opp_date ?? ""));
  }, [oppsQ.data, symbol]);

  // Mini journal context — this stock's snapshot + its open lots only.
  const ctx: JournalCtx = useMemo(() => {
    const snaps = new Map<string, Snapshot>([[symbol, row.snapshot]]);
    const open = (tradesQ.data?.trades ?? []).filter((t) => t.status === "OPEN");
    return {
      capital: num(settingsQ.data?.settings.capital) ?? 0,
      snaps,
      openInvested: buildOpenInvested(open),
    };
  }, [symbol, row.snapshot, settingsQ.data, tradesQ.data]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["journal"] });

  const mSave = useMutation({
    mutationFn: (p: { id?: number; draft: OpportunityDraft }) =>
      p.id ? journalApi.updateOpportunity(p.id, p.draft)
           : journalApi.createOpportunity(p.draft),
    onSuccess: () => { refresh(); setModal(null); },
  });
  const mConvert = useMutation({
    mutationFn: (p: { id: number; overrides: TradeDraft }) =>
      journalApi.convertOpportunity(p.id, p.overrides),
    onSuccess: () => { refresh(); setConvertOpp(null); },
  });
  const mDelete = useMutation({
    mutationFn: (id: number) => journalApi.deleteOpportunity(id),
    onSuccess: () => { refresh(); setDeleteOpp(null); },
  });

  const err = mSave.error ?? mConvert.error ?? mDelete.error;

  // Prefill the add form straight from the live snapshot.
  const prefill: OpportunityDraft = {
    symbol,
    cap_bucket: normalizeCap(row.cap),
    buy_price: row.close !== null ? String(row.close) : null,
    action_filter: row.bestStatus === "BUY_ZONE" ? "Buy Now" : null,
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
          My opportunities
        </div>
        {mine.length > 0 && (
          <span className="text-[10px] text-brand-mute -mt-px">({mine.length})</span>
        )}
        <button
          onClick={() => setModal("add")}
          className="ml-auto text-[11px] font-bold px-3 py-1.5 rounded-lg bg-brand-accent text-white shadow-card hover:opacity-90 transition-opacity">
          ＋ Add opportunity
        </button>
      </div>

      {err != null && (
        <div className="mb-2 text-[11px] text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded-lg px-3 py-1.5">
          ⚠ {err instanceof Error ? err.message : String(err)}
        </div>
      )}

      {oppsQ.isLoading ? (
        <div className="text-xs text-brand-mute py-4 text-center">Loading journal…</div>
      ) : oppsQ.error ? (
        <div className="text-xs text-rose-600 py-4 text-center">
          Could not load the journal — is the API running?
        </div>
      ) : mine.length === 0 ? (
        <div className="rounded-xl ring-1 ring-dashed ring-brand-border bg-brand-panel/60 px-4 py-5 text-center">
          <div className="text-xl mb-1">🎯</div>
          <p className="text-xs text-brand-mute">
            No opportunity logged for {symbol} yet — spot a setup? Plan it here
            and it lands in the Journal's Opportunities tab.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {mine.map((o) => (
            <OppCard key={o.id} o={o} d={deriveOpportunity(o, ctx)}
                     onEdit={() => setModal(o)}
                     onConvert={() => setConvertOpp(o)}
                     onDelete={() => setDeleteOpp(o)} />
          ))}
        </div>
      )}

      {modal !== null && (
        <OpportunityModal
          initial={modal === "add" ? null : modal}
          prefill={modal === "add" ? prefill : undefined}
          ctx={ctx} busy={mSave.isPending}
          onClose={() => setModal(null)}
          onSave={(draft) => mSave.mutate(
            modal === "add" ? { draft } : { id: modal.id, draft })}
        />
      )}
      {convertOpp && (
        <ConvertModal
          opp={convertOpp}
          ctx={ctx} busy={mConvert.isPending}
          onClose={() => setConvertOpp(null)}
          onConvert={(overrides) => mConvert.mutate({ id: convertOpp.id, overrides })}
        />
      )}
      {deleteOpp && (
        <ConfirmDialog
          title={`Delete opportunity — ${deleteOpp.symbol}`}
          message={`Remove the ${fmtDate(deleteOpp.opp_date)} plan from the journal? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          busy={mDelete.isPending}
          onConfirm={() => mDelete.mutate(deleteOpp.id)}
          onCancel={() => setDeleteOpp(null)}
        />
      )}
    </div>
  );
}
