"""Canary drift verification.

A canary check pins a known (symbol, date, close) fixture. After every
sync we re-read the same anchor date and compare — a mismatch above the
configured tolerance means data has silently drifted (yfinance change,
migration bug, upstream corporate action re-adjust) and we must alert.
"""
from plutus.canary.runner import (  # noqa: F401
    CanaryOutcome,
    CanaryRunReport,
    CanaryRunner,
)
