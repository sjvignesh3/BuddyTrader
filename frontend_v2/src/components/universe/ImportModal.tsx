// -----------------------------------------------------------------------------
// CSV import with consent: pick file → choose merge / replace → the API
// computes the diff WITHOUT writing (dry run) → the owner reads what will be
// added / updated / removed → confirm → apply. The same preview → confirm
// shape the S200 Screener sync will reuse.
// -----------------------------------------------------------------------------
import { useRef, useState } from "react";
import type { ImportDiff, ImportRow, ImportResult } from "../../lib/universeApi";
import { plainSymbol } from "../../lib/universeApi";
import { parseUniverseCsv, type ParsedImport } from "../../lib/universeCsv";
import { GhostBtn, Modal, PrimaryBtn, Segmented } from "../journal/ui";

type Mode = "merge" | "replace";

function SymbolList({ title, symbols, tone }: { title: string; symbols: string[]; tone: string }) {
  if (!symbols.length) return null;
  return (
    <div>
      <div className={`text-[11px] font-bold uppercase tracking-wide ${tone}`}>
        {title} · {symbols.length}
      </div>
      <div className="mt-1 flex flex-wrap gap-1 max-h-28 overflow-y-auto">
        {symbols.map((s) => (
          <span key={s} className="px-1.5 py-0.5 rounded bg-brand-soft ring-1 ring-brand-border
                                   text-[11px] font-mono">{plainSymbol(s)}</span>
        ))}
      </div>
    </div>
  );
}

export function DiffSummary({ diff, mode }: { diff: ImportDiff; mode: Mode }) {
  const nothing = !diff.added.length && !diff.updated.length && !diff.removed.length;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2 text-center">
        {[
          ["Add", diff.added.length, "text-teal-700"],
          ["Update", diff.updated.length, "text-sky-700"],
          ["Remove", diff.removed.length, diff.removed.length ? "text-rose-700" : "text-brand-mute"],
          ["Same", diff.unchanged, "text-brand-mute"],
        ].map(([l, v, cls]) => (
          <div key={String(l)} className="rounded-xl bg-brand-soft ring-1 ring-brand-border py-2">
            <div className={`text-lg font-bold font-mono ${cls}`}>{v}</div>
            <div className="text-[10px] uppercase tracking-wider text-brand-mute">{l}</div>
          </div>
        ))}
      </div>
      {nothing && (
        <p className="text-sm text-brand-mute">Nothing would change — the pool already matches this file.</p>
      )}
      <SymbolList title="Added to the pool" symbols={diff.added} tone="text-teal-700" />
      {diff.new_stocks.length > 0 && (
        <p className="text-[11px] text-brand-mute">
          {diff.new_stocks.length} of these are new to the universe — prices and fundamentals
          fill in on the next daily sync.
        </p>
      )}
      <SymbolList title="Fields updated" symbols={diff.updated} tone="text-sky-700" />
      <SymbolList title={mode === "replace" ? "Removed from the pool" : "Removed"}
                  symbols={diff.removed} tone="text-rose-700" />
      {diff.kept_for_journal && diff.kept_for_journal.length > 0 && (
        <p className="text-[11px] text-amber-800 bg-amber-50 ring-1 ring-amber-200 rounded-lg px-3 py-1.5">
          {diff.kept_for_journal.map(plainSymbol).join(", ")} leave the pool but stay active
          because the Trading Journal still holds them — their prices keep syncing.
        </p>
      )}
      {diff.rejected && diff.rejected.length > 0 && (
        <p className="text-[11px] text-rose-700">
          Skipped {diff.rejected.length} invalid row{diff.rejected.length === 1 ? "" : "s"}:{" "}
          {diff.rejected.slice(0, 8).map((r) => `"${r.symbol}"`).join(", ")}
          {diff.rejected.length > 8 ? " …" : ""}
        </p>
      )}
    </div>
  );
}

export default function ImportModal({ pool, onPreview, onApply, onClose, busy }: {
  pool: string;
  onPreview: (rows: ImportRow[], mode: Mode) => Promise<ImportResult>;
  onApply: (rows: ImportRow[], mode: Mode) => Promise<ImportResult>;
  onClose: (applied?: ImportResult) => void;
  busy: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<Mode>("merge");
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    setError(null); setPreview(null); setParsed(null);
    if (!file) return;
    try {
      const text = await file.text();
      setParsed(parseUniverseCsv(text, pool));
      setFileName(file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runPreview = async () => {
    if (!parsed) return;
    setError(null);
    try { setPreview(await onPreview(parsed.rows, mode)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const apply = async () => {
    if (!parsed) return;
    setError(null);
    try { onClose(await onApply(parsed.rows, mode)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const destructive = mode === "replace" && (preview?.diff.removed.length ?? 0) > 0;

  return (
    <Modal title={`Import into ${pool}`} onClose={() => onClose()} wide>
      <div className="space-y-4">
        {/* Step 1 — file */}
        <div className="rounded-xl ring-1 ring-brand-border bg-brand-soft/60 p-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-brand-mute mb-1.5">
            1 · CSV file
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <GhostBtn onClick={() => fileRef.current?.click()}>Choose file…</GhostBtn>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                   onChange={(e) => onFile(e.target.files?.[0])} />
            <span className="text-xs text-brand-mute">
              {parsed
                ? <><b className="text-brand-text">{fileName}</b> · {parsed.rows.length} rows
                    · columns: {parsed.columns.join(", ")}
                    {parsed.layout === "master-template" && " · master template (Short Form filter)"}
                    {parsed.skippedOtherPool > 0 && ` · ${parsed.skippedOtherPool} rows of other pools skipped`}
                  </>
                : "Header like Symbol, Sector, Cap, Group — or the master template, or a plain symbol list."}
            </span>
          </div>
        </div>

        {/* Step 2 — mode */}
        <div className="rounded-xl ring-1 ring-brand-border bg-brand-soft/60 p-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-brand-mute mb-1.5">
            2 · How to apply
          </div>
          <Segmented ariaLabel="Import mode" value={mode}
            onChange={(v) => { setMode(v); setPreview(null); }}
            options={[
              { value: "merge" as const, label: "Merge — add & update, keep the rest" },
              { value: "replace" as const, label: `Replace — ${pool} becomes exactly this file`,
                activeCls: "bg-rose-600 text-white ring-rose-600" },
            ]} />
          {mode === "replace" && (
            <p className="mt-1.5 text-[11px] text-rose-700">
              Members not in the file leave {pool}. Nothing is deleted: a stock with no pool left is
              retired, and one the Journal holds stays active.
            </p>
          )}
        </div>

        {/* Step 3 — preview */}
        <div className="rounded-xl ring-1 ring-brand-border bg-brand-soft/60 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-brand-mute">
              3 · Preview the change (nothing is written yet)
            </div>
            <GhostBtn onClick={runPreview} disabled={!parsed || busy}>
              {busy && !preview ? "Computing…" : preview ? "Recompute" : "Preview"}
            </GhostBtn>
          </div>
          {preview ? <DiffSummary diff={preview.diff} mode={mode} />
                   : <p className="text-xs text-brand-mute">Choose a file, then preview.</p>}
        </div>

        {error && (
          <p className="text-[12px] text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded-lg px-3 py-2">{error}</p>
        )}
      </div>

      <div className="mt-5 flex items-center justify-end gap-3">
        <GhostBtn onClick={() => onClose()}>Cancel</GhostBtn>
        <PrimaryBtn disabled={!preview || busy} onClick={apply}
                    className={destructive ? "!bg-rose-600 hover:!bg-rose-700" : ""}>
          {busy && preview ? "Applying…"
            : destructive ? `Apply — remove ${preview!.diff.removed.length}` : "Apply import"}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}
