"""Tests for the two-role credential gate in front of the personal tools.

Two layers:
  * token / password / gate primitives — pure functions, no FastAPI needed.
  * route + middleware tests via TestClient with a fake supabase client, so
    the real middleware ordering (CORS outermost, gate inside) and the
    app_access read/write path are both exercised without a database.
"""
from __future__ import annotations

import time

import pytest

from plutus.api import auth
from plutus.api.auth import OWNER, VIEWER


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Every test starts from a known, unconfigured, non-prod environment."""
    monkeypatch.delenv("PLUTUS_APP_PASSWORD", raising=False)
    monkeypatch.delenv("PLUTUS_AUTH_SECRET", raising=False)
    monkeypatch.delenv("PLUTUS_AUTH_TTL_DAYS", raising=False)
    monkeypatch.setenv("PLUTUS_ENV", "dev")
    auth._reset_failures()
    auth.invalidate_viewer_cache()
    yield
    auth._reset_failures()
    auth.invalidate_viewer_cache()


# ---------------------------------------------------------------------------
# Fake supabase client — just enough of app_access for these tests.
# ---------------------------------------------------------------------------
class FakeTable:
    def __init__(self, store, fail=False):
        self._store = store
        self._fail = fail

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        if self._fail:
            raise RuntimeError("supabase down")
        return type("Res", (), {"data": [dict(self._store)] if self._store else []})

    def upsert(self, payload, **_k):
        self._store.clear()
        self._store.update(payload)
        return self


class FakeClient:
    def __init__(self, fail=False):
        self.store: dict = {}
        self._fail = fail

    def table(self, name):
        assert name == "app_access"
        return FakeTable(self.store, self._fail)


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------
class TestPassword:
    def test_unset_password_rejects_everything(self):
        assert auth.is_configured() is False
        assert auth.check_owner_password("") is False
        assert auth.check_owner_password("anything") is False

    def test_owner_exact_match_only(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "s3cret-pass")
        assert auth.check_owner_password("s3cret-pass") is True
        assert auth.check_owner_password("  s3cret-pass  ") is True   # trimmed
        assert auth.check_owner_password("s3cret-Pass") is False      # case
        assert auth.check_owner_password(None) is False
        assert auth.check_owner_password(1234) is False

    def test_viewer_hash_compare(self):
        h = auth.hash_password("SHARE-ME")
        assert auth.check_viewer_password("SHARE-ME", h) is True
        assert auth.check_viewer_password("share-me", h) is False
        assert auth.check_viewer_password("SHARE-ME", None) is False
        assert auth.check_viewer_password("", h) is False
        assert auth.check_viewer_password(None, h) is False

    def test_generated_password_shape(self):
        pw = auth.generate_viewer_password()
        groups = pw.split("-")
        assert len(groups) == 4 and all(len(g) == 4 for g in groups)
        # No ambiguous glyphs — these get misread when shared.
        assert not set("IO01") & set(pw)
        assert auth.generate_viewer_password() != pw   # random each time


class TestToken:
    def test_owner_roundtrip(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        token, exp = auth.issue_token(OWNER)
        assert auth.token_role(token) == OWNER
        assert exp > time.time()

    def test_viewer_roundtrip(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        h = auth.hash_password("VIEW-PASS")
        token, _ = auth.issue_token(VIEWER, h)
        assert auth.token_role(token, h) == VIEWER

    def test_viewer_token_dies_on_rotation(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        old = auth.hash_password("OLD-PASS")
        token, _ = auth.issue_token(VIEWER, old)
        assert auth.token_role(token, old) == VIEWER
        new = auth.hash_password("NEW-PASS")
        assert auth.token_role(token, new) is None

    def test_viewer_token_dead_when_access_disabled(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        h = auth.hash_password("VIEW-PASS")
        token, _ = auth.issue_token(VIEWER, h)
        assert auth.token_role(token, None) is None

    def test_viewer_cannot_forge_owner_role(self, monkeypatch):
        """The role is inside the signature — editing it invalidates it."""
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        h = auth.hash_password("VIEW-PASS")
        token, _ = auth.issue_token(VIEWER, h)
        _, exp, sig = token.split(".")
        assert auth.token_role(f"{OWNER}.{exp}.{sig}", h) is None

    def test_owner_token_needs_no_viewer_hash(self, monkeypatch):
        """Owner must still get in when the database is unreachable."""
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        token, _ = auth.issue_token(OWNER)
        assert auth.token_role(token, None) == OWNER

    def test_expired_token_rejected(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        monkeypatch.setenv("PLUTUS_AUTH_TTL_DAYS", "1")
        token, _ = auth.issue_token(OWNER)
        assert auth.token_role(token, None, now=time.time() + 86400 + 60) is None

    def test_owner_password_rotation_invalidates_tokens(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "old-pw")
        token, _ = auth.issue_token(OWNER)
        assert auth.token_role(token) == OWNER
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "new-pw")
        assert auth.token_role(token) is None

    def test_tampered_signature_rejected(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        token, _ = auth.issue_token(OWNER)
        role, exp, sig = token.split(".")
        assert auth.token_role(f"{role}.{exp}.{'0' * len(sig)}") is None

    def test_extended_expiry_rejected(self, monkeypatch):
        """Bumping exp without re-signing must not buy extra life."""
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        token, exp = auth.issue_token(OWNER)
        role, _, sig = token.split(".")
        assert auth.token_role(f"{role}.{exp + 999999}.{sig}") is None

    def test_garbage_rejected(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        for bad in [None, "", "abc", "a.b", 42, "...", "owner.abc.def",
                    "admin.9999999999.x"]:
            assert auth.token_role(bad) is None


class TestGateDecision:
    def test_protected_prefixes(self):
        assert auth.is_protected("/api/journal/trades") is True
        assert auth.is_protected("/api/expenses") is True
        assert auth.is_protected("/api/sizing/plans") is True
        assert auth.is_protected("/api/networth/assets") is True
        # The trigger keeps its own PLUTUS_ADMIN_TOKEN gate instead.
        assert auth.is_protected("/api/admin/trigger") is False
        assert auth.is_protected("/api/pools") is False
        assert auth.is_protected("/api/health") is False
        assert auth.is_protected("/api/auth/login") is False

    def test_market_data_never_gated(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        assert auth.gate_refusal("/api/pools", "GET", None) is None

    def test_unset_password_open_in_dev(self):
        assert auth.gate_refusal("/api/journal/trades", "POST", None) is None

    def test_unset_password_blocked_in_prod(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_ENV", "prod")
        refusal = auth.gate_refusal("/api/journal/trades", "GET", None)
        assert refusal is not None and refusal[0] == 503

    def test_no_role_is_401(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        assert auth.gate_refusal("/api/journal/trades", "GET", None)[0] == 401

    def test_owner_may_do_everything(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"]:
            assert auth.gate_refusal("/api/journal/trades", method, OWNER) is None

    def test_viewer_may_read(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        for method in ["GET", "HEAD"]:
            assert auth.gate_refusal("/api/journal/trades", method, VIEWER) is None

    def test_viewer_may_not_write(self, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        for method in ["POST", "PUT", "PATCH", "DELETE", "post", "delete"]:
            refusal = auth.gate_refusal("/api/journal/trades", method, VIEWER)
            assert refusal is not None and refusal[0] == 403, method


class TestThrottle:
    def test_opens_after_max_failures(self):
        assert auth._throttled() is False
        for _ in range(auth.MAX_FAILURES):
            auth._record_failure()
        assert auth._throttled() is True

    def test_window_rolls_off(self):
        old = time.time() - auth.FAILURE_WINDOW_SEC - 1
        for _ in range(auth.MAX_FAILURES):
            auth._record_failure(now=old)
        assert auth._throttled() is False

    def test_success_resets(self):
        for _ in range(auth.MAX_FAILURES):
            auth._record_failure()
        auth._reset_failures()
        assert auth._throttled() is False


class TestViewerStorage:
    def test_rotate_stores_hash_not_plaintext(self):
        c = FakeClient()
        out = auth.rotate_viewer_password(c)
        assert out["password"] not in str(c.store)
        assert c.store["viewer_hash"] == auth.hash_password(out["password"])
        assert c.store["viewer_hint"] == out["password"][:4]

    def test_rotate_twice_gives_a_new_password(self):
        c = FakeClient()
        first = auth.rotate_viewer_password(c)["password"]
        second = auth.rotate_viewer_password(c)["password"]
        assert first != second
        assert auth.check_viewer_password(first, c.store["viewer_hash"]) is False

    def test_disable_clears_the_hash(self):
        c = FakeClient()
        auth.rotate_viewer_password(c)
        auth.disable_viewer_access(c)
        assert auth.viewer_hash_of(auth.read_viewer_row(c, force=True)) is None

    def test_unreadable_table_means_access_off(self):
        """An un-applied migration must not lock the owner out."""
        assert auth.read_viewer_row(FakeClient(fail=True), force=True) == {}

    def test_read_is_cached_then_busted_by_rotation(self):
        c = FakeClient()
        auth.rotate_viewer_password(c)
        h1 = auth.viewer_hash_of(auth.read_viewer_row(c))
        auth.rotate_viewer_password(c)      # must invalidate the cache
        h2 = auth.viewer_hash_of(auth.read_viewer_row(c))
        assert h1 != h2


# ---------------------------------------------------------------------------
# Routes + middleware
# ---------------------------------------------------------------------------
fastapi = pytest.importorskip("fastapi")


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from plutus.api.app import create_app

    return TestClient(create_app(supabase_client=FakeClient()))


def _owner_headers(client, password="pw"):
    res = client.post("/api/auth/login", json={"password": password})
    assert res.status_code == 200, res.text
    return {auth.HEADER: res.json()["token"]}


class TestSessionRoutes:
    def test_health_open_without_credential(self, client, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        assert client.get("/api/health").status_code == 200

    def test_status_reports_unconfigured(self, client):
        body = client.get("/api/auth/status").json()
        assert body == {"configured": False, "required": False,
                        "authenticated": True, "role": OWNER}

    def test_status_reports_configured(self, client, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        body = client.get("/api/auth/status").json()
        assert body["configured"] is True
        assert body["required"] is True
        assert body["authenticated"] is False
        assert body["role"] is None

    def test_login_rejects_wrong_password(self, client, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        res = client.post("/api/auth/login", json={"password": "wrong"})
        assert res.status_code == 401
        assert "error" in res.json()          # envelope parity

    def test_owner_login_returns_owner_role(self, client, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        body = client.post("/api/auth/login", json={"password": "pw"}).json()
        assert body["role"] == OWNER
        ok = client.get("/api/auth/verify", headers={auth.HEADER: body["token"]})
        assert ok.json()["role"] == OWNER

    def test_throttle_after_repeated_failures(self, client, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        for _ in range(auth.MAX_FAILURES):
            client.post("/api/auth/login", json={"password": "wrong"})
        assert client.post("/api/auth/login",
                           json={"password": "pw"}).status_code == 429


class TestGatedRoutes:
    def test_personal_route_blocked_without_token(self, client, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        for path in ["/api/journal/settings", "/api/expenses/categories",
                     "/api/sizing/plans", "/api/networth/settings"]:
            res = client.get(path)
            assert res.status_code == 401, path
            assert res.json()["error"] == "sign in required"

    def test_personal_write_blocked_without_token(self, client, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        res = client.post("/api/journal/trades", json={"symbol": "TCS.NS"})
        assert res.status_code == 401

    def test_gated_401_carries_cors_headers(self, client, monkeypatch):
        """Without these the browser sees a network error, not a 401."""
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        res = client.get("/api/journal/settings",
                         headers={"Origin": "https://plutus.example"})
        assert res.status_code == 401
        assert res.headers.get("access-control-allow-origin") == "*"


class TestViewerRole:
    """End-to-end: owner rotates, viewer signs in, viewer cannot write."""

    def _viewer_headers(self, client, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        owner = _owner_headers(client)
        pw = client.post("/api/auth/viewer/rotate",
                         headers=owner).json()["password"]
        res = client.post("/api/auth/login", json={"password": pw})
        assert res.status_code == 200
        assert res.json()["role"] == VIEWER
        return {auth.HEADER: res.json()["token"]}, pw, owner

    def test_viewer_can_read_every_tool(self, client, monkeypatch):
        headers, _, _ = self._viewer_headers(client, monkeypatch)
        for path in ["/api/journal/settings", "/api/expenses/categories",
                     "/api/sizing/plans", "/api/networth/settings"]:
            # 200 or a downstream 502 from the fake client — never 401/403.
            assert client.get(path, headers=headers).status_code not in (401, 403), path

    def test_viewer_write_is_403_on_every_tool(self, client, monkeypatch):
        headers, _, _ = self._viewer_headers(client, monkeypatch)
        calls = [
            ("post", "/api/journal/trades"),
            ("put", "/api/journal/settings"),
            ("delete", "/api/journal/trades/1"),
            ("post", "/api/expenses"),
            ("delete", "/api/expenses/1"),
            ("post", "/api/sizing/plans"),
            ("delete", "/api/sizing/plans/1"),
            ("post", "/api/networth/assets"),
            ("put", "/api/networth/settings"),
            ("delete", "/api/networth/assets/1"),
        ]
        for method, path in calls:
            # client.delete() takes no json= in this httpx version; .request does.
            res = client.request(method.upper(), path, json={})
            assert res.status_code == 401, f"{method} {path} unauthenticated"
            res = client.request(method.upper(), path, json={}, headers=headers)
            assert res.status_code == 403, f"{method} {path}"
            assert "view-only" in res.json()["error"]

    def test_viewer_cannot_rotate_or_disable(self, client, monkeypatch):
        headers, _, _ = self._viewer_headers(client, monkeypatch)
        assert client.post("/api/auth/viewer/rotate",
                           headers=headers).status_code == 403
        assert client.delete("/api/auth/viewer",
                             headers=headers).status_code == 403
        assert client.get("/api/auth/viewer",
                          headers=headers).status_code == 403

    def test_anonymous_cannot_rotate(self, client, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        assert client.post("/api/auth/viewer/rotate").status_code == 403

    def test_rotation_revokes_the_old_viewer_session(self, client, monkeypatch):
        headers, old_pw, owner = self._viewer_headers(client, monkeypatch)
        assert client.get("/api/journal/settings",
                          headers=headers).status_code != 401
        client.post("/api/auth/viewer/rotate", headers=owner)
        assert client.get("/api/journal/settings",
                          headers=headers).status_code == 401
        # ...and the shared password itself stops working.
        assert client.post("/api/auth/login",
                           json={"password": old_pw}).status_code == 401

    def test_disable_revokes_viewer_access(self, client, monkeypatch):
        headers, pw, owner = self._viewer_headers(client, monkeypatch)
        client.delete("/api/auth/viewer", headers=owner)
        assert client.get("/api/journal/settings",
                          headers=headers).status_code == 401
        assert client.post("/api/auth/login",
                           json={"password": pw}).status_code == 401

    def test_owner_state_shows_hint_never_password(self, client, monkeypatch):
        monkeypatch.setenv("PLUTUS_APP_PASSWORD", "pw")
        owner = _owner_headers(client)
        assert client.get("/api/auth/viewer",
                          headers=owner).json()["enabled"] is False
        rotated = client.post("/api/auth/viewer/rotate", headers=owner).json()
        state = client.get("/api/auth/viewer", headers=owner).json()
        assert state["enabled"] is True
        assert state["hint"] == rotated["password"][:4]
        assert rotated["password"] not in str(state)
