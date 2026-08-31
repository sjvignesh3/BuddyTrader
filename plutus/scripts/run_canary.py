"""CLI: `python -m plutus.scripts.run_canary`

Runs all active canary fixtures, updates their observed state, and alerts
if any drift / missing / error is found.

Exit codes:
    0 — all fixtures ok (or no fixtures configured).
    1 — one or more drift / missing / error outcomes.
    2 — orchestration failure.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import Optional, Sequence

from plutus.canary.runner import CanaryRunner


def _parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="run_canary",
                                 description="Plutus canary drift verifier.")
    ap.add_argument("--no-alert", action="store_true",
                    help="Compute drift but do not dispatch an alert.")
    ap.add_argument("--verbose", action="store_true")
    return ap.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None,
         *, runner: Optional[CanaryRunner] = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        r = runner or CanaryRunner()
        report = r.run(alert=not args.no_alert)
    except Exception as exc:  # noqa: BLE001
        logging.error("canary orchestration failed: %s", exc)
        return 2
    print(json.dumps(report.as_json(), indent=2, default=str))
    if report.drift or report.missing or report.error:
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
