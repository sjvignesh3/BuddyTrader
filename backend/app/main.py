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

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

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


@app.get("/")
async def serve_dashboard():
    """Serve the scanner dashboard."""
    return FileResponse(STATIC_DIR / "index.html")
