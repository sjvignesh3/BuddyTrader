"""
Strategy contract — Plutus Stage 6.

Every strategy is a pure function of a single snapshot row + config.
No I/O, no network, no logging side-effects. Deterministic and testable.

CONTRACT:
  * evaluate(snapshot, config) -> StrategyResult
  * snapshot is a dict projected from the `daily_snapshots` registry
    columns — every key is registry-declared (grep-gated).
  * All numeric values in snapshot are Decimal (never float).
  * config is the strategy's block from strategy_rules.json plus any
    per-run overrides (thresholds live in strategy_configs table Stage 7).
  * StrategyResult is a frozen dataclass; strategies MUST NOT mutate the
    snapshot dict they receive.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Dict, List, Optional

# Status enums — mirror the Buddy legacy contract exactly so the frontend
# does not have to translate between the two implementations.
STATUS_BUY_ZONE = "BUY_ZONE"
STATUS_OPPORTUNITY = "OPPORTUNITY"
STATUS_NO_SIGNAL = "NO_SIGNAL"
STATUS_VALID = "VALID"
STATUS_INVALID = "INVALID"
STATUS_PASS = "PASS"       # fundamental screener
STATUS_FAIL = "FAIL"       # fundamental screener
STATUS_ERROR = "ERROR"     # evaluation could not be performed

ZONE_STATUSES = frozenset({STATUS_BUY_ZONE, STATUS_OPPORTUNITY, STATUS_NO_SIGNAL})
PATTERN_STATUSES = frozenset({STATUS_VALID, STATUS_INVALID})


def dec_or_default(value: Any, default: Decimal) -> Decimal:
    """Coerce a config threshold to Decimal, falling back to `default`
    ONLY when missing/invalid. An explicit zero is a legal threshold —
    never use `to_decimal(x) or default` (Decimal("0") is falsy).
    """
    from plutus.registry.types import to_decimal
    try:
        d = to_decimal(value)
    except Exception:  # noqa: BLE001 — config values are untrusted
        return default
    return d if d is not None else default


@dataclass(frozen=True)
class StrategyResult:
    """One strategy's verdict on one symbol.

    Attributes
    ----------
    strategy_id:
        Matches the registry code (e.g. 'envelope_200dma').
    strategy_name:
        Human-readable name (e.g. 'Envelope').
    symbol:
        NSE ticker being evaluated.
    status:
        One of the STATUS_* constants above.
    score:
        Integer score from the strategy's score_map (0 for NO_SIGNAL/INVALID/FAIL).
    reasons:
        Human-readable list of triggers that produced this status.
    metrics_snapshot:
        Dict of the exact numeric values consulted (Decimal in, Decimal out).
        Persisted verbatim to scan_results.metrics_snapshot for audit.
    errors:
        Non-fatal warnings (e.g. missing input field). Empty on clean runs.
    """
    strategy_id: str
    strategy_name: str
    symbol: str
    status: str
    score: int
    reasons: List[str] = field(default_factory=list)
    metrics_snapshot: Dict[str, Any] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "strategy_id": self.strategy_id,
            "strategy_name": self.strategy_name,
            "symbol": self.symbol,
            "status": self.status,
            "score": self.score,
            "reasons": list(self.reasons),
            "metrics_snapshot": dict(self.metrics_snapshot),
            "errors": list(self.errors),
        }


class Strategy(ABC):
    """Abstract base for every scan strategy."""

    @property
    @abstractmethod
    def strategy_id(self) -> str:
        """Registry code — must match strategy_rules.json 'id'."""

    @property
    @abstractmethod
    def strategy_name(self) -> str:
        """Display name."""

    @abstractmethod
    def evaluate(self, snapshot: Dict[str, Any], config: Dict[str, Any]) -> StrategyResult:
        """Return one StrategyResult. Must never raise; on internal failure
        return a result with status=STATUS_ERROR and errors=[...]."""

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _get_decimal(snapshot: Dict[str, Any], key: str) -> Optional[Decimal]:
        """Extract a Decimal value; return None if missing/None."""
        val = snapshot.get(key)
        if val is None:
            return None
        if isinstance(val, Decimal):
            return val
        # Defensive path — snapshot builder should have Decimal already.
        # We do NOT construct from float; raise so it's caught upstream.
        raise TypeError(
            f"snapshot['{key}'] must be Decimal, got {type(val).__name__}"
        )

    @staticmethod
    def _get_bool(snapshot: Dict[str, Any], key: str, default: bool = False) -> bool:
        val = snapshot.get(key)
        if val is None:
            return default
        return bool(val)

    @staticmethod
    def _score_from_map(score_map: Dict[str, Any], status: str) -> int:
        raw = score_map.get(status, 0)
        try:
            return int(raw)
        except (TypeError, ValueError):
            return 0


@dataclass(frozen=True)
class ScanContext:
    """Per-run inputs — passed once, consumed by every strategy invocation.

    Kept as a dataclass so the engine can construct it once from the DB read
    and reuse it across every snapshot in the pool.
    """
    pool_code: str
    snapshot_date: Any                    # datetime.date
    triggered_by: str                     # 'manual' | 'cron' | 'api'
    strategy_configs: Dict[str, Dict[str, Any]]  # strategy_id -> config block
