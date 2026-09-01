// Signal chip — legacy label mapping: BUY_ZONE→BUY, OPPORTUNITY→OPP,
// VALID→RALLY, everything else → dash.
const MAP: Record<string, { label: string; cls: string }> = {
  BUY_ZONE: { label: "BUY", cls: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30" },
  OPPORTUNITY: { label: "OPP", cls: "bg-amber-500/15 text-amber-400 ring-amber-500/30" },
  VALID: { label: "RALLY", cls: "bg-sky-500/15 text-sky-400 ring-sky-500/30" },
};

export default function SignalBadge({ status }: { status: string | null }) {
  const m = status ? MAP[status] : undefined;
  if (!m) return <span className="text-brand-mute text-xs">—</span>;
  return (
    <span
      className={`inline-flex px-2 py-0.5 rounded-md ring-1 text-[10px] font-bold tracking-wide ${m.cls}`}
    >
      {m.label}
    </span>
  );
}
