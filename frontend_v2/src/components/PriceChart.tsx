// -----------------------------------------------------------------------------
// Lightweight SVG close-price chart for the stock detail page. No chart lib —
// a teal line + area over daily snapshots, with dashed reference levels
// (200 DMA, rally re-entry/exit) drawn when they fall inside the price range.
// Hover/touch shows a crosshair with date + price. Fully responsive (viewBox).
// -----------------------------------------------------------------------------
import { useMemo, useRef, useState } from "react";

export interface ChartPoint { date: string; close: number }
export interface ChartLevel { label: string; value: number; color: string }

const W = 640;
const H = 220;
const PAD = { top: 14, right: 8, bottom: 22, left: 8 };

const fmtShort = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
const fmtPrice = (v: number) =>
  v.toLocaleString("en-IN", { maximumFractionDigits: v >= 1000 ? 0 : 2 });

export default function PriceChart({ points, levels = [] }: {
  points: ChartPoint[];           // chronological (oldest → newest)
  levels?: ChartLevel[];
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { path, area, xs, ys, lo, hi, shown } = useMemo(() => {
    const closes = points.map((p) => p.close);
    let lo = Math.min(...closes);
    let hi = Math.max(...closes);
    // Pull in reference levels that sit near the traded range so they are
    // visible without squashing the price line.
    const span = hi - lo || hi * 0.05 || 1;
    const shown = levels.filter(
      (l) => l.value >= lo - span * 0.5 && l.value <= hi + span * 0.5);
    for (const l of shown) { lo = Math.min(lo, l.value); hi = Math.max(hi, l.value); }
    const pad = (hi - lo || hi * 0.05 || 1) * 0.07;
    lo -= pad; hi += pad;

    const x = (i: number) => points.length === 1
      ? (PAD.left + W - PAD.right) / 2
      : PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
    const y = (v: number) =>
      PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

    const xs = points.map((_, i) => x(i));
    const ys = closes.map(y);
    const path = xs.map((px, i) => `${i ? "L" : "M"}${px.toFixed(1)},${ys[i]!.toFixed(1)}`).join(" ");
    const base = H - PAD.bottom;
    const area = `${path} L${xs[xs.length - 1]!.toFixed(1)},${base} L${xs[0]!.toFixed(1)},${base} Z`;
    return { path, area, xs, ys, lo, hi, shown };
  }, [points, levels]);

  if (points.length < 2) {
    return (
      <div className="h-32 grid place-items-center text-xs text-brand-mute">
        Not enough history yet — the chart builds up as daily syncs run.
      </div>
    );
  }

  const yFor = (v: number) =>
    PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fx = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (fx - PAD.left) / (W - PAD.left - PAD.right);
    const idx = Math.round(frac * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, idx)));
  };

  const h = hover !== null ? points[hover] : null;
  const last = points[points.length - 1]!;

  return (
    <div className="relative">
      {/* readout strip — hover value or the latest close */}
      <div className="flex items-baseline gap-2 px-1 pb-1 text-[11px] font-mono tabular-nums">
        <span className="font-bold text-brand-text">
          ₹{fmtPrice((h ?? last).close)}
        </span>
        <span className="text-brand-mute">{fmtShort((h ?? last).date)}</span>
        <span className="ml-auto flex flex-wrap gap-x-3 gap-y-0.5">
          {shown.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1 text-[10px] text-brand-mute">
              <span className="inline-block w-3 border-t-2 border-dashed"
                    style={{ borderColor: l.color }} />
              {l.label} ₹{fmtPrice(l.value)}
            </span>
          ))}
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto select-none touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="pc-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0f766e" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#0f766e" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* reference levels */}
        {shown.map((l) => (
          <g key={l.label}>
            <line x1={PAD.left} x2={W - PAD.right}
                  y1={yFor(l.value)} y2={yFor(l.value)}
                  stroke={l.color} strokeWidth="1" strokeDasharray="5 4"
                  opacity="0.75" />
          </g>
        ))}

        <path d={area} fill="url(#pc-fill)" />
        <path d={path} fill="none" stroke="#0f766e" strokeWidth="2"
              strokeLinejoin="round" strokeLinecap="round" />

        {/* last close dot */}
        <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="3.5"
                fill="#0f766e" stroke="#fff" strokeWidth="1.5" />

        {/* hover crosshair */}
        {hover !== null && (
          <g>
            <line x1={xs[hover]} x2={xs[hover]} y1={PAD.top} y2={H - PAD.bottom}
                  stroke="#a8a29e" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={xs[hover]} cy={ys[hover]} r="4"
                    fill="#fff" stroke="#0f766e" strokeWidth="2" />
          </g>
        )}

        {/* x-axis extremes */}
        <text x={PAD.left} y={H - 6} fontSize="10" fill="#a8a29e">
          {fmtShort(points[0]!.date)}
        </text>
        <text x={W - PAD.right} y={H - 6} fontSize="10" fill="#a8a29e"
              textAnchor="end">
          {fmtShort(last.date)}
        </text>
      </svg>
    </div>
  );
}
