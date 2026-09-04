// -----------------------------------------------------------------------------
// Embedded TradingView chart (official widgetembed iframe — no API key, no
// script injection). Replaces the home-grown snapshot chart: TradingView
// carries the full price history, indicators and range buttons that our
// young daily_snapshots table cannot. Free-tier widget: ~15-min delayed NSE
// quotes, which is fine for end-of-day decisions.
// -----------------------------------------------------------------------------
import { useMemo } from "react";

export default function TradingViewChart({ tvSymbol }: {
  /** Exchange-qualified symbol, e.g. "NSE:DIXON" or "BSE:500002". */
  tvSymbol: string;
}) {
  const src = useMemo(() => {
    const q = new URLSearchParams({
      symbol: tvSymbol,
      interval: "D",
      range: "12M",               // open at 1 year of daily candles
      theme: "light",
      style: "1",                 // candles
      timezone: "Asia/Kolkata",
      locale: "in",
      withdateranges: "1",        // 1M / 3M / 6M / 1Y / 5Y / All strip
      hide_side_toolbar: "1",
      allow_symbol_change: "0",
      save_image: "0",
      hideideas: "1",
      toolbar_bg: "#f7f5f0",
    });
    return `https://s.tradingview.com/widgetembed/?${q.toString()}#%7B%22page-uri%22%3A%22plutus%22%7D`;
  }, [tvSymbol]);

  return (
    <div className="rounded-xl overflow-hidden ring-1 ring-brand-border bg-white">
      <iframe
        title={`TradingView chart — ${tvSymbol}`}
        src={src}
        className="w-full h-[340px] sm:h-[460px] block"
        frameBorder="0"
        scrolling="no"
        allowFullScreen
      />
    </div>
  );
}
