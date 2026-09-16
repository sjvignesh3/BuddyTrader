"""Plutus — persistent, scheduled NSE swing-trading toolkit.

Successor to the legacy Buddy app (removed from the tree on 2026-09-16;
see git history). Built strictly under the guardrails documented in
`Docs/Plutus_Phased_Development.MD`:

* Decimal-only for money/ratio fields.
* Single source of truth: `plutus.registry.fields`.
* Idempotent writes only.
* Fail-fast configuration.

"""

__version__ = "0.1.0-stage1"
