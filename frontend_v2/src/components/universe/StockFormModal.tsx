// -----------------------------------------------------------------------------
// Add a stock to a pool / edit a stock's universe fields. One form for both:
// when `initial` is set the symbol is fixed and only the fields change.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import {
  CAP_TYPES, SECTOR_GROUPS, plainSymbol,
  type CapType, type SectorGroup, type StockDraft, type UniverseStock,
} from "../../lib/universeApi";
import { Field, GhostBtn, Modal, PrimaryBtn, Segmented, TextInput } from "../journal/ui";
import { CAP_STYLES } from "../journal/ui";

export const GROUP_STYLES: Record<SectorGroup, string> = {
  Banks: "bg-indigo-50 text-indigo-800 ring-indigo-200",
  NBFC: "bg-fuchsia-50 text-fuchsia-800 ring-fuchsia-200",
  Normal: "bg-stone-100 text-stone-700 ring-stone-200",
};

export const GROUP_HELP: Record<SectorGroup, string> = {
  Banks: "Banks & NBFC criteria: ROE and Net profit",
  NBFC: "Banks & NBFC criteria: ROE and Net profit",
  Normal: "Non-banking criteria: Net Debt/Equity, ROCE and Net profit",
};

export default function StockFormModal({ pool, initial, existing, onSave, onClose, busy }: {
  /** Pool the stock is being added to (ignored when editing). */
  pool: string;
  /** Editing this stock (symbol fixed) — null when adding. */
  initial: UniverseStock | null;
  /** Every known stock, to warn about duplicates while typing. */
  existing: UniverseStock[];
  onSave: (symbol: string, draft: StockDraft) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [f, setF] = useState({
    symbol: initial ? plainSymbol(initial.symbol) : "",
    name: initial?.name ?? "",
    sector: initial?.sector ?? "",
    cap: (initial?.cap_type_manual ?? "") as CapType | "",
    group: (initial?.sector_group ?? "") as SectorGroup | "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const key = f.symbol.trim().toUpperCase().replace(/\.(NS|BO)$/i, "");
  const dupe = useMemo(() => !initial && key
    ? existing.find((s) => plainSymbol(s.symbol) === key) ?? null : null, [existing, key, initial]);
  const badSymbol = key !== "" && !/^[A-Z0-9&-]{1,20}$/.test(key);
  const problem = !key ? "Symbol is required" : badSymbol ? "Symbol may only contain A-Z, 0-9, & and -" : null;

  const save = () => onSave(f.symbol.trim(), {
    name: f.name.trim() || null,
    sector: f.sector.trim() || null,
    cap_type_manual: f.cap || null,
    sector_group: f.group || null,
  });

  return (
    <Modal title={initial ? `Edit ${plainSymbol(initial.symbol)}` : `Add to ${pool}`} onClose={onClose}>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Symbol *">
          <TextInput value={f.symbol} onChange={set("symbol")} placeholder="RELIANCE"
                     autoFocus={!initial} disabled={Boolean(initial)}
                     style={{ textTransform: "uppercase" }} />
          {dupe && (
            <p className="mt-1 text-[11px] text-amber-700">
              Already in the universe ({(dupe.pools ?? []).join(", ") || "no pool"}
              {dupe.active ? "" : ", retired"}) — saving adds it to {pool} and keeps its other pools.
            </p>
          )}
        </Field>
        <Field label="Name">
          <TextInput value={f.name} onChange={set("name")} placeholder="Company name (optional)" />
        </Field>
        <Field label="Sector" span2>
          <TextInput value={f.sector} onChange={set("sector")} placeholder="e.g. AUTO, FMCG, BANKS" />
        </Field>
        <Field label="Cap type (manual)" span2>
          <Segmented ariaLabel="Cap type"
            options={[
              { value: "" as const, label: "Auto", title: "Use the bucket derived from market cap" },
              ...CAP_TYPES.map((c) => ({
                value: c, label: c, activeCls: `${CAP_STYLES[c]} ring-1`,
              })),
            ]}
            value={f.cap} onChange={(v) => setF((p) => ({ ...p, cap: v }))} />
        </Field>
        <Field label="Criteria group — the sector key for S200 screening" span2>
          <Segmented ariaLabel="Sector group"
            options={[
              { value: "" as const, label: "Not set" },
              ...SECTOR_GROUPS.map((g) => ({
                value: g, label: g, activeCls: `${GROUP_STYLES[g]} ring-1`, title: GROUP_HELP[g],
              })),
            ]}
            value={f.group} onChange={(v) => setF((p) => ({ ...p, group: v }))} />
          <p className="mt-1 text-[11px] text-brand-mute">
            Banks &amp; NBFC are screened on ROE and Net profit; everything else on Net Debt/Equity,
            ROCE and Net profit. This is what makes the sector rule strict.
          </p>
        </Field>
      </div>
      <div className="mt-5 flex items-center justify-end gap-3">
        {problem && key && <span className="text-[11px] text-rose-600 mr-auto">{problem}</span>}
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn disabled={busy || problem !== null} onClick={save}>
          {busy ? "Saving…" : initial ? "Save" : `Add to ${pool}`}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}
