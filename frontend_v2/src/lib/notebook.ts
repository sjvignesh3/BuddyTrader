// -----------------------------------------------------------------------------
// Notes page — pure helpers (kind catalogue, filtering, ordering, due state).
//
// Nothing here is stored: the Pinned / Open / Done sections, the overdue
// flag and the counts all derive from the flat item list.
// -----------------------------------------------------------------------------
import type { NotebookItem, NotebookKind, NotebookMarket } from "./journalApi";
import { dayDiff } from "./ipo";

export interface KindMeta {
  kind: NotebookKind;
  /** Chip text on an item. */
  label: string;
  /** Filter / board-column heading. */
  plural: string;
  icon: string;
  /** Has a checkbox — the item can be ticked off. */
  checkable: boolean;
  /** Chip colours (same -50 / -800 / -200 recipe as the cap chips). */
  chip: string;
  /** Board column top bar. */
  bar: string;
}

export const KINDS: KindMeta[] = [
  { kind: "TASK", label: "Task", plural: "Tasks", icon: "✅", checkable: true,
    chip: "bg-teal-50 text-teal-800 ring-teal-200", bar: "bg-teal-600" },
  { kind: "TARGET", label: "Target", plural: "Targets & limits", icon: "🎯", checkable: false,
    chip: "bg-amber-50 text-amber-800 ring-amber-200", bar: "bg-amber-500" },
  { kind: "WATCH", label: "Watch", plural: "Watch", icon: "👀", checkable: false,
    chip: "bg-violet-50 text-violet-800 ring-violet-200", bar: "bg-violet-500" },
  { kind: "NOTE", label: "Note", plural: "Notes", icon: "📝", checkable: false,
    chip: "bg-sky-50 text-sky-800 ring-sky-200", bar: "bg-sky-500" },
  { kind: "PLUTUS", label: "Plutus", plural: "Plutus changes", icon: "🛠️", checkable: true,
    chip: "bg-indigo-50 text-indigo-800 ring-indigo-200", bar: "bg-indigo-500" },
];

const BY_KIND = Object.fromEntries(KINDS.map((k) => [k.kind, k])) as Record<NotebookKind, KindMeta>;

export function kindMeta(kind: NotebookKind): KindMeta {
  return BY_KIND[kind] ?? BY_KIND.NOTE;
}

export type KindFilter = NotebookKind | "ALL";
export type MarketFilter = NotebookMarket | "ALL";

/** Kind + market filter. A market filter hides untagged items too. */
export function filterItems(items: NotebookItem[], kind: KindFilter,
                            market: MarketFilter): NotebookItem[] {
  return items.filter((i) =>
    (kind === "ALL" || i.kind === kind) && (market === "ALL" || i.market === market));
}

export type DueState = "overdue" | "today" | "soon" | "later";

/** Due state of an open item; null when it has no due date or is done. */
export function dueState(item: Pick<NotebookItem, "due_date" | "done">,
                         today: string): DueState | null {
  if (!item.due_date || item.done) return null;
  const days = dayDiff(today, item.due_date);
  if (days === null) return null;
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  return days <= 3 ? "soon" : "later";
}

/** Dated items first (earliest due on top), then newest first. */
function byDueThenNewest(a: NotebookItem, b: NotebookItem): number {
  if (a.due_date && b.due_date && a.due_date !== b.due_date) {
    return a.due_date < b.due_date ? -1 : 1;
  }
  if (a.due_date && !b.due_date) return -1;
  if (!a.due_date && b.due_date) return 1;
  return b.id - a.id;
}

export interface Sections {
  pinned: NotebookItem[];
  open: NotebookItem[];
  done: NotebookItem[];
}

/** Pinned (not done) → Open → Done. A done item is never shown as pinned. */
export function sectionItems(items: NotebookItem[]): Sections {
  const live = items.filter((i) => !i.done).sort(byDueThenNewest);
  return {
    pinned: live.filter((i) => i.pinned),
    open: live.filter((i) => !i.pinned),
    done: items.filter((i) => i.done).sort((a, b) => b.id - a.id),
  };
}

/** Board column order: pinned on top, then due date, then newest. */
export function columnItems(items: NotebookItem[], kind: NotebookKind): NotebookItem[] {
  const s = sectionItems(items.filter((i) => i.kind === kind));
  return [...s.pinned, ...s.open];
}

/** Open (not done) count per kind, plus ALL — the numbers on the filter pills. */
export function openCounts(items: NotebookItem[]): Record<KindFilter, number> {
  const out = { ALL: 0, TASK: 0, TARGET: 0, WATCH: 0, NOTE: 0, PLUTUS: 0 } as Record<KindFilter, number>;
  for (const i of items) {
    if (i.done) continue;
    out.ALL += 1;
    out[i.kind] += 1;
  }
  return out;
}
