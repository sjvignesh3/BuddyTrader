"""Environment-driven configuration.

Fail-fast rule: importing this module raises immediately if a REQUIRED
variable is missing. This guarantees a misconfigured worker crashes at
startup rather than partway through a sync writing corrupt rows.

Usage
-----
    from plutus.config import settings
    print(settings.supabase_url)

The module intentionally uses stdlib only (no pydantic) so it can run in
minimal environments (GitHub Actions, tiny Docker images).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


class ConfigError(RuntimeError):
    """Raised when required environment configuration is missing or invalid."""


def _require(key: str) -> str:
    val = os.environ.get(key)
    if val is None or val.strip() == "":
        raise ConfigError(
            f"Missing required environment variable: {key}. "
            "Refer to plutus/.env.example for the full list."
        )
    return val.strip()


def _optional(key: str, default: str) -> str:
    val = os.environ.get(key)
    if val is None or val.strip() == "":
        return default
    return val.strip()


def _int(key: str, default: int) -> int:
    raw = _optional(key, str(default))
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer, got {raw!r}") from exc


@dataclass(frozen=True)
class Settings:
    """Immutable runtime settings.

    Access via the module-level ``settings`` singleton. Never mutate.
    """

    # --- Supabase --------------------------------------------------------
    supabase_url: str
    supabase_service_key: str
    supabase_anon_key: Optional[str]

    # --- yfinance --------------------------------------------------------
    yf_timeout_seconds: int
    yf_max_retries: int
    yf_batch_size: int

    # --- Sync worker -----------------------------------------------------
    sync_batch_size: int
    sync_history_years: int  # How far back to fetch for ATH / DMA / rally.

    # --- Runtime ---------------------------------------------------------
    environment: str  # 'dev' | 'staging' | 'prod'
    log_level: str


def _load() -> Settings:
    """Build the ``Settings`` singleton from the environment.

    Called once at import time. Any missing required value raises
    ``ConfigError`` before Plutus does any work.

    Tests can construct their own ``Settings`` and monkey-patch
    ``plutus.config.settings`` — do not call ``_load`` in tests.
    """
    return Settings(
        supabase_url=_require("PLUTUS_SUPABASE_URL"),
        supabase_service_key=_require("PLUTUS_SUPABASE_SERVICE_KEY"),
        supabase_anon_key=os.environ.get("PLUTUS_SUPABASE_ANON_KEY") or None,
        yf_timeout_seconds=_int("PLUTUS_YF_TIMEOUT_SECONDS", 30),
        yf_max_retries=_int("PLUTUS_YF_MAX_RETRIES", 3),
        yf_batch_size=_int("PLUTUS_YF_BATCH_SIZE", 50),
        sync_batch_size=_int("PLUTUS_SYNC_BATCH_SIZE", 50),
        sync_history_years=_int("PLUTUS_SYNC_HISTORY_YEARS", 5),
        environment=_optional("PLUTUS_ENV", "dev"),
        log_level=_optional("PLUTUS_LOG_LEVEL", "INFO").upper(),
    )


# Lazy singleton — do NOT resolve at import time. Callers explicitly call
# ``get_settings()`` when they need configuration. This lets test code and
# tools (like the seed script running in --dry-run) import ``plutus.*``
# modules without a live Supabase connection.
_cached: Optional[Settings] = None


def get_settings(*, refresh: bool = False) -> Settings:
    """Return the process-wide ``Settings`` singleton.

    Raises ``ConfigError`` if required env vars are missing.
    Pass ``refresh=True`` to re-read the environment (used by tests).
    """
    global _cached
    if _cached is None or refresh:
        _cached = _load()
    return _cached
