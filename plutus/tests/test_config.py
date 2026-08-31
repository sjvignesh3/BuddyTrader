"""Tests for plutus.config -- fail-fast environment loading."""

import importlib

import pytest

import plutus.config as config


REQUIRED_KEYS = ("PLUTUS_SUPABASE_URL", "PLUTUS_SUPABASE_SERVICE_KEY")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Strip every PLUTUS_* var before each test."""
    for k in list(os_environ_snapshot()):
        if k.startswith("PLUTUS_"):
            monkeypatch.delenv(k, raising=False)
    # A developer machine may carry a real plutus/.env — these tests assert
    # behaviour of the ENVIRONMENT alone, so disable dotenv loading.
    monkeypatch.setenv("PLUTUS_SKIP_DOTENV", "1")
    # Reset the module-level cache so ``get_settings`` re-reads.
    config._cached = None
    yield
    config._cached = None


def os_environ_snapshot():
    import os
    return dict(os.environ)


def test_missing_supabase_url_raises(monkeypatch):
    monkeypatch.setenv("PLUTUS_SUPABASE_SERVICE_KEY", "svc")
    with pytest.raises(config.ConfigError) as exc:
        config.get_settings(refresh=True)
    assert "PLUTUS_SUPABASE_URL" in str(exc.value)


def test_missing_service_key_raises(monkeypatch):
    monkeypatch.setenv("PLUTUS_SUPABASE_URL", "https://x.supabase.co")
    with pytest.raises(config.ConfigError) as exc:
        config.get_settings(refresh=True)
    assert "PLUTUS_SUPABASE_SERVICE_KEY" in str(exc.value)


def test_blank_value_treated_as_missing(monkeypatch):
    monkeypatch.setenv("PLUTUS_SUPABASE_URL", "   ")
    monkeypatch.setenv("PLUTUS_SUPABASE_SERVICE_KEY", "svc")
    with pytest.raises(config.ConfigError):
        config.get_settings(refresh=True)


def test_valid_env_loads(monkeypatch):
    monkeypatch.setenv("PLUTUS_SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("PLUTUS_SUPABASE_SERVICE_KEY", "svc")
    s = config.get_settings(refresh=True)
    assert s.supabase_url == "https://x.supabase.co"
    assert s.supabase_service_key == "svc"
    assert s.yf_timeout_seconds == 30  # default
    assert s.yf_max_retries == 3
    assert s.sync_history_years == 5
    assert s.environment == "dev"


def test_int_parse_error(monkeypatch):
    monkeypatch.setenv("PLUTUS_SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("PLUTUS_SUPABASE_SERVICE_KEY", "svc")
    monkeypatch.setenv("PLUTUS_YF_TIMEOUT_SECONDS", "abc")
    with pytest.raises(config.ConfigError):
        config.get_settings(refresh=True)


def test_singleton_caches(monkeypatch):
    monkeypatch.setenv("PLUTUS_SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("PLUTUS_SUPABASE_SERVICE_KEY", "svc")
    a = config.get_settings(refresh=True)
    b = config.get_settings()
    assert a is b
