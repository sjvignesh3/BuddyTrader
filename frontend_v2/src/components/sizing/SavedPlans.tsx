// -----------------------------------------------------------------------------
// Saved sizing plans — a compact table of past plans with load / convert /
// delete. Derived columns (₹ risk, deployed) are recomputed from the stored
// inputs, never read from the row.
// -----------------------------------------------------------------------------
import { Link } from "react-router-dom";
import { num } from "../../lib/journal";
import { fmtDate, fmtMoney } from "../../lib/money";
import type { SizingPlan } from "../../lib/sizingApi";
import { CapChip, EmptyState, RowBtn, TableShell, Td, Th } from "../journal/ui";
import { Card } from "./results";

export default function SavedPlans({ plans, onLoad, onConvert, onDelete }: {
  plans: SizingPlan[];
  onLoad: (p: SizingPlan) => void;
  onConvert: (p: SizingPlan) => void;
  onDelete: (p: SizingPlan) => void;
}) {
  if (!plans.length) {
    return (
      <Card title="Saved plans">
        <EmptyState text="No saved plans yet — size a trade above and press Save plan to keep it for later." />
      </Card>
    );
  }
  return (
    <Card title="Saved plans" right={<span className="text-[10px] text-brand-mute">{plans.length} plan{plans.length === 1 ? "" : "s"}</span>}>
      <TableShell>
        <thead>
          <tr className="bg-brand-soft">
            <Th>Saved</Th><Th>Stock</Th><Th>Cap</Th>
            <Th right>Entry</Th><Th right>Stop</Th><Th right>Qty</Th>
            <Th right>Deployed</Th><Th right>₹ risk</Th><Th right>Risk %</Th>
            <Th>Targets</Th><Th>Ladder</Th><Th>Status</Th><Th />
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => {
            const entry = num(p.entry) ?? 0; const stop = num(p.stop) ?? 0;
            const risk = (entry - stop) * p.qty;
            return (
              <tr key={p.id} className="border-t border-brand-border/60 hover:bg-brand-soft/60">
                <Td className="text-brand-mute">{fmtDate(p.created_at)}</Td>
                <Td className="font-semibold">{p.symbol}</Td>
                <Td><CapChip cap={p.cap_bucket} /></Td>
                <Td right>{fmtMoney(p.entry)}</Td>
                <Td right>{fmtMoney(p.stop)}</Td>
                <Td right>{p.qty}</Td>
                <Td right>{fmtMoney(entry * p.qty, 0)}</Td>
                <Td right className="text-rose-700">{fmtMoney(risk, 0)}</Td>
                <Td right className="text-brand-mute">{p.risk_pct}%</Td>
                <Td className="text-brand-mute">
                  {p.targets.length ? p.targets.map((t) => `₹${fmtMoney(t.price, 0)}`).join(" · ") : "—"}
                </Td>
                <Td className="text-brand-mute">
                  {p.ladder.length ? p.ladder.map((t) => `${t.qty}@₹${fmtMoney(t.trigger, 0)}`).join(" · ") : "—"}
                </Td>
                <Td>
                  {p.opportunity_id ? (
                    <Link to="/journal#opportunities" title={`Journal opportunity #${p.opportunity_id}`}
                          className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold ring-1 bg-sky-50 text-sky-800 ring-sky-300">
                      In journal
                    </Link>
                  ) : (
                    <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold ring-1 bg-stone-100 text-stone-500 ring-stone-200">
                      Plan
                    </span>
                  )}
                </Td>
                <Td>
                  <span className="inline-flex gap-0.5">
                    <RowBtn title="Load into the sizer" readOnlySafe
                            onClick={() => onLoad(p)}>↺</RowBtn>
                    {!p.opportunity_id && (
                      <RowBtn title="Convert to a journal opportunity" onClick={() => onConvert(p)}>🔭</RowBtn>
                    )}
                    <RowBtn title="Delete plan" danger onClick={() => onDelete(p)}>🗑</RowBtn>
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </TableShell>
    </Card>
  );
}
