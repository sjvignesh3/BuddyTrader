// -----------------------------------------------------------------------------
// Paste a symbol list (TradingView export "NSE:APTUS," lines, or any comma /
// newline separated list). The API fills company name, sector, industry, cap
// bucket and criteria group for every symbol it does not already know
// (yfinance), shows the result as a preview, and only writes on Apply.
// -----------------------------------------------------------------------------
import { useState } from "react";
import type { PasteResult } from "../../lib/universeApi";
import { plainSymbol } from "../../lib/universeApi";
import { CAP_STYLES, GhostBtn, Modal, PrimaryBtn, Segmented, TableShell, Td, Th } from "../journal/ui";
import type { CapBucket } from "../../lib/journalApi";
import { DiffSummary } from "./ImportModal";
import { GroupChip } from "./UniverseTable";

type Mode = "merge" | "replace";

const KNOWN = { text: "known", cls: "text-brand-mute" };
const SOURCE_LABEL: Record<string, { text: string; cls: string }> = {
  existing: KNOWN,
  yfinance: { text: "fetched", cls: "text-teal-700" },
  failed: { text: "lookup failed", cls: "text-rose-700" },
};

export default function PasteModal({ pool, onPreview, onApply, onClose, busy }: {
  pool: string;
  onPreview: (text: string, refresh: boolean, mode: Mode) => Promise<PasteResult>;
  onApply: (text: string, refresh: boolean, mode: Mode) => Promise<PasteResult>;
  onClose: (applied?: PasteResult) => void;
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const [refresh, setRefresh] = useState(false);
  const [mode, setMode] = useState<Mode>("merge");
  const [preview, setPreview] = useState<PasteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tokens = text.split(/[,\s;]+/).filter(Boolean).length;

  const run = async (apply: boolean) => {
    setError(null);
    try {
      const r = await (apply ? onApply(text, refresh, mode) : onPreview(text, refresh, mode));
      if (apply) onClose(r); else setPreview(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const destructive = mode === "replace" && (preview?.diff.removed.length ?? 0) > 0;

  return (
    <Modal title={`Paste symbols into ${pool}`} onClose={() => onClose()} wide>
      <div className="space-y-4">
        <div className="rounded-xl ring-1 ring-brand-border bg-brand-soft/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-brand-mute">
              1 · Symbols — one per line or comma separated · NSE: / BSE: prefixes are fine
            </div>
            <span className="text-[11px] text-brand-mute">{tokens} token{tokens === 1 ? "" : "s"}</span>
          </div>
          <textarea value={text} rows={7} autoFocus
                    onChange={(e) => { setText(e.target.value); setPreview(null); }}
                    placeholder={"NSE:APTUS,\nNSE:CANFINHOME,\nNSE:CGCL,\nTCS, INFY"}
                    className="w-full rounded-lg ring-1 ring-brand-border bg-white px-2.5 py-1.5 text-sm font-mono
                               focus:outline-none focus:ring-2 focus:ring-teal-600/50 placeholder:text-brand-mute/50" />
          <label className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-brand-mute select-none">
            <input type="checkbox" checked={refresh}
                   onChange={(e) => { setRefresh(e.target.checked); setPreview(null); }} />
            re-fetch name / sector / cap / group even for stocks already in the universe
          </label>
        </div>

        <div className="rounded-xl ring-1 ring-brand-border bg-brand-soft/60 p-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-brand-mute mb-1.5">
            2 · How to apply
          </div>
          <Segmented ariaLabel="Paste mode" value={mode}
            onChange={(v) => { setMode(v); setPreview(null); }}
            options={[
              { value: "merge" as const, label: "Merge — add to the current list" },
              { value: "replace" as const, label: `Replace — ${pool} becomes exactly this list`,
                activeCls: "bg-rose-600 text-white ring-rose-600" },
            ]} />
          {mode === "replace" && (
            <p className="mt-1.5 text-[11px] text-rose-700">
              Every current member not in the pasted list leaves {pool}. Nothing is deleted: a
              stock with no pool left is retired, and one the Journal holds stays active.
            </p>
          )}
        </div>

        <div className="rounded-xl ring-1 ring-brand-border bg-brand-soft/60 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-brand-mute">
              3 · Preview — fields are fetched, nothing is written yet
            </div>
            <GhostBtn onClick={() => run(false)} disabled={!tokens || busy}>
              {busy && !preview ? "Fetching…" : preview ? "Recompute" : "Preview"}
            </GhostBtn>
          </div>
          {!preview && (
            <p className="text-xs text-brand-mute">
              Company name, sector, industry, cap bucket (from market cap) and the Banks / NBFC /
              Normal group are looked up for every symbol not yet in the universe. A few seconds
              per new symbol.
            </p>
          )}
          {preview && (
            <div className="space-y-3">
              <p className="text-[11px] text-brand-mute">
                {preview.row_count} symbol{preview.row_count === 1 ? "" : "s"} · {preview.fetched} fetched
                {preview.failed > 0 && <span className="text-rose-700"> · {preview.failed} lookup{preview.failed === 1 ? "" : "s"} failed (added without details)</span>}
              </p>
              <div className="max-h-64 overflow-auto rounded-xl ring-1 ring-brand-border bg-white">
                <TableShell>
                  <thead>
                    <tr className="bg-brand-soft">
                      <Th>Symbol</Th><Th>Name</Th><Th>Sector · Industry</Th><Th>Cap</Th><Th>Group</Th><Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.symbols.map((s) => {
                      const src = SOURCE_LABEL[s.source] ?? KNOWN;
                      return (
                        <tr key={s.symbol} className="border-t border-brand-border/60">
                          <Td className="font-semibold">{plainSymbol(s.symbol)}</Td>
                          <Td className="max-w-[220px] truncate">{s.name ?? <span className="text-brand-mute">—</span>}</Td>
                          <Td className="text-brand-mute">
                            {[s.sector, s.industry].filter(Boolean).join(" · ") || "—"}
                          </Td>
                          <Td>
                            {s.cap_type_manual
                              ? <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1
                                                  ${CAP_STYLES[s.cap_type_manual as CapBucket] ?? ""}`}>{s.cap_type_manual}</span>
                              : <span className="text-brand-mute">—</span>}
                          </Td>
                          <Td><GroupChip group={(s.sector_group ?? null) as "Banks" | "NBFC" | "Normal" | null} /></Td>
                          <Td>
                            <span className={`text-[10px] font-semibold ${src.cls}`} title={s.error ?? undefined}>
                              {s.in_pool ? `already in ${pool}` : s.known ? "in universe" : "new"} · {src.text}
                            </span>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableShell>
              </div>
              <DiffSummary diff={preview.diff} mode={mode} />
            </div>
          )}
        </div>

        {error && (
          <p className="text-[12px] text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded-lg px-3 py-2">{error}</p>
        )}
      </div>

      <div className="mt-5 flex items-center justify-end gap-3">
        <GhostBtn onClick={() => onClose()}>Cancel</GhostBtn>
        <PrimaryBtn disabled={!preview || busy} onClick={() => run(true)}
                    className={destructive ? "!bg-rose-600 hover:!bg-rose-700" : ""}>
          {busy && preview ? "Applying…"
            : destructive ? `Apply — add ${preview!.diff.added.length}, remove ${preview!.diff.removed.length}`
            : preview ? `Add ${preview.diff.added.length} to ${pool}` : `Add to ${pool}`}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}
