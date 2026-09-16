// -----------------------------------------------------------------------------
// Plutus home — personal toolbench landing. New tools get a card here.
// -----------------------------------------------------------------------------
import { Link } from "react-router-dom";

interface Tool {
  icon: string;
  name: string;
  desc: string;
  to?: string;      // absent = coming soon
  accent: string;   // gradient classes for the icon tile
}

const TOOLS: Tool[] = [
  {
    icon: "📡",
    name: "Market Analysis",
    desc: "Pools, signals, fundamental scores, opportunity radar and comparisons across your NSE universes.",
    to: "/pools",
    accent: "from-teal-700 to-teal-500",
  },
  {
    icon: "📓",
    name: "Trading Journal",
    desc: "Opportunities, open & closed trades and portfolio — capital-aware allocation with cap-bucket limits.",
    to: "/journal",
    accent: "from-amber-700 to-amber-500",
  },
  {
    icon: "🪙",
    name: "Expense Tracker",
    desc: "Manual-first expense intelligence — two-keystroke capture, monthly insights, needs vs wants, recurring visibility.",
    to: "/expenses",
    accent: "from-sky-700 to-sky-500",
  },
  {
    icon: "🧮",
    name: "Position Sizer",
    desc: "Risk-based quantity, cap-limit room, R-multiple targets, GTT ladders and portfolio heat — before you place the order.",
    to: "/position-sizer",
    accent: "from-rose-700 to-rose-500",
  },
  {
    icon: "🏛️",
    name: "Net Worth",
    desc: "Assets − liabilities, monthly snapshots, allocation, XIRR, runway, savings rate and milestones — your wealth command center.",
    to: "/net-worth",
    accent: "from-violet-700 to-violet-500",
  },
];

export default function HomePage() {
  return (
    <div>
      <div className="mt-4 mb-8">
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Welcome to <span className="text-teal-700">Plutus</span>
        </h1>
        <p className="text-sm text-brand-mute mt-1.5 max-w-xl">
          Your personal trading toolbench. Pick a tool — more get added over time.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((t) =>
          t.to ? (
            <Link key={t.name} to={t.to}
              className="group block p-5 rounded-2xl bg-brand-panel ring-1 ring-brand-border
                         shadow-card hover:shadow-pop transition-shadow">
              <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${t.accent}
                               grid place-items-center text-xl shadow-card`}>
                {t.icon}
              </div>
              <div className="mt-3 font-display font-semibold text-lg">{t.name}</div>
              <p className="mt-1 text-sm text-brand-mute">{t.desc}</p>
              <div className="mt-3 text-[11px] font-semibold text-brand-accent
                              opacity-0 group-hover:opacity-100 transition-opacity">
                Open tool →
              </div>
            </Link>
          ) : (
            <div key={t.name}
              className="p-5 rounded-2xl bg-brand-soft ring-1 ring-brand-border/60
                         border-dashed opacity-70">
              <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${t.accent}
                               grid place-items-center text-xl`}>
                {t.icon}
              </div>
              <div className="mt-3 font-display font-semibold text-lg flex items-center gap-2">
                {t.name}
                <span className="text-[9px] uppercase tracking-widest font-bold
                                 text-brand-mute bg-brand-panel ring-1 ring-brand-border
                                 rounded px-1.5 py-0.5">soon</span>
              </div>
              <p className="mt-1 text-sm text-brand-mute">{t.desc}</p>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
