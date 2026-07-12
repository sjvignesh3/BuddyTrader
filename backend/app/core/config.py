"""
Core configuration - loads strategy_rules.json and provides app-wide settings.
"""
import json
import os
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent.parent  # backend/
PROJECT_ROOT = BASE_DIR.parent  # Buddy/
USERDATA_DIR = PROJECT_ROOT / "UserData"
DATA_DIR = BASE_DIR / "data"

STRATEGY_RULES_PATH = USERDATA_DIR / "strategy_rules.json"
MASTER_CSV_PATH = USERDATA_DIR / "Vicky - Master Template - Master.csv"

# App settings
APP_TITLE = "Buddy - Swing Trading Scanner"
APP_VERSION = "0.1.0"
CORS_ORIGINS = ["*"]  # Allow all for dev

# Yahoo Finance suffix for NSE
NSE_SUFFIX = ".NS"

# Cache settings
PRICE_CACHE_TTL_SECONDS = 3600  # 1 hour


def load_strategy_rules() -> dict:
    """Load the strategy rules JSON configuration."""
    with open(STRATEGY_RULES_PATH, "r") as f:
        return json.load(f)
