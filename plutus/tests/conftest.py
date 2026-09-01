"""Shared test configuration.

Deterministic-tests rule: the suite must never touch the network. Strip the
Screener.in credentials for every test so nothing can accidentally attempt
a live login — worker tests inject fake fetchers, and the pre-flight login
only runs for the default (live) fetcher anyway.
"""
import pytest


@pytest.fixture(autouse=True)
def _no_network_credentials(monkeypatch):
    monkeypatch.delenv("SCREENER_EMAIL", raising=False)
    monkeypatch.delenv("SCREENER_PASSWORD", raising=False)
    # Also strip Supabase creds and block plutus/.env loading — a developer
    # machine may have a LIVE local stack running, and default fetchers/
    # loaders must fail fast (returning {}/errors) instead of touching it.
    monkeypatch.delenv("PLUTUS_SUPABASE_URL", raising=False)
    monkeypatch.delenv("PLUTUS_SUPABASE_SERVICE_KEY", raising=False)
    monkeypatch.setenv("PLUTUS_SKIP_DOTENV", "1")
    # Reset config + client singletons so no cached live client leaks in.
    import plutus.config as _config
    _config._cached = None
    from plutus.adapters import supabase_client as _sb
    _sb.reset_client()
    yield
    _config._cached = None
    _sb.reset_client()
