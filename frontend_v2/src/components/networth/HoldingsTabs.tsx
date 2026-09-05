// -----------------------------------------------------------------------------
// Assets & Liabilities tabs — the two manual ledgers behind the dashboard.
// Journal-table conventions: sortable headers, row buttons, archive instead of
// delete by default (history kept), delete behind a confirm.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { fmtDate, fmtMoney } from "../../lib/money";
import { assetGain, assetsByClass, liabilitiesByKind, num } from "../../lib/networth";
import type { Asset, Liability } from "../../lib/networthApi";
import {
  EmptyState, GhostBtn, Pnl, PrimaryBtn, RowBtn, TableShell, Td, Th, useSort,
} from "../journal/ui";
import { ClassChip, colorFor } from "./ui";

const ASSET_ACCESSORS: Record<string, (a: Asset) => unknown> = {
  name: (a) => a.name,
  cls: (a) => a.asset_class,
  institution: (a) => a.institution,
  value: (a) => num(a.current_value),
  cost: (a) => (a.cost_basis === null ? null : num(a.cost_basis)),
  gain: (a) => assetGain(a)?.gain ?? null,
  asOf: (a) => a.as_of_date,
};

export function AssetsTab({ assets, onAdd, onEdit, onUpdateValue, onArchive, onDelete }: {
  assets: Asset[];
  onAdd: () => void;
  onEdit: (a: Asset) => void;
  onUpdateValue: (a: Asset) => void;
  onArchive: (a: Asset) => void;
  onDelete: (a: Asset) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const { sort, toggle, apply } = useSort<Asset>(ASSET_ACCESSORS);
  const visible = useMemo(() => assets.filter((a) => showArchived || !a.archived), [assets, showArchived]);
  const byClass = useMemo(() => [...assetsByClass(assets).entries()].sort((a, b) => b[1] - a[1]), [assets]);
  const total = byClass.reduce((s, [, v]) => s + v, 0);
  const archivedCount = assets.filter((a) => a.archived).length;
  const s = { sort, onSort: toggle };

  return (
    <div className="space-y-4">
      {byClass.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {byClass.map(([cls, v]) => (
            <div key={cls} className="p-3.5 rounded-xl bg-brand-panel ring-1 ring-brand-border shadow-card">
              <div className="flex items-center gap-1.5 text-xs font-bold">
                <span aria-hidden className="w-2 h-2 rounded-full" style={{ backgroundColor: colorFor(cls) }} />{cls}
              </div>
              <div className="mt-1.5 text-lg font-display font-semibold tabular-nums">₹{fmtMoney(v, 0)}</div>
              <div className="text-[11px] text-brand-mute">{total ? ((v / total) * 100).toFixed(0) : 0}% of manual assets</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-brand-mute">
          {visible.length} asset{visible.length === 1 ? "" : "s"} · ₹{fmtMoney(total, 0)} active
          {archivedCount > 0 && (
            <button type="button" onClick={() => setShowArchived((v) => !v)}
                    className="ml-2 text-[11px] font-semibold text-brand-accent hover:underline">
              {showArchived ? "hide" : "show"} {archivedCount} archived
            </button>
          )}
        </div>
        <PrimaryBtn onClick={onAdd}>+ Asset</PrimaryBtn>
      </div>

      {!visible.length ? (
        <EmptyState text="No manual assets yet — cash, FDs, mutual funds, gold, EPF/PPF, property. Equity comes from the journal automatically."
                    action={<GhostBtn onClick={onAdd}>Add your first asset</GhostBtn>} />
      ) : (
        <TableShell>
          <thead>
            <tr className="bg-brand-soft">
              <Th sortKey="name" {...s}>Asset</Th>
              <Th sortKey="cls" {...s}>Class</Th>
              <Th sortKey="institution" {...s}>Institution</Th>
              <Th right sortKey="value" {...s}>Value</Th>
              <Th right sortKey="cost" {...s}>Cost basis</Th>
              <Th right sortKey="gain" {...s}>Gain</Th>
              <Th sortKey="asOf" {...s}>As of</Th>
              <Th>Notes</Th><Th />
            </tr>
          </thead>
          <tbody>
            {apply(visible).map((a) => {
              const g = assetGain(a);
              return (
                <tr key={a.id} className={`border-t border-brand-border/60 hover:bg-brand-soft/60 ${a.archived ? "opacity-60" : ""}`}>
                  <Td className="font-semibold">
                    {a.name}{a.archived && <span className="ml-1.5 text-[9px] uppercase text-brand-mute">archived</span>}
                  </Td>
                  <Td><ClassChip cls={a.asset_class} /></Td>
                  <Td className="text-brand-mute">{a.institution ?? "—"}</Td>
                  <Td right className="font-semibold">{fmtMoney(a.current_value, 0)}</Td>
                  <Td right className="text-brand-mute">{a.cost_basis === null ? "—" : fmtMoney(a.cost_basis, 0)}</Td>
                  <Td right>
                    {g ? <span className="inline-flex flex-col items-end leading-tight">
                      <Pnl value={g.gain} digits={0} />
                      {g.pct !== null && <span className="text-[10px]"><Pnl value={g.pct} suffix="%" digits={1} /></span>}
                    </span> : <span className="text-brand-mute">—</span>}
                  </Td>
                  <Td className="text-brand-mute">{fmtDate(a.as_of_date)}</Td>
                  <Td className="max-w-[160px] truncate text-brand-mute"><span title={a.notes ?? ""}>{a.notes ?? ""}</span></Td>
                  <Td>
                    <span className="inline-flex gap-0.5">
                      <RowBtn title="Update value" onClick={() => onUpdateValue(a)}>₹</RowBtn>
                      <RowBtn title="Edit" onClick={() => onEdit(a)}>✎</RowBtn>
                      <RowBtn title={a.archived ? "Restore" : "Archive (keeps history)"} onClick={() => onArchive(a)}>
                        {a.archived ? "↺" : "🗄"}
                      </RowBtn>
                      <RowBtn title="Delete" danger onClick={() => onDelete(a)}>🗑</RowBtn>
                    </span>
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

const LIAB_ACCESSORS: Record<string, (l: Liability) => unknown> = {
  name: (l) => l.name,
  kind: (l) => l.kind,
  outstanding: (l) => num(l.outstanding),
  rate: (l) => (l.interest_rate === null ? null : num(l.interest_rate)),
  emi: (l) => (l.emi === null ? null : num(l.emi)),
};

export function LiabilitiesTab({ liabilities, onAdd, onEdit, onArchive, onDelete }: {
  liabilities: Liability[];
  onAdd: () => void;
  onEdit: (l: Liability) => void;
  onArchive: (l: Liability) => void;
  onDelete: (l: Liability) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const { sort, toggle, apply } = useSort<Liability>(LIAB_ACCESSORS);
  const visible = useMemo(() => liabilities.filter((l) => showArchived || !l.archived), [liabilities, showArchived]);
  const byKind = useMemo(() => [...liabilitiesByKind(liabilities).entries()].sort((a, b) => b[1] - a[1]), [liabilities]);
  const total = byKind.reduce((s, [, v]) => s + v, 0);
  const emi = liabilities.filter((l) => !l.archived).reduce((s, l) => s + num(l.emi), 0);
  const archivedCount = liabilities.filter((l) => l.archived).length;
  const s = { sort, onSort: toggle };

  return (
    <div className="space-y-4">
      {total > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3.5 rounded-xl bg-brand-panel ring-1 ring-brand-border shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">Total outstanding</div>
            <div className="mt-1 text-lg font-display font-semibold tabular-nums text-rose-700">₹{fmtMoney(total, 0)}</div>
          </div>
          <div className="p-3.5 rounded-xl bg-brand-panel ring-1 ring-brand-border shadow-card">
            <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">EMIs / month</div>
            <div className="mt-1 text-lg font-display font-semibold tabular-nums">₹{fmtMoney(emi, 0)}</div>
          </div>
          {byKind.slice(0, 2).map(([k, v]) => (
            <div key={k} className="p-3.5 rounded-xl bg-brand-panel ring-1 ring-brand-border shadow-card">
              <div className="text-[10px] font-bold uppercase tracking-wider text-brand-mute">{k}</div>
              <div className="mt-1 text-lg font-display font-semibold tabular-nums">₹{fmtMoney(v, 0)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-brand-mute">
          {visible.length} liabilit{visible.length === 1 ? "y" : "ies"}
          {archivedCount > 0 && (
            <button type="button" onClick={() => setShowArchived((v) => !v)}
                    className="ml-2 text-[11px] font-semibold text-brand-accent hover:underline">
              {showArchived ? "hide" : "show"} {archivedCount} archived
            </button>
          )}
        </div>
        <PrimaryBtn onClick={onAdd}>+ Liability</PrimaryBtn>
      </div>

      {!visible.length ? (
        <EmptyState text="No liabilities — loans and card balances entered here are subtracted from your net worth."
                    action={<GhostBtn onClick={onAdd}>Add a liability</GhostBtn>} />
      ) : (
        <TableShell>
          <thead>
            <tr className="bg-brand-soft">
              <Th sortKey="name" {...s}>Liability</Th>
              <Th sortKey="kind" {...s}>Type</Th>
              <Th right sortKey="outstanding" {...s}>Outstanding</Th>
              <Th right sortKey="rate" {...s}>Rate</Th>
              <Th right sortKey="emi" {...s}>EMI</Th>
              <Th>Notes</Th><Th />
            </tr>
          </thead>
          <tbody>
            {apply(visible).map((l) => (
              <tr key={l.id} className={`border-t border-brand-border/60 hover:bg-brand-soft/60 ${l.archived ? "opacity-60" : ""}`}>
                <Td className="font-semibold">
                  {l.name}{l.archived && <span className="ml-1.5 text-[9px] uppercase text-brand-mute">archived</span>}
                </Td>
                <Td className="text-brand-mute">{l.kind}</Td>
                <Td right className="font-semibold text-rose-700">{fmtMoney(l.outstanding, 0)}</Td>
                <Td right className="text-brand-mute">{l.interest_rate === null ? "—" : `${l.interest_rate}%`}</Td>
                <Td right>{l.emi === null ? "—" : fmtMoney(l.emi, 0)}</Td>
                <Td className="max-w-[160px] truncate text-brand-mute"><span title={l.notes ?? ""}>{l.notes ?? ""}</span></Td>
                <Td>
                  <span className="inline-flex gap-0.5">
                    <RowBtn title="Edit / update outstanding" onClick={() => onEdit(l)}>✎</RowBtn>
                    <RowBtn title={l.archived ? "Restore" : "Archive (paid off; keeps history)"} onClick={() => onArchive(l)}>
                      {l.archived ? "↺" : "🗄"}
                    </RowBtn>
                    <RowBtn title="Delete" danger onClick={() => onDelete(l)}>🗑</RowBtn>
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}
