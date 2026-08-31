"""
Plutus read-only REST API — Stage 7.

Serves data from Supabase to the frontend. Never writes.
"""
from plutus.api.app import create_app

__all__ = ["create_app"]
