// -----------------------------------------------------------------------------
// Notes — one flat list for everything that used to live in a separate to-do
// app: tasks, targets / limits, watch ideas, free notes and Plutus changes.
//
// `kind` is the only structure (no groups, tags or sub-tasks). Each item can
// carry a market tag (IN / US), a symbol, a due date and a pin. Two views of
// the same list: List (Pinned → Open → Done) and Board (one column per kind).
// Nothing is priced — a target is text you read, not an alert.
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotebookDraft, NotebookItem, NotebookKind, NotebookMarket } from "../lib/journalApi";
import { journalApi } from "../lib/journalApi";
import type { KindFilter, MarketFilter } from "../lib/notebook";
import {
  KINDS, columnItems, dueState, filterItems, kindMeta, openCounts, sectionItems,
} from "../lib/notebook";
import { localToday } from "../lib/ipo";
import { stockPath } from "../lib/journal";
import { fmtDate } from "../lib/money";
import LoadError from "../components/LoadError";
import { OwnerOnly, useCanEdit } from "../components/AuthGate";
import {
  ConfirmDialog, Field, GhostBtn, Modal, PrimaryBtn, RowBtn, Segmented, TextArea, TextInput,
} from "../components/journal/ui";

const QUERY_KEY = ["journal", "notebook"];
const VIEW_KEY = "plutus.notes.view";
type View = "list" | "board";
type MarketChoice = NotebookMarket | "";

function initialView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}

const KIND_OPTIONS = KINDS.map((k) => ({
  value: k.kind,
  label: <span>{k.icon} {k.label}</span>,
  activeCls: `${k.chip} ring-2`,
}));

const MARKET_OPTIONS: { value: MarketChoice; label: string; title: string }[] = [
  { value: "", label: "—", title: "No market" },
  { value: "IN", label: "IN", title: "India" },
  { value: "US", label: "US", title: "United States" },
];

// ---- Small display pieces ------------------------------------------------------

function KindChip({ kind }: { kind: NotebookKind }) {
  const m = kindMeta(kind);
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold
                      ring-1 whitespace-nowrap ${m.chip}`}>{m.label}</span>
  );
}

function MarketChip({ market }: { market: NotebookMarket | null }) {
  if (!market) return null;
  return (
    <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold
                     bg-brand-soft text-brand-mute ring-1 ring-brand-border">{market}</span>
  );
}

function DueChip({ item, today }: { item: NotebookItem; today: string }) {
  if (!item.due_date) return null;
  const state = dueState(item, today);
  const cls = state === "overdue" ? "bg-rose-50 text-rose-800 ring-rose-200"
    : state === "today" || state === "soon" ? "bg-amber-50 text-amber-800 ring-amber-200"
    : "bg-brand-soft text-brand-mute ring-brand-border";
  const prefix = state === "overdue" ? "Overdue · " : state === "today" ? "Today · " : "";
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold
                      ring-1 whitespace-nowrap tabular-nums ${cls}`}>
      📅 {prefix}{fmtDate(item.due_date)}
    </span>
  );
}

/** Symbol in front of the title — a link to the stock page for IN symbols. */
function SymbolTag({ item }: { item: NotebookItem }) {
  if (!item.symbol) return null;
  if (item.market === "IN") {
    return (
      <Link to={stockPath(item.symbol)} onClick={(e) => e.stopPropagation()}
            title={`Open ${item.symbol} — stock view`}
            className="font-semibold text-brand-accent hover:underline underline-offset-2">
        {item.symbol}
      </Link>
    );
  }
  return <span className="font-semibold text-brand-text">{item.symbol}</span>;
}

function DoneBox({ item, onToggle }: { item: NotebookItem; onToggle: () => void }) {
  const canEdit = useCanEdit();
  if (!kindMeta(item.kind).checkable) return <span className="w-[18px] shrink-0" aria-hidden />;
  return (
    <button type="button" role="checkbox" aria-checked={item.done} disabled={!canEdit}
            aria-label={item.done ? "Mark as not done" : "Mark as done"}
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className={`w-[18px] h-[18px] shrink-0 mt-0.5 grid place-items-center rounded
                        ring-1 text-[11px] font-bold transition-colors
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/50
                        disabled:cursor-default ${item.done
                          ? "bg-teal-700 ring-teal-700 text-white"
                          : "bg-white ring-brand-border enabled:hover:ring-teal-600"}`}>
      {item.done ? "✓" : ""}
    </button>
  );
}

interface ItemActions {
  today: string;
  onToggle: (i: NotebookItem) => void;
  onPin: (i: NotebookItem) => void;
  onEdit: (i: NotebookItem) => void;
  onDelete: (i: NotebookItem) => void;
}

function ItemText({ item, clamp }: { item: NotebookItem; clamp: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className={`text-sm leading-snug break-words ${
        item.done ? "line-through text-brand-mute" : "text-brand-text"}`}>
        <SymbolTag item={item} />
        {item.symbol && <span className="text-brand-mute"> · </span>}
        {item.title}
      </div>
      {item.body && (
        <p className={`mt-0.5 text-xs text-brand-mute leading-relaxed whitespace-pre-line
                       break-words ${clamp}`}>{item.body}</p>
      )}
    </div>
  );
}

function ItemButtons({ item, a }: { item: NotebookItem; a: ItemActions }) {
  return (
    <span className="inline-flex gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
      <RowBtn title={item.pinned ? "Unpin" : "Pin to top"} onClick={() => a.onPin(item)}>
        <span className={item.pinned ? "" : "grayscale opacity-50"}>📌</span>
      </RowBtn>
      <RowBtn title="Edit" onClick={() => a.onEdit(item)}>✎</RowBtn>
      <RowBtn title="Delete" danger onClick={() => a.onDelete(item)}>🗑</RowBtn>
    </span>
  );
}

// ---- List view -------------------------------------------------------------------

function ListRow({ item, a }: { item: NotebookItem; a: ItemActions }) {
  const canEdit = useCanEdit();
  return (
    <li onClick={canEdit ? () => a.onEdit(item) : undefined}
        className={`flex items-start gap-2.5 px-3.5 py-2.5 border-t border-brand-border
                    first:border-t-0 hover:bg-brand-soft/70 transition-colors
                    ${canEdit ? "cursor-pointer" : ""}`}>
      <DoneBox item={item} onToggle={() => a.onToggle(item)} />
      <ItemText item={item} clamp="line-clamp-2" />
      <div className="flex flex-wrap justify-end items-center gap-1.5 shrink-0 max-w-[45%]">
        <DueChip item={item} today={a.today} />
        <MarketChip market={item.market} />
        <KindChip kind={item.kind} />
        <ItemButtons item={item} a={a} />
      </div>
    </li>
  );
}

function ListSection({ title, items, a }: {
  title: string; items: NotebookItem[]; a: ItemActions;
}) {
  if (!items.length) return null;
  return (
    <section className="mb-4">
      <h2 className="px-1 mb-1.5 text-[10px] font-bold uppercase tracking-wider text-brand-mute">
        {title} <span className="tabular-nums">· {items.length}</span>
      </h2>
      <ul className="rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card overflow-hidden">
        {items.map((i) => <ListRow key={i.id} item={i} a={a} />)}
      </ul>
    </section>
  );
}

// ---- Board view ------------------------------------------------------------------

function BoardCard({ item, a }: { item: NotebookItem; a: ItemActions }) {
  const canEdit = useCanEdit();
  return (
    <li onClick={canEdit ? () => a.onEdit(item) : undefined}
        className={`rounded-xl bg-brand-panel ring-1 ring-brand-border shadow-card px-3 py-2.5
                    hover:shadow-pop transition-shadow ${canEdit ? "cursor-pointer" : ""}
                    ${item.done ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-2">
        {kindMeta(item.kind).checkable && (
          <DoneBox item={item} onToggle={() => a.onToggle(item)} />
        )}
        <ItemText item={item} clamp="line-clamp-4" />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-1.5">
          <DueChip item={item} today={a.today} />
          <MarketChip market={item.market} />
        </span>
        <ItemButtons item={item} a={a} />
      </div>
    </li>
  );
}

function Board({ items, kinds, showDone, a }: {
  items: NotebookItem[]; kinds: NotebookKind[]; showDone: boolean; a: ItemActions;
}) {
  return (
    <div className="overflow-x-auto no-scrollbar -mx-1 px-1 pb-2">
      <div className="grid gap-3 grid-flow-col auto-cols-[minmax(230px,1fr)]">
        {kinds.map((kind) => {
          const m = kindMeta(kind);
          const live = columnItems(items, kind);
          const done = showDone ? items.filter((i) => i.kind === kind && i.done) : [];
          return (
            <section key={kind}
                     className="rounded-2xl bg-brand-soft ring-1 ring-brand-border overflow-hidden
                                min-h-[160px]">
              <div className={`h-1 ${m.bar}`} />
              <h2 className="px-3 pt-2.5 pb-2 flex items-center gap-1.5 font-display
                             font-semibold text-sm">
                <span aria-hidden>{m.icon}</span>{m.plural}
                <span className="ml-auto min-w-[20px] px-1.5 py-0.5 rounded-full text-[10px]
                                 font-bold tabular-nums text-center bg-brand-panel text-brand-mute
                                 ring-1 ring-brand-border">{live.length}</span>
              </h2>
              <ul className="px-2 pb-2 space-y-2">
                {[...live, ...done].map((i) => <BoardCard key={i.id} item={i} a={a} />)}
                {!live.length && !done.length && (
                  <li className="px-2 py-6 text-center text-xs text-brand-mute">Nothing here</li>
                )}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ---- Add / edit modal --------------------------------------------------------------

interface FormState {
  kind: NotebookKind; title: string; body: string; market: MarketChoice;
  symbol: string; due_date: string; pinned: boolean;
}

function ItemModal({ initial, seed, busy, onSave, onDelete, onClose }: {
  initial?: NotebookItem;
  seed: Partial<FormState>;
  busy: boolean;
  onSave: (draft: NotebookDraft) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<FormState>({
    kind: initial?.kind ?? seed.kind ?? "TASK",
    title: initial?.title ?? seed.title ?? "",
    body: initial?.body ?? "",
    market: initial ? initial.market ?? "" : seed.market ?? "",
    symbol: initial?.symbol ?? seed.symbol ?? "",
    due_date: initial?.due_date?.slice(0, 10) ?? "",
    pinned: initial?.pinned ?? false,
  });
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setF((p) => ({ ...p, [k]: v }));
  const valid = f.title.trim().length > 0;

  return (
    <Modal title={initial ? "Edit item" : "New item"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || busy) return;
          onSave({
            kind: f.kind, title: f.title.trim(), body: f.body, market: f.market,
            symbol: f.symbol, due_date: f.due_date, pinned: f.pinned,
          });
        }}
        className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" span2>
          <Segmented ariaLabel="Type" options={KIND_OPTIONS} value={f.kind}
                     onChange={(v) => set("kind", v)} />
        </Field>
        <Field label="Title" span2>
          <TextInput autoFocus value={f.title} maxLength={200}
                     onChange={(e) => set("title", e.target.value)}
                     placeholder="Buy below 1,640 only if the weekly close holds" />
        </Field>
        <Field label="Details" span2>
          <TextArea rows={5} value={f.body} onChange={(e) => set("body", e.target.value)}
                    placeholder="Reason, levels, links — anything you want to remember" />
        </Field>
        <Field label="Market">
          <Segmented ariaLabel="Market" options={MARKET_OPTIONS} value={f.market}
                     onChange={(v) => set("market", v)} />
        </Field>
        <Field label="Symbol">
          <TextInput value={f.symbol} maxLength={20}
                     onChange={(e) => set("symbol", e.target.value.toUpperCase())}
                     placeholder={f.market === "US" ? "NVDA" : "HDFCBANK"} />
        </Field>
        <Field label="Due date">
          <TextInput type="date" value={f.due_date}
                     onChange={(e) => set("due_date", e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm self-end pb-1.5 cursor-pointer">
          <input type="checkbox" checked={f.pinned} className="accent-teal-700"
                 onChange={(e) => set("pinned", e.target.checked)} />
          📌 Pin to top
        </label>
        <div className="sm:col-span-2 mt-2 flex items-center justify-between gap-2">
          <span>
            {initial && onDelete && (
              <OwnerOnly>
                <button type="button" onClick={onDelete}
                        className="px-3 py-1.5 rounded-lg text-sm font-medium text-rose-600
                                   hover:bg-rose-50">
                  🗑 Delete
                </button>
              </OwnerOnly>
            )}
          </span>
          <span className="flex gap-2">
            <GhostBtn type="button" onClick={onClose}>Cancel</GhostBtn>
            <PrimaryBtn type="submit" disabled={!valid || busy}>
              {busy ? "Saving…" : initial ? "Save" : "Add"}
            </PrimaryBtn>
          </span>
        </div>
      </form>
    </Modal>
  );
}

// ---- Page ----------------------------------------------------------------------------

export default function NotesPage() {
  const qc = useQueryClient();
  const today = localToday();
  const q = useQuery({ queryKey: QUERY_KEY, queryFn: journalApi.notebook });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);

  const [view, setView] = useState<View>(initialView);
  const [kind, setKind] = useState<KindFilter>("ALL");
  const [market, setMarket] = useState<MarketFilter>("ALL");
  const [showDone, setShowDone] = useState(false);

  // Quick add
  const [quickTitle, setQuickTitle] = useState("");
  const [quickKind, setQuickKind] = useState<NotebookKind>("TASK");
  const [quickMarket, setQuickMarket] = useState<MarketChoice>("");
  const quickRef = useRef<HTMLInputElement>(null);

  const [modal, setModal] = useState<{ item?: NotebookItem; seed: Partial<FormState> } | null>(null);
  const [toDelete, setToDelete] = useState<NotebookItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* private window */ }
  }, [view]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(t);
  }, [notice]);

  const onErr = (e: unknown) =>
    setNotice(`⚠ ${(e instanceof Error ? e.message : String(e)).replace(/^\w+ \S+: /, "")}`);
  const refresh = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const mCreate = useMutation({
    mutationFn: (draft: NotebookDraft) => journalApi.createNotebookItem(draft),
    onSuccess: () => { void refresh(); setModal(null); setQuickTitle(""); quickRef.current?.focus(); },
    onError: onErr,
  });
  const mUpdate = useMutation({
    mutationFn: (p: { id: number; draft: NotebookDraft }) =>
      journalApi.updateNotebookItem(p.id, p.draft),
    // Ticking a box or pinning should feel instant — patch the cache first.
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: QUERY_KEY });
      const prev = qc.getQueryData<{ items: NotebookItem[]; count: number }>(QUERY_KEY);
      const { done, pinned } = p.draft;
      if (prev && (done !== undefined || pinned !== undefined)) {
        qc.setQueryData(QUERY_KEY, {
          ...prev,
          items: prev.items.map((i) => i.id === p.id
            ? { ...i, ...(done !== undefined ? { done } : {}),
                ...(pinned !== undefined ? { pinned } : {}) }
            : i),
        });
      }
      return { prev };
    },
    onError: (e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(QUERY_KEY, ctx.prev);
      onErr(e);
    },
    onSuccess: () => setModal(null),
    onSettled: () => { void refresh(); },
  });
  const mDelete = useMutation({
    mutationFn: (id: number) => journalApi.deleteNotebookItem(id),
    onSuccess: () => { void refresh(); setToDelete(null); setModal(null); setNotice("Deleted ✓"); },
    onError: onErr,
  });

  const counts = useMemo(() => openCounts(filterItems(items, "ALL", market)), [items, market]);
  const visible = useMemo(() => filterItems(items, kind, market), [items, kind, market]);
  const sections = useMemo(() => sectionItems(visible), [visible]);

  const actions: ItemActions = {
    today,
    onToggle: (i) => mUpdate.mutate({ id: i.id, draft: { done: !i.done } }),
    onPin: (i) => mUpdate.mutate({ id: i.id, draft: { pinned: !i.pinned } }),
    onEdit: (i) => setModal({ item: i, seed: {} }),
    onDelete: (i) => setToDelete(i),
  };

  const pickKind = (k: KindFilter) => {
    setKind(k);
    if (k !== "ALL") setQuickKind(k);
  };
  const pickMarket = (m: MarketFilter) => {
    setMarket(m);
    setQuickMarket(m === "ALL" ? "" : m);
  };
  const quickAdd = () => {
    const title = quickTitle.trim();
    if (!title || mCreate.isPending) return;
    mCreate.mutate({ kind: quickKind, title, market: quickMarket });
  };

  const kindFilterOptions: { value: KindFilter; label: React.ReactNode }[] = [
    { value: "ALL", label: <span>All <b className="tabular-nums">{counts.ALL}</b></span> },
    ...KINDS.map((k) => ({
      value: k.kind as KindFilter,
      label: <span>{k.icon} {k.plural} <b className="tabular-nums">{counts[k.kind]}</b></span>,
    })),
  ];

  return (
    <div>
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Notes</h1>
          <p className="text-sm text-brand-mute">
            Tasks, targets and limits, watch ideas and Plutus changes — one list.
          </p>
        </div>
        <div role="tablist" aria-label="View"
             className="inline-flex rounded-2xl ring-1 ring-brand-border bg-brand-panel
                        shadow-card p-1.5 gap-1">
          {([["list", "☰", "List"], ["board", "▦", "Board"]] as const).map(([v, icon, label]) => {
            const active = view === v;
            return (
              <button key={v} role="tab" aria-selected={active} onClick={() => setView(v)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold
                            transition-all duration-300 ${active
                  ? "bg-gradient-to-br from-teal-600 to-teal-800 text-white shadow-pop"
                  : "text-brand-mute hover:text-brand-text hover:bg-brand-soft"}`}>
                <span aria-hidden>{icon}</span>{label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Quick add — owner only */}
      <OwnerOnly>
        <div className="mb-4 rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card
                        p-3 flex flex-wrap items-center gap-2">
          <input
            ref={quickRef} value={quickTitle} maxLength={200}
            onChange={(e) => setQuickTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") quickAdd(); }}
            placeholder="Type and press Enter — a task, a target, a stock to watch…"
            aria-label="New item"
            className="flex-1 min-w-[220px] rounded-lg ring-1 ring-brand-border bg-white px-3 py-2
                       text-sm focus:outline-none focus:ring-2 focus:ring-teal-600/50
                       placeholder:text-brand-mute/60" />
          <Segmented ariaLabel="Type" options={KIND_OPTIONS} value={quickKind}
                     onChange={setQuickKind} />
          <Segmented ariaLabel="Market" options={MARKET_OPTIONS} value={quickMarket}
                     onChange={setQuickMarket} />
          <PrimaryBtn onClick={quickAdd} disabled={!quickTitle.trim() || mCreate.isPending}>
            Add
          </PrimaryBtn>
          <GhostBtn title="Add with details, symbol and due date"
                    onClick={() => setModal({
                      seed: { kind: quickKind, title: quickTitle, market: quickMarket },
                    })}>
            More…
          </GhostBtn>
        </div>
      </OwnerOnly>

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <Segmented ariaLabel="Filter by type" options={kindFilterOptions} value={kind}
                   onChange={pickKind} />
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<MarketFilter> ariaLabel="Filter by market" value={market}
            onChange={pickMarket}
            options={[{ value: "ALL", label: "All markets" },
                      { value: "IN", label: "IN" }, { value: "US", label: "US" }]} />
          <label className="flex items-center gap-1.5 text-xs font-semibold text-brand-mute
                            cursor-pointer select-none">
            <input type="checkbox" checked={showDone} className="accent-teal-700"
                   onChange={(e) => setShowDone(e.target.checked)} />
            Show done <span className="tabular-nums">({sections.done.length})</span>
          </label>
        </div>
      </div>

      {notice && (
        <div className="mb-3 px-3.5 py-2 rounded-xl bg-teal-50 ring-1 ring-teal-200
                        text-sm text-teal-900">{notice}</div>
      )}

      {q.isLoading ? <LoadError loading error={null} />
        : q.error ? <LoadError loading={false} error={q.error} />
        : !items.length ? (
          <div className="rounded-2xl bg-brand-panel ring-1 ring-brand-border shadow-card
                          p-10 text-center">
            <div className="text-3xl mb-2">🗒️</div>
            <p className="text-sm text-brand-mute">
              Start your list — type a task, a target or a stock to watch in the box above.
            </p>
          </div>
        ) : view === "board" ? (
          <Board items={visible} showDone={showDone} a={actions}
                 kinds={kind === "ALL" ? KINDS.map((k) => k.kind) : [kind]} />
        ) : (
          <>
            <ListSection title="📌 Pinned" items={sections.pinned} a={actions} />
            <ListSection title="Open" items={sections.open} a={actions} />
            {showDone && <ListSection title="Done" items={sections.done} a={actions} />}
            {!sections.pinned.length && !sections.open.length
              && !(showDone && sections.done.length) && (
              <div className="py-8 text-center text-brand-mute text-sm">
                Nothing open under this filter.
              </div>
            )}
          </>
        )}

      {modal && (
        <ItemModal
          initial={modal.item} seed={modal.seed}
          busy={mCreate.isPending || mUpdate.isPending}
          onClose={() => setModal(null)}
          onDelete={modal.item ? () => setToDelete(modal.item!) : undefined}
          onSave={(draft) => modal.item
            ? mUpdate.mutate({ id: modal.item.id, draft })
            : mCreate.mutate(draft)} />
      )}
      {toDelete && (
        <ConfirmDialog
          title="Delete item" danger confirmLabel="Delete" busy={mDelete.isPending}
          message={`Delete “${toDelete.title}”?\nThis cannot be undone.`}
          onConfirm={() => mDelete.mutate(toDelete.id)}
          onCancel={() => setToDelete(null)} />
      )}
    </div>
  );
}
