// -----------------------------------------------------------------------------
// "My notes" — a dated research diary per stock. Each entry is a date + a
// free-form multi-line view; entries stack into a timeline sortable by entry
// date (newest first by default) with an Indian-FY quarter chip per note, so
// tracking across quarters / months / years reads at a glance.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StockNote, StockNoteDraft } from "../lib/journalApi";
import { journalApi } from "../lib/journalApi";
import { ConfirmDialog, RowBtn } from "./journal/ui";
import { OwnerOnly } from "./AuthGate";
import { fmtDate } from "../lib/money";

const today = () => new Date().toISOString().slice(0, 10);

/** "2026-06-15" → "Q1 FY27" (Indian fiscal year: Apr–Mar, named by end year). */
function fyQuarter(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const m = d.getMonth() + 1;
  const q = m >= 4 ? Math.ceil((m - 3) / 3) : 4;
  const fy = (m >= 4 ? d.getFullYear() + 1 : d.getFullYear()) % 100;
  return `Q${q} FY${fy}`;
}

/** Composer used for both "new note" and in-place edit. */
function NoteEditor({ initial, busy, onSave, onCancel }: {
  initial?: StockNote;
  busy: boolean;
  onSave: (draft: { note_date: string; content: string }) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(initial?.note_date ?? today());
  const [text, setText] = useState(initial?.content ?? "");
  return (
    <div className="rounded-xl ring-2 ring-brand-accent/40 bg-brand-panel shadow-card px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <label className="text-[10px] uppercase tracking-wider text-brand-mute">
          View as of
        </label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="bg-brand-soft ring-1 ring-brand-border rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-brand-accent/40 outline-none"
        />
        {fyQuarter(date) && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-800 ring-1 ring-indigo-200">
            {fyQuarter(date)}
          </span>
        )}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        rows={12}
        placeholder={"Your view on the stock today — thesis, quarterly results read, valuation, risks, triggers to watch…\n\nNo length limit; the box grows as you drag its corner."}
        className="w-full min-h-[220px] resize-y bg-brand-soft ring-1 ring-brand-border rounded-xl px-3 py-2.5 text-xs leading-relaxed focus:ring-2 focus:ring-brand-accent/40 outline-none placeholder:text-brand-mute"
      />
      <div className="flex justify-end gap-2 mt-2">
        <button onClick={onCancel}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-brand-soft ring-1 ring-brand-border text-brand-mute hover:text-brand-text">
          Cancel
        </button>
        <button
          disabled={busy || !text.trim() || !date}
          onClick={() => onSave({ note_date: date, content: text.trim() })}
          className="text-[11px] font-bold px-3.5 py-1.5 rounded-lg bg-brand-accent text-white shadow-card hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
          {busy ? "Saving…" : initial ? "Update note" : "Save note"}
        </button>
      </div>
    </div>
  );
}

export default function StockNotes({ symbol }: {
  /** plain NSE symbol (journal convention) */
  symbol: string;
}) {
  const qc = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<StockNote | null>(null);
  const [deleting, setDeleting] = useState<StockNote | null>(null);
  const [newestFirst, setNewestFirst] = useState(true);

  const notesQ = useQuery({
    queryKey: ["journal", "notes", symbol],
    queryFn: () => journalApi.notes(symbol),
    staleTime: 30_000,
    retry: 1,
  });

  const notes = useMemo(() => {
    const rows = [...(notesQ.data?.notes ?? [])];
    rows.sort((a, b) => (b.note_date.localeCompare(a.note_date)) || (b.id - a.id));
    return newestFirst ? rows : rows.reverse();
  }, [notesQ.data, newestFirst]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["journal", "notes", symbol] });

  const mSave = useMutation({
    mutationFn: (p: { id?: number; draft: StockNoteDraft }) =>
      p.id ? journalApi.updateNote(p.id, p.draft)
           : journalApi.createNote({ ...p.draft, symbol }),
    onSuccess: () => { refresh(); setComposing(false); setEditing(null); },
  });
  const mDelete = useMutation({
    mutationFn: (id: number) => journalApi.deleteNote(id),
    onSuccess: () => { refresh(); setDeleting(null); },
  });

  const err = mSave.error ?? mDelete.error;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">
          My notes
        </div>
        {notes.length > 0 && (
          <span className="text-[10px] text-brand-mute -mt-px">({notes.length})</span>
        )}
        {notes.length > 1 && (
          <button
            onClick={() => setNewestFirst((v) => !v)}
            title="Flip the timeline order"
            className="text-[10px] font-semibold px-2 py-1 rounded-md bg-brand-soft ring-1 ring-brand-border text-brand-mute hover:text-brand-text">
            {newestFirst ? "Newest first ↓" : "Oldest first ↑"}
          </button>
        )}
        {!composing && (
          <OwnerOnly>
            <button
              onClick={() => { setComposing(true); setEditing(null); }}
              className="ml-auto text-[11px] font-bold px-3 py-1.5 rounded-lg bg-brand-accent text-white shadow-card hover:opacity-90 transition-opacity">
              ✍️ New note
            </button>
          </OwnerOnly>
        )}
      </div>

      {err != null && (
        <div className="mb-2 text-[11px] text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded-lg px-3 py-1.5">
          ⚠ {err instanceof Error ? err.message : String(err)}
        </div>
      )}

      {composing && (
        <div className="mb-3">
          <NoteEditor
            busy={mSave.isPending}
            onSave={(draft) => mSave.mutate({ draft })}
            onCancel={() => setComposing(false)}
          />
        </div>
      )}

      {notesQ.isLoading ? (
        <div className="text-xs text-brand-mute py-4 text-center">Loading notes…</div>
      ) : notesQ.error ? (
        <div className="text-xs text-rose-600 py-4 text-center">
          Could not load notes — is the API running (and migration 014 applied)?
        </div>
      ) : notes.length === 0 && !composing ? (
        <div className="rounded-xl ring-1 ring-dashed ring-brand-border bg-brand-panel/60 px-4 py-5 text-center">
          <div className="text-xl mb-1">📝</div>
          <p className="text-xs text-brand-mute">
            No notes on {symbol} yet — jot your view after each quarter's
            results and build the story over time.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {notes.map((n) => editing?.id === n.id ? (
            <NoteEditor key={n.id}
                        initial={n}
                        busy={mSave.isPending}
                        onSave={(draft) => mSave.mutate({ id: n.id, draft })}
                        onCancel={() => setEditing(null)} />
          ) : (
            <div key={n.id}
                 className="rounded-xl ring-1 ring-brand-border bg-brand-panel shadow-card px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold">{fmtDate(n.note_date)}</span>
                {fyQuarter(n.note_date) && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-800 ring-1 ring-indigo-200">
                    {fyQuarter(n.note_date)}
                  </span>
                )}
                {n.updated_at && n.created_at && n.updated_at !== n.created_at && (
                  <span className="text-[9px] text-brand-mute">· edited</span>
                )}
                <span className="ml-auto inline-flex gap-0.5">
                  <RowBtn title="Edit" onClick={() => { setEditing(n); setComposing(false); }}>✎</RowBtn>
                  <RowBtn title="Delete" danger onClick={() => setDeleting(n)}>🗑</RowBtn>
                </span>
              </div>
              <div className="mt-2 text-xs leading-relaxed whitespace-pre-wrap break-words">
                {n.content}
              </div>
            </div>
          ))}
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete note — ${symbol}`}
          message={`Remove the ${fmtDate(deleting.note_date)} note? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          busy={mDelete.isPending}
          onConfirm={() => mDelete.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
