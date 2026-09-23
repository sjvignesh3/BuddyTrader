// -----------------------------------------------------------------------------
// S200 — the quantitative pool. Shows the screening criteria (the sheet's
// "Used condition for this Qtr"), lets the owner edit the thresholds, and
// carries the "Sync from Screener" entry point with its consent dialog. The
// sync itself is not wired yet (API answers 501); until then the S200 list
// is imported by hand and the criteria are documentation + the future input.
// -----------------------------------------------------------------------------
import { useEffect, useState } from "react";
import type { ScreenCriteria, UniverseSync } from "../../lib/universeApi";
import { useScreenCriteria, useUniverseMutations } from "../../hooks/useUniverse";
import { fmtDateTime } from "../../lib/money";
import { OwnerOnly } from "../AuthGate";
import { ConfirmDialog, GhostBtn, NumInput, PrimaryBtn } from "../journal/ui";

function Rule({ label, value, unit, editing, onChange }: {
  label: string; value: string; unit?: string; editing: boolean; onChange: (v: string) => void;
}) {
  const bad = editing && !(value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-brand-text">{label}</span>
      {editing ? (
        <span className="w-24">
          <NumInput inputMode="decimal" value={value} invalid={bad} suffix={unit}
                    onChange={(e) => onChange(e.target.value)} />
        </span>
      ) : (
        <b className="font-mono text-rose-600">{value}{unit ?? ""}</b>
      )}
    </div>
  );
}

export default function ScreenCriteriaCard({ pool, lastSync }: {
  pool: string; lastSync: UniverseSync | undefined;
}) {
  const q = useScreenCriteria(pool);
  const { saveCriteria, startScreen } = useUniverseMutations();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ScreenCriteria | null>(null);
  const [consent, setConsent] = useState(false);
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);

  useEffect(() => { if (q.data && !editing) setDraft(q.data.criteria); }, [q.data, editing]);

  const c = draft ?? q.data?.criteria;
  if (!c) return null;
  const setN = (k: keyof ScreenCriteria["normal"]) => (v: string) =>
    setDraft((d) => d && ({ ...d, normal: { ...d.normal, [k]: v } }));
  const setB = (k: keyof ScreenCriteria["banks_nbfc"]) => (v: string) =>
    setDraft((d) => d && ({ ...d, banks_nbfc: { ...d.banks_nbfc, [k]: v } }));

  const save = () => {
    if (!draft) return;
    saveCriteria.mutate({ pool, criteria: draft }, {
      onSuccess: () => { setEditing(false); setNote({ text: "Criteria saved." }); },
      onError: (e) => setNote({ text: e instanceof Error ? e.message : String(e), err: true }),
    });
  };

  const runScreen = () => {
    setConsent(false);
    startScreen.mutate(pool, {
      onSuccess: () => setNote({ text: "Screening started — review the preview before it is applied." }),
      onError: (e) => setNote({ text: e instanceof Error ? e.message : String(e), err: true }),
    });
  };

  return (
    <div className="rounded-2xl ring-1 ring-brand-border bg-brand-panel shadow-card px-4 py-3.5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-block px-2 py-0.5 rounded bg-amber-400/90 text-[11px] font-bold
                         uppercase tracking-wide text-amber-950">Used condition for this Qtr</span>
        <span className="text-[11px] text-brand-mute">
          {pool} is quantitative — membership comes from a Screener.in screen, not by hand.
          {q.data?.updated_at && <> Criteria edited {fmtDateTime(q.data.updated_at)}.</>}
        </span>
        <OwnerOnly>
          <span className="ml-auto flex items-center gap-2">
            {editing ? (
              <>
                <GhostBtn onClick={() => { setEditing(false); setDraft(q.data?.criteria ?? null); }}>Cancel</GhostBtn>
                <PrimaryBtn onClick={save} disabled={saveCriteria.isPending}>
                  {saveCriteria.isPending ? "Saving…" : "Save criteria"}
                </PrimaryBtn>
              </>
            ) : (
              <GhostBtn onClick={() => setEditing(true)}>Edit criteria</GhostBtn>
            )}
          </span>
        </OwnerOnly>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="rounded-xl ring-1 ring-brand-border bg-brand-soft/60 px-3 py-2.5 space-y-1.5">
          <div className="font-display font-semibold text-sm">Non Banking</div>
          <Rule label="Net Debt to Equity <" value={c.normal.net_debt_to_equity_max}
                editing={editing} onChange={setN("net_debt_to_equity_max")} />
          <div className="text-[10px] text-brand-mute pl-1">AND</div>
          <Rule label="Return on capital employed >" value={c.normal.roce_min}
                editing={editing} onChange={setN("roce_min")} />
          <div className="text-[10px] text-brand-mute pl-1">AND</div>
          <Rule label="Net profit >" value={c.normal.net_profit_min_cr} unit=" Cr"
                editing={editing} onChange={setN("net_profit_min_cr")} />
        </div>
        <div className="rounded-xl ring-1 ring-brand-border bg-brand-soft/60 px-3 py-2.5 space-y-1.5">
          <div className="font-display font-semibold text-sm">Banks &amp; NBFC</div>
          <Rule label="ROE >" value={c.banks_nbfc.roe_min} unit="%"
                editing={editing} onChange={setB("roe_min")} />
          <div className="text-[10px] text-brand-mute pl-1">AND</div>
          <Rule label="Net profit >" value={c.banks_nbfc.net_profit_min_cr} unit=" Cr"
                editing={editing} onChange={setB("net_profit_min_cr")} />
          <p className="text-[11px] text-brand-mute pt-1">
            Applied strictly by the stock's criteria group (Banks / NBFC). A stock in the wrong
            group is judged by the wrong rule — fix the group in the table below.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-brand-border/60">
        <span className="text-[11px] text-brand-mute">
          {lastSync
            ? <>Last update: <b className="text-brand-text">{lastSync.kind === "screen" ? "Screener sync" : "import"}</b>{" "}
                {fmtDateTime(lastSync.applied_at ?? lastSync.created_at)} · +{lastSync.diff?.added?.length ?? 0} / −{lastSync.diff?.removed?.length ?? 0}</>
            : "No sync or import recorded yet."}
        </span>
        <OwnerOnly>
          <button onClick={() => setConsent(true)} disabled={startScreen.isPending}
                  className="ml-auto text-[11px] font-bold px-3 py-1.5 rounded-lg bg-brand-accent text-white
                             hover:opacity-90 transition-opacity disabled:opacity-40">
            ⟳ Sync {pool} from Screener
          </button>
        </OwnerOnly>
      </div>

      {note && (
        <div className={`text-[11px] rounded-lg px-3 py-1.5 ring-1 ${note.err
          ? "text-rose-700 bg-rose-50 ring-rose-200" : "text-brand-mute bg-brand-soft ring-brand-border"}`}>
          {note.text}
        </div>
      )}

      {consent && (
        <ConfirmDialog
          title={`Sync ${pool} from Screener.in?`}
          confirmLabel="Run the screen"
          busy={startScreen.isPending}
          onCancel={() => setConsent(false)}
          onConfirm={runScreen}
          message={
            `This runs the two screens above on Screener.in and builds a NEW ${pool} list.\n\n` +
            `Nothing is written straight away: you get a preview of every stock that would join or ` +
            `leave, and the list only changes after you confirm it.\n\n` +
            `${pool} is the primary source for the ${pool} pool view, its scans and the journal's ` +
            `symbol picker, so review the preview carefully.`
          }
        />
      )}
    </div>
  );
}
