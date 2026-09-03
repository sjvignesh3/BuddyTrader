// -----------------------------------------------------------------------------
// Dropdown — a styled replacement for native <select> in toolbars.
// Pill trigger + floating panel with hover states, ✓ on the active option,
// closes on outside click / Escape. Value "" is the "all" state.
// -----------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
  /** small second line under the label */
  hint?: string;
}

export default function Dropdown({ value, onChange, options, placeholder, title }: {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  /** trigger text while value === "" (usually the "All …" state) */
  placeholder: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value && o.value !== "");
  const active = Boolean(current);

  return (
    <div ref={ref} className="relative" title={title}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm shadow-card
                    ring-1 transition-colors max-w-[190px]
                    ${active
                      ? "bg-teal-700 text-white ring-teal-700 font-semibold"
                      : "bg-brand-panel ring-brand-border text-brand-text hover:bg-brand-soft"}`}>
        <span className="truncate">{current?.label ?? placeholder}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden
             className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}
                         ${active ? "text-teal-100" : "text-brand-mute"}`}>
          <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 z-40 mt-1.5 min-w-[170px] w-max max-w-[240px]
                        rounded-xl bg-brand-panel ring-1 ring-brand-border shadow-pop
                        py-1.5 max-h-72 overflow-y-auto">
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <button
                key={o.value || "__all__"}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 flex items-center justify-between gap-3
                            text-[13px] transition-colors
                            ${selected
                              ? "text-brand-accent font-semibold bg-teal-50/60"
                              : "text-brand-text hover:bg-brand-soft"}`}>
                <span className="min-w-0">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && (
                    <span className="block text-[10px] text-brand-mute truncate">{o.hint}</span>
                  )}
                </span>
                {selected && <span className="shrink-0 text-xs">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
