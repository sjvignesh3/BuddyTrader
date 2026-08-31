"""
Fetch raw yfinance payloads for 5 pilot symbols and dump them to fixtures.

The output JSON files become the deterministic corpus for Stage 3 metrics
tests — no live network needed once fixtures exist.

Usage:
    python -m plutus.scripts.pilot_fetch
    python -m plutus.scripts.pilot_fetch --out plutus/tests/fixtures/pilot
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict

from plutus.adapters.yf_client import (
    apply_session_timeout,
    fetch_history,
    fetch_info,
)

logger = logging.getLogger("plutus.pilot_fetch")

PILOT_SYMBOLS = [
    "RELIANCE.NS",
    "TCS.NS",
    "INFY.NS",
    "PAGEIND.NS",
    "ITC.NS",
]


def _serialise_history(df) -> Dict[str, Any]:
    """Convert a yfinance history DataFrame to plain JSON-safe dict."""
    if df is None:
        return {}
    records = []
    reset = df.reset_index()
    for _, row in reset.iterrows():
        rec = {}
        for col, val in row.items():
            key = str(col)
            if hasattr(val, "isoformat"):
                rec[key] = val.isoformat()
            elif val is None:
                rec[key] = None
            else:
                try:
                    # Convert numpy types to native
                    rec[key] = val.item() if hasattr(val, "item") else val
                except Exception:
                    rec[key] = str(val)
        records.append(rec)
    return {"columns": [str(c) for c in reset.columns], "rows": records}


def fetch_one(symbol: str, out_dir: Path) -> Dict[str, Any]:
    logger.info("fetching %s", symbol)
    info_res = fetch_info(symbol)
    hist_res = fetch_history(symbol, period="5y", interval="1d")

    payload: Dict[str, Any] = {
        "symbol": symbol,
        "info": {
            "ok": info_res.ok,
            "attempts": info_res.attempts,
            "latency_ms": info_res.latency_ms,
            "error": info_res.error,
            "value": info_res.value if info_res.ok else None,
        },
        "history": {
            "ok": hist_res.ok,
            "attempts": hist_res.attempts,
            "latency_ms": hist_res.latency_ms,
            "error": hist_res.error,
            "value": _serialise_history(hist_res.value) if hist_res.ok else None,
        },
    }

    out_path = out_dir / f"{symbol.replace('.', '_')}.json"
    out_path.write_text(json.dumps(payload, indent=2, default=str))
    logger.info("wrote %s (info=%s, history=%s)",
                out_path, info_res.ok, hist_res.ok)
    return {
        "symbol": symbol,
        "info_ok": info_res.ok,
        "history_ok": hist_res.ok,
        "file": str(out_path),
    }


def _cli() -> int:
    parser = argparse.ArgumentParser(description="Pilot yfinance fetch.")
    parser.add_argument("--out", type=Path,
                        default=Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "pilot")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
    )
    args.out.mkdir(parents=True, exist_ok=True)
    apply_session_timeout()

    results = [fetch_one(sym, args.out) for sym in PILOT_SYMBOLS]
    print(json.dumps({"pilot_results": results, "out_dir": str(args.out)},
                     indent=2, default=str))
    all_ok = all(r["info_ok"] and r["history_ok"] for r in results)
    return 0 if all_ok else 2


if __name__ == "__main__":
    sys.exit(_cli())
