"""
Core configuration - loads strategy_rules.json and provides app-wide settings.
"""
import json
import os
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent.parent  # backend/
PROJECT_ROOT = BASE_DIR.parent  # Buddy/

# On Vercel, UserData is deployed alongside the backend inside backend/UserData/
# because Vercel only packages files within the Root Directory (backend/).
# Locally, UserData lives at the project root.
_userdata_in_backend = BASE_DIR / "UserData"
_userdata_in_project = PROJECT_ROOT / "UserData"
USERDATA_DIR = _userdata_in_backend if _userdata_in_backend.exists() else _userdata_in_project

DATA_DIR = BASE_DIR / "data"

STRATEGY_RULES_PATH = USERDATA_DIR / "strategy_rules.json"
MASTER_CSV_PATH = USERDATA_DIR / "Vicky - Master Template - Master.csv"

# App settings
APP_TITLE = "Buddy - Swing Trading Scanner"
APP_VERSION = "0.1.0"

# CORS: allow frontend Render URL + localhost for dev.
# Set FRONTEND_URL env var on Render to your frontend's deployment URL.
# e.g. https://buddy-frontend.onrender.com
_frontend_url = os.getenv("FRONTEND_URL", "")
CORS_ORIGINS = (
    [_frontend_url, "http://localhost:3000", "http://127.0.0.1:3000"]
    if _frontend_url
    else ["*"]  # Allow all in local dev
)

# Yahoo Finance suffix for NSE
NSE_SUFFIX = ".NS"

# Cache settings
PRICE_CACHE_TTL_SECONDS = 3600  # 1 hour


def load_strategy_rules() -> dict:
    """Load the strategy rules JSON configuration."""
    with open(STRATEGY_RULES_PATH, "r") as f:
        return json.load(f)
