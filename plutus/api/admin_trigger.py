"""
On-demand GitHub Actions trigger — /api/admin/trigger*.

The scheduled workflows stay authoritative for the daily / weekly /
quarterly cadence. These routes exist so the frontend Sync tab can kick
the SAME workflows on demand (pool- or symbol-scoped) without visiting
github.com and hand-sequencing runs. The workflow itself does the
sequencing (the daily workflow chains sync → scan internally).

Security model:
  * The GitHub PAT (PLUTUS_GITHUB_TOKEN) lives server-side only — it is
    never sent to, or readable by, the browser.
  * Callers must present ``X-Plutus-Admin-Token`` matching the
    PLUTUS_ADMIN_TOKEN env var.
      - token set               → header must match (constant-time compare).
      - token unset, non-prod   → allowed (local dev convenience).
      - token unset, prod       → 503: trigger explicitly not configured.
  * Workflow keys and pool codes are allowlisted; symbols are validated
    against the NSE/BSE ticker shape before they reach the dispatch API.

No DB writes happen here — the market-data API stays read-only; this
module only talks to the GitHub REST API.

NOTE: no ``from __future__ import annotations`` here — FastAPI must
resolve the ``Request`` annotation of routes defined inside
``register_admin_trigger_routes`` (a local import), which stringified
annotations would break.
"""
import hmac
import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Workflow key → workflow file under .github/workflows/.
WORKFLOWS: Dict[str, str] = {
    "daily": "plutus-daily-sync.yml",         # OHLCV + snapshot + scan
    "quarterly": "plutus-quarterly-sync.yml",  # Screener fundamentals
    "ratios": "plutus-weekly-ratios.yml",      # Screener PE / PB / MCap
}

POOLS = {"F40", "E40", "S200", "PlayArea"}
_SYMBOL_RE = re.compile(r"^[A-Z0-9&\-]{1,20}\.(NS|BO)$")
MAX_SYMBOLS = 50

_GH_API = "https://api.github.com"


# ---------------------------------------------------------------------------
# Config / auth helpers — env is read per-request (not cached) so Render
# env edits apply on restart without code changes; direct os.environ access
# avoids plutus.config's fail-fast Supabase requirements in test envs.
# ---------------------------------------------------------------------------
def _gh_config() -> Tuple[str, str, str]:
    token = os.environ.get("PLUTUS_GITHUB_TOKEN", "").strip()
    repo = os.environ.get("PLUTUS_GITHUB_REPO", "").strip()
    ref = os.environ.get("PLUTUS_GITHUB_REF", "").strip() or "main"
    return token, repo, ref


def _is_configured() -> bool:
    token, repo, _ = _gh_config()
    return bool(token and repo)


def _env() -> str:
    return os.environ.get("PLUTUS_ENV", "dev").strip() or "dev"


def _github_request(
    method: str,
    url: str,
    token: str,
    payload: Optional[dict] = None,
) -> Tuple[int, Any]:
    """Single seam to the GitHub REST API — monkeypatched in tests."""
    import requests

    res = requests.request(
        method,
        url,
        json=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=20,
    )
    try:
        body = res.json() if res.content else None
    except ValueError:
        body = None
    return res.status_code, body


# ---------------------------------------------------------------------------
# Request validation (framework-free — unit-testable without FastAPI)
# ---------------------------------------------------------------------------
def validate_trigger_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalise a trigger request.

    Returns {"workflow": key, "inputs": {...}} or raises ValueError with a
    user-facing message.
    """
    workflow = str(payload.get("workflow", "")).strip()
    if workflow not in WORKFLOWS:
        raise ValueError(
            f"unknown workflow {workflow!r} — expected one of "
            f"{sorted(WORKFLOWS)}")

    pool = str(payload.get("pool") or "").strip()
    if pool.upper() == "ALL":
        pool = ""          # blank means ALL in every sync CLI
    if pool and pool not in POOLS:
        raise ValueError(
            f"unknown pool {pool!r} — expected one of {sorted(POOLS)} or ALL")

    raw_symbols = payload.get("symbols") or []
    if not isinstance(raw_symbols, list):
        raise ValueError("symbols must be a list of tickers")
    symbols: List[str] = []
    bad: List[str] = []
    for s in raw_symbols:
        t = str(s).strip().upper()
        if not t:
            continue
        if _SYMBOL_RE.match(t):
            if t not in symbols:
                symbols.append(t)
        else:
            bad.append(str(s))
    if bad:
        raise ValueError(f"invalid symbols (want e.g. TCS.NS): {bad[:5]}")
    if len(symbols) > MAX_SYMBOLS:
        raise ValueError(f"too many symbols ({len(symbols)} > {MAX_SYMBOLS})")

    inputs: Dict[str, str] = {}
    if symbols:
        inputs["symbols"] = ",".join(symbols)
    if pool:
        inputs["pool"] = pool
    if payload.get("dry_run"):
        inputs["dry_run"] = "true"

    limit = payload.get("limit")
    if limit is not None and str(limit).strip() != "":
        try:
            n = int(str(limit))
        except ValueError:
            raise ValueError("limit must be an integer")
        if not 1 <= n <= 2000:
            raise ValueError("limit must be between 1 and 2000")
        inputs["limit"] = str(n)

    return {"workflow": workflow, "inputs": inputs}


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------
def register_admin_trigger_routes(app: Any) -> None:
    """Mount /api/admin/trigger* on the given FastAPI app."""
    from fastapi import Body, HTTPException, Query, Request

    def check_auth(request: Request) -> None:
        expected = os.environ.get("PLUTUS_ADMIN_TOKEN", "").strip()
        if not expected:
            if _env() == "prod":
                raise HTTPException(
                    status_code=503,
                    detail="on-demand trigger disabled — set "
                           "PLUTUS_ADMIN_TOKEN on the API service")
            return  # local dev without a token — allow
        supplied = request.headers.get("x-plutus-admin-token", "")
        if not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="bad admin token")

    def require_gh() -> Tuple[str, str, str]:
        token, repo, ref = _gh_config()
        if not token or not repo:
            raise HTTPException(
                status_code=503,
                detail="GitHub trigger not configured — set "
                       "PLUTUS_GITHUB_TOKEN and PLUTUS_GITHUB_REPO "
                       "(owner/repo) on the API service")
        return token, repo, ref

    @app.get("/api/admin/trigger/status")
    def trigger_status() -> dict:
        """Unauthenticated capability probe for the frontend Sync tab."""
        expected = os.environ.get("PLUTUS_ADMIN_TOKEN", "").strip()
        return {
            "configured": _is_configured(),
            "auth_required": bool(expected) or _env() == "prod",
            "workflows": sorted(WORKFLOWS),
            "pools": sorted(POOLS),
        }

    @app.post("/api/admin/trigger")
    def trigger_workflow(request: Request, payload: dict = Body(...)) -> dict:
        check_auth(request)
        token, repo, ref = require_gh()
        try:
            req = validate_trigger_payload(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        fname = WORKFLOWS[req["workflow"]]
        url = f"{_GH_API}/repos/{repo}/actions/workflows/{fname}/dispatches"
        try:
            status, body = _github_request(
                "POST", url, token, {"ref": ref, "inputs": req["inputs"]})
        except Exception as exc:  # noqa: BLE001 — network seam
            logger.exception("workflow dispatch failed: %s", fname)
            raise HTTPException(status_code=502,
                                detail=f"GitHub unreachable: {exc}")

        if status != 204:
            msg = (body or {}).get("message") if isinstance(body, dict) else None
            logger.error("dispatch rejected: %s %s %s", fname, status, msg)
            raise HTTPException(
                status_code=502,
                detail=f"GitHub dispatch failed ({status}): "
                       f"{msg or 'see API logs'}")

        return {
            "queued": True,
            "workflow": req["workflow"],
            "file": fname,
            "inputs": req["inputs"],
            "runs_url": f"https://github.com/{repo}/actions/workflows/{fname}",
            "note": "queued on GitHub — the run appears in the jobs table "
                    "below once it starts writing",
        }

    @app.get("/api/admin/trigger/runs")
    def trigger_runs(
        request: Request,
        workflow: str = Query(...),
        limit: int = Query(5, ge=1, le=20),
    ) -> dict:
        check_auth(request)
        token, repo, _ = require_gh()
        if workflow not in WORKFLOWS:
            raise HTTPException(status_code=400,
                                detail=f"unknown workflow {workflow!r}")
        fname = WORKFLOWS[workflow]
        url = (f"{_GH_API}/repos/{repo}/actions/workflows/{fname}"
               f"/runs?per_page={limit}")
        try:
            status, body = _github_request("GET", url, token)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502,
                                detail=f"GitHub unreachable: {exc}")
        if status != 200 or not isinstance(body, dict):
            raise HTTPException(status_code=502,
                                detail=f"GitHub runs query failed ({status})")
        runs = [
            {
                "id": r.get("id"),
                "run_number": r.get("run_number"),
                "status": r.get("status"),
                "conclusion": r.get("conclusion"),
                "event": r.get("event"),
                "created_at": r.get("created_at"),
                "html_url": r.get("html_url"),
            }
            for r in body.get("workflow_runs", [])
        ]
        return {"workflow": workflow, "runs": runs, "count": len(runs)}
