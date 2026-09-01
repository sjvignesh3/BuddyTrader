// Fundamental score badge — legacy BuddyTrader bands:
//   8–11 strong (green) · 6–7 moderate (amber) · 0–5 weak (red) · — no data
export default function ScoreBadge({
  points,
  max = 11,
}: {
  points: number | null;
  max?: number;
}) {
  if (points === null) {
    return <span className="text-brand-mute font-mono text-xs">—</span>;
  }
  const cls =
    points >= 8
      ? "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30"
      : points >= 6
        ? "bg-amber-500/15 text-amber-400 ring-amber-500/30"
        : "bg-red-500/15 text-red-400 ring-red-500/30";
  return (
    <span
      className={`inline-flex items-baseline gap-0.5 px-2 py-0.5 rounded-md ring-1 font-mono text-xs font-bold tabular-nums ${cls}`}
    >
      {points}
      <span className="font-normal opacity-70">/{max}</span>
    </span>
  );
}
