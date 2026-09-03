// Radial fundamental-score indicator — instant read of x/11 quality.
// Bands: 8–11 teal-green (strong) · 6–7 gold (moderate) · 0–5 rose (weak).
export default function ScoreRing({
  points,
  max = 11,
  size = 34,
}: {
  points: number | null;
  max?: number;
  size?: number;
}) {
  const stroke = Math.max(3, Math.round(size / 11));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  if (points === null) {
    return (
      <span
        className="inline-grid place-items-center rounded-full ring-1 ring-brand-border bg-brand-soft text-brand-mute"
        style={{ width: size, height: size, fontSize: size * 0.34 }}
        title="Not scored yet"
      >
        –
      </span>
    );
  }

  const frac = Math.max(0, Math.min(1, points / max));
  const color = points >= 8 ? "#0f766e" : points >= 6 ? "#9a6a08" : "#be123c";

  return (
    <span className="relative inline-block" style={{ width: size, height: size }}
          title={`Fundamental score ${points}/${max}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke="#e5e0d4" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke={color} strokeWidth={stroke} strokeLinecap="round"
                strokeDasharray={`${c * frac} ${c}`} />
      </svg>
      <span
        className="absolute inset-0 grid place-items-center font-bold tabular-nums"
        style={{ color, fontSize: size * 0.36 }}
      >
        {points}
      </span>
    </span>
  );
}
