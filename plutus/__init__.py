"""Plutus — persistent, scheduled NSE swing-trading toolkit.

This package is the successor to the legacy `backend/` app (Buddy). It is
built strictly under the guardrails documented in
`Docs/Plutus_Phased_Development.MD`:

* Decimal-only for money/ratio fields.
* Single source of truth: `plutus.registry.fields`.
* Idempotent writes only.
* Fail-fast configuration.

The legacy Buddy app is not modified — it keeps running in `backend/`.
"""

__version__ = "0.1.0-stage1"
