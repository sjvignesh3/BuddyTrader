"""
Buddy Scanner - FastAPI Application Entry Point
"""
import logging
from pathlib import Path

# ── Load .env FIRST — before any other imports read os.environ ──────────────
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")   # backend/.env
# ─────────────────────────────────────────────────────────────────────────────

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .core.config import APP_TITLE, APP_VERSION, CORS_ORIGINS
from .api.routes import router
from .services.screener_data_fetcher import _login, _get_credentials
import threading

# Mangum wraps FastAPI for Vercel/AWS Lambda serverless environments
try:
    from mangum import Mangum
    _mangum_available = True
except ImportError:
    _mangum_available = False

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(
    title=APP_TITLE,
    version=APP_VERSION,
    description="NSE End-of-Day Stock Scanner Dashboard",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routes
app.include_router(router, prefix="/api")

# Static files directory
STATIC_DIR = Path(__file__).parent / "static"


@app.on_event("startup")
async def startup_event():
    """Kick off screener.in login in a background thread so the event loop is never blocked."""
    email, password = _get_credentials()
    if email and password:
        def _bg_login():
            logger.info("Background login started for %s", email)
            ok = _login()
            logger.info("Background login %s for %s", "SUCCEEDED" if ok else "FAILED", email)
        t = threading.Thread(target=_bg_login, daemon=True, name="screener-login")
        t.start()
    else:
        logger.info("Screener credentials not configured — running in public-only mode")


@app.get("/")
async def serve_dashboard():
    """Serve the scanner dashboard."""
    return FileResponse(STATIC_DIR / "index.html")


# Vercel / AWS Lambda handler — Mangum bridges ASGI ↔ serverless
handler = Mangum(app, lifespan="off") if _mangum_available else None
