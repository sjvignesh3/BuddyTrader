// -----------------------------------------------------------------------------
// The members table for one pool (or the whole universe). Sortable, searchable,
// with per-row edit / remove for owners. Rows open the stock page.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { JournalRef, UniverseStock } from "../../lib/universeApi";
import { plainSymbol } from "../../lib/universeApi";
import { CAP_STYLES, EmptyState, RowActions, RowBtn, TableShell, Td, Th, useSort } from "../journal/ui";
import type { CapBucket } from "../../lib/journalApi";
import { GROUP_STYLES } from "./StockFormModal";

export function GroupChip({ group }: { group: UniverseStock["sector_group"] }) {
  if (!group) return <span className="text-brand-mute" title="Criteria group not set">—</span>;
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 ${GROUP_STYLES[group]}`}>
      {group}
    </span>
  );
}

const POOL_CHIP: Record<string, string> = {
  F40: "bg-teal-50 text-teal-800 ring-teal-200",
  E40: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  S200: "bg-sky-50 text-sky-800 ring-sky-200",
  PlayArea: "bg-amber-50 text-amber-800 ring-amber-200",
};

export default function UniverseTable({ stocks, pool, journalRefs, search, onEdit, onRemove }: {
  stocks: UniverseStock[];
  /** pool being shown — null = whole universe (shows the Pools column) */
  pool: string | null;
  journalRefs: Record<string, JournalRef>;
  search: string;
  onEdit: (s: UniverseStock) => void;
  onRemove: (s: UniverseStock) => void;
}) {
  const navigate = useNavigate();
  const [groupFilter, setGroupFilter] = useState<string>("");
  const { sort, toggle, apply } = useSort<UniverseStock>({
    symbol: (s) => plainSymbol(s.symbol),
    name: (s) => s.name,
    sector: (s) => s.sector,
    cap: (s) => s.cap_type_manual,
    group: (s) => s.sector_group,
    pools: (s) => (s.pools ?? []).join(" "),
    updated: (s) => s.updated_at,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return stocks.filter((s) =>
      (!groupFilter || (groupFilter === "unset" ? !s.sector_group : s.sector_group === groupFilter)) &&
      (!q || plainSymbol(s.symbol).includes(q) || (s.name ?? "").toUpperCase().includes(q)
        || (s.sector ?? "").toUpperCase().includes(q)));
  }, [stocks, search, groupFilter]);

  if (!stocks.length) {
    return <EmptyState text={pool ? `${pool} has no members yet — add stocks or import a CSV.`
                                  : "The universe is empty — import a CSV to begin."} />;
  }
  const s = { sort, onSort: toggle };
  const unset = stocks.filter((x) => !x.sector_group).length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[11px]">
        <span className="text-brand-mute mr-1">Group:</span>
        {([["", "All"], ["Banks", "Banks"], ["NBFC", "NBFC"], ["Normal", "Normal"],
           ["unset", `Not set${unset ? ` · ${unset}` : ""}`]] as [string, string][])
          .map(([v, l]) => (
            <button key={v} onClick={() => setGroupFilter(v)}
                    className={`px-2 py-0.5 rounded-full ring-1 font-semibold ${groupFilter === v
                      ? "bg-teal-700 text-white ring-teal-700"
                      : "bg-white text-brand-mute ring-brand-border hover:text-brand-text"}`}>
              {l}
            </button>
          ))}
        <span className="ml-auto text-brand-mute">{filtered.length} of {stocks.length}</span>
      </div>
      <TableShell>
        <thead>
          <tr className="bg-brand-soft">
            <Th sortKey="symbol" {...s}>Symbol</Th>
            <Th sortKey="name" {...s}>Name</Th>
            <Th sortKey="sector" {...s}>Sector</Th>
            <Th sortKey="cap" {...s}>Cap</Th>
            <Th sortKey="group" {...s}>Group</Th>
            {pool === null ? <Th sortKey="pools" {...s}>Pools</Th> : <Th>Also in</Th>}
            <Th>Journal</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {apply(filtered).map((st) => {
            const plain = plainSymbol(st.symbol);
            const ref = journalRefs[plain];
            const others = (st.pools ?? []).filter((p) => p !== pool);
            return (
              <tr key={st.symbol} onClick={() => navigate(`/stocks/${encodeURIComponent(st.symbol)}`)}
                  className={`border-t border-brand-border/60 hover:bg-brand-soft/60 cursor-pointer
                              ${st.active ? "" : "opacity-50"}`}>
                <Td className="font-semibold">
                  {plain}
                  {!st.active && <span className="ml-1.5 text-[9px] uppercase text-brand-mute">retired</span>}
                </Td>
                <Td className="text-brand-mute max-w-[220px] truncate">{st.name ?? "—"}</Td>
                <Td>{st.sector ?? <span className="text-brand-mute">—</span>}</Td>
                <Td>
                  {st.cap_type_manual
                    ? <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1
                                        ${CAP_STYLES[st.cap_type_manual as CapBucket] ?? ""}`}>{st.cap_type_manual}</span>
                    : <span className="text-brand-mute" title="Derived from market cap at sync time">auto</span>}
                </Td>
                <Td><GroupChip group={st.sector_group} /></Td>
                <Td>
                  <span className="inline-flex gap-1">
                    {(pool === null ? (st.pools ?? []) : others).map((p) => (
                      <span key={p} className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 ${POOL_CHIP[p] ?? "bg-brand-soft ring-brand-border"}`}>
                        {p}
                      </span>
                    ))}
                    {(pool === null ? (st.pools ?? []) : others).length === 0 && <span className="text-brand-mute">—</span>}
                  </span>
                </Td>
                <Td>
                  {ref ? (
                    <span className="text-[10px] font-semibold text-amber-800"
                          title="Open trades / active opportunities in the Trading Journal">
                      {ref.open_trades ? `${ref.open_trades} held` : ""}
                      {ref.open_trades && ref.active_opps ? " · " : ""}
                      {ref.active_opps ? `${ref.active_opps} opp` : ""}
                    </span>
                  ) : <span className="text-brand-mute">—</span>}
                </Td>
                <Td right>
                  <RowActions>
                    <RowBtn title="Edit fields" onClick={() => onEdit(st)}>✎</RowBtn>
                    {pool !== null && (
                      <RowBtn title={`Remove from ${pool}`} danger onClick={() => onRemove(st)}>✕</RowBtn>
                    )}
                  </RowActions>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </TableShell>
    </div>
  );
}
