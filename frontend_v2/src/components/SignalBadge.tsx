// Signal chip — BUY / OPP / RALLY, tuned for the light theme.
const MAP: Record<string, { label: string; cls: string }> = {
  BUY_ZONE: { label: "BUY", cls: "bg-teal-700 text-white" },
  OPPORTUNITY: { label: "OPP", cls: "bg-amber-100 text-amber-800 ring-1 ring-amber-300" },
  VALID: { label: "RALLY", cls: "bg-sky-100 text-sky-800 ring-1 ring-sky-300" },
};

export default function SignalBadge({ status }: { status: string | null }) {
  const m = status ? MAP[status] : undefined;
  if (!m) return <span className="text-brand-mute text-xs">—</span>;
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider ${m.cls}`}>
      {m.label}
    </span>
  );
}
