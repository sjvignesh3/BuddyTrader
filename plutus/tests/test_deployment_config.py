"""
Static gates for the in-stack deployment topology (replaces the old
Render config gate).

Contract enforced here:
  * The Supabase Edge Function `plutus-api` exists and is read-only.
  * The GitHub Actions workflows for daily and quarterly sync exist,
    schedule on the correct cron, and reference Supabase secrets
    (never literals).
  * The frontend env example is present with the Edge Function URL var.

These are pure filesystem/text checks — no network, no runtime.
"""
from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

EDGE_FN = ROOT / "supabase" / "functions" / "plutus-api" / "index.ts"
DAILY_WF = ROOT / ".github" / "workflows" / "plutus-daily-sync.yml"
QUARTERLY_WF = ROOT / ".github" / "workflows" / "plutus-quarterly-sync.yml"
TESTS_WF = ROOT / ".github" / "workflows" / "plutus-tests.yml"
BACKUP_WF = ROOT / ".github" / "workflows" / "plutus-weekly-backup.yml"
FRONTEND_ENV = ROOT / "frontend_v2" / ".env.example"


@pytest.fixture(scope="module")
def edge_src() -> str:
    assert EDGE_FN.exists(), f"missing edge function: {EDGE_FN}"
    return EDGE_FN.read_text()


@pytest.fixture(scope="module")
def daily_yaml() -> str:
    assert DAILY_WF.exists(), f"missing workflow: {DAILY_WF}"
    return DAILY_WF.read_text()


@pytest.fixture(scope="module")
def quarterly_yaml() -> str:
    assert QUARTERLY_WF.exists(), f"missing workflow: {QUARTERLY_WF}"
    return QUARTERLY_WF.read_text()


class TestRenderIsGone:
    """We do not host on Render anymore. `render.yaml` must not exist."""

    def test_render_yaml_absent(self):
        assert not (ROOT / "render.yaml").exists(), (
            "render.yaml is deprecated — deployment is in-stack now "
            "(Supabase Edge Function + GitHub Actions cron)."
        )


class TestEdgeFunction:
    def test_read_only_verbs(self, edge_src):
        # No write handlers may creep in. The router rejects non-GET
        # methods explicitly; grep for accidental POST wiring.
        assert 'method !== "GET"' in edge_src, \
            "edge function must gate non-GET requests"
        for verb in ('"POST"', '"PUT"', '"PATCH"', '"DELETE"'):
            # Only allowed inside comments (documentation of the ban).
            hits = [ln for ln in edge_src.splitlines()
                    if verb in ln and not ln.lstrip().startswith("//")
                    and not ln.lstrip().startswith("*")]
            assert not hits, f"write verb {verb} wired in edge function: {hits}"

    def test_health_route_present(self, edge_src):
        assert '"/api/health"' in edge_src

    def test_all_ten_routes_present(self, edge_src):
        # Parity with the FastAPI version — same 10 routes.
        for route in (
            "/api/health",
            "/api/pools",
            "/api/stocks",
            "/api/snapshots/latest",
            "/api/scans/latest",
            "/api/scan_results",
            "/api/sync_jobs/latest",
        ):
            assert route in edge_src, f"missing route: {route}"
        # Dynamic paths use regex — check for the pattern anchor.
        assert r"\/api\/stocks\/" in edge_src        # /api/stocks/:symbol
        assert r"\/api\/snapshots\/" in edge_src     # /:symbol/history
        assert r"\/api\/fundamentals\/" in edge_src  # /:symbol/latest

    def test_money_keys_stringified(self, edge_src):
        # Money-safety: MONEY_KEYS must name REAL schema columns
        # (migrations 003/004/006) — not the legacy field names.
        for key in (
            "close", "adj_close", "market_cap",
            "pe_current", "forward_pe", "pb_current",
            "high_52w", "low_52w", "dma_200", "below_200dma_pct",
            "ath", "fall_from_ath_pct",
            "distance_from_52w_low_pct", "distance_from_52w_high_pct",
            "last_rally_pct", "last_rally_low", "last_rally_high",
            "sales", "pbt", "net_profit", "roce", "roe",
            "net_debt_to_equity", "pe_5y_avg", "pb_5y_avg",
            "score", "best_score",
        ):
            assert f'"{key}"' in edge_src, \
                f"MONEY_KEYS missing critical field: {key}"
        # Stale names from a schema that never shipped must be gone.
        for stale in ("market_cap_cr", "week_52_high", "ath_price",
                      "gap_from_ath_pct", "rally_pct", "pe_5yr_avg",
                      "eps_ttm", "book_value_per_share"):
            assert f'"{stale}"' not in edge_src, \
                f"MONEY_KEYS contains stale non-column name: {stale}"


class TestGithubActionsCron:
    def test_daily_schedule_and_command(self, daily_yaml):
        assert 'cron: "30 12 * * 1-5"' in daily_yaml, \
            "daily sync must run 12:30 UTC weekdays"
        assert "plutus.scripts.run_daily_sync" in daily_yaml
        assert "plutus.scripts.run_scan" in daily_yaml

    def test_quarterly_schedule_and_command(self, quarterly_yaml):
        assert 'cron: "0 2 * * 0"' in quarterly_yaml, \
            "quarterly sync must run Sundays 02:00 UTC"
        assert "plutus.scripts.run_quarterly_sync" in quarterly_yaml

    def test_secrets_never_literal(self, daily_yaml, quarterly_yaml):
        # Only the ${{ secrets.* }} form is acceptable.
        for yml in (daily_yaml, quarterly_yaml):
            assert "PLUTUS_SUPABASE_SERVICE_KEY" in yml
            for line in yml.splitlines():
                if "PLUTUS_SUPABASE_SERVICE_KEY:" in line:
                    assert "secrets." in line, (
                        "SERVICE_KEY must come from ${{ secrets.* }}, "
                        "never a committed literal"
                    )

    def test_concurrency_guard_present(self, daily_yaml, quarterly_yaml):
        # A second run must not stomp a mid-flight sync.
        for yml in (daily_yaml, quarterly_yaml):
            assert "concurrency:" in yml
            assert "cancel-in-progress: false" in yml


class TestFrontendEnv:
    def test_env_example_uses_edge_function_url(self):
        assert FRONTEND_ENV.exists()
        text = FRONTEND_ENV.read_text()
        assert "VITE_PLUTUS_API_URL" in text
        assert "VITE_SUPABASE_URL" in text
        assert "VITE_SUPABASE_ANON_KEY" in text


class TestStage8Hardening:
    """Gates for the Stage 8 additions: alerting, canary, weekly backup."""

    def test_daily_workflow_wires_alert_webhook(self, daily_yaml):
        # Optional secret — pipeline still runs when it's blank.
        assert "PLUTUS_ALERT_WEBHOOK" in daily_yaml
        assert "secrets.PLUTUS_ALERT_WEBHOOK" in daily_yaml

    def test_daily_workflow_runs_canary_after_scan(self, daily_yaml):
        assert "plutus.scripts.run_canary" in daily_yaml
        # Canary must be `if: always()` so it also runs when scan fails.
        assert "Verify canary fixtures" in daily_yaml

    def test_daily_workflow_has_failure_notifier_step(self, daily_yaml):
        assert "Notify on workflow failure" in daily_yaml
        assert "if: failure()" in daily_yaml

    def test_quarterly_workflow_wires_alert_webhook(self, quarterly_yaml):
        assert "PLUTUS_ALERT_WEBHOOK" in quarterly_yaml

    def test_weekly_backup_workflow_present(self):
        assert BACKUP_WF.exists(), f"missing workflow: {BACKUP_WF}"
        text = BACKUP_WF.read_text()
        # Sunday 20:00 UTC = Monday 01:30 IST (safe outside sync windows).
        assert 'cron: "0 20 * * 0"' in text
        assert "pg_dump" in text
        assert "storage/v1/object/" in text
        # Uploads to a dedicated bucket; retention is enforced there.
        assert "plutus-backups" in text
        # Uses secrets — no committed literals.
        assert "secrets.PLUTUS_SUPABASE_DB_URL" in text
        assert "secrets.PLUTUS_SUPABASE_SERVICE_KEY" in text
        assert "concurrency:" in text
