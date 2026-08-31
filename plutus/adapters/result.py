"""
Result monad — per-symbol success/failure isolation.

Every network-touching function in the adapters returns a Result[T] so a single
failed symbol never breaks a batch and callers must consciously handle failure.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Generic, Optional, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class Result(Generic[T]):
    """
    Immutable success/failure envelope.

    Success:  Result(ok=True, value=..., error=None)
    Failure:  Result(ok=False, value=None, error="reason string")

    Callers MUST check `.ok` before touching `.value`.
    """

    ok: bool
    value: Optional[T] = None
    error: Optional[str] = None
    symbol: Optional[str] = None
    attempts: int = 1
    latency_ms: int = 0

    @classmethod
    def success(cls, value: T, symbol: Optional[str] = None,
                attempts: int = 1, latency_ms: int = 0) -> "Result[T]":
        return cls(ok=True, value=value, symbol=symbol,
                   attempts=attempts, latency_ms=latency_ms)

    @classmethod
    def failure(cls, error: str, symbol: Optional[str] = None,
                attempts: int = 1, latency_ms: int = 0) -> "Result[T]":
        return cls(ok=False, error=error, symbol=symbol,
                   attempts=attempts, latency_ms=latency_ms)

    def unwrap(self) -> T:
        """Raise if failure; otherwise return the value. Use sparingly."""
        if not self.ok:
            raise RuntimeError(f"Result was failure: {self.error}")
        return self.value  # type: ignore[return-value]
