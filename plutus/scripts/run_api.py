"""
Boot script for the Plutus read-only API.

Usage
-----
    python -m plutus.scripts.run_api           # dev on :8000
    uvicorn plutus.scripts.run_api:app         # prod / render.yaml

Environment
-----------
    PLUTUS_API_PORT   default 8000
    PLUTUS_API_HOST   default 0.0.0.0
"""
from __future__ import annotations

import os

from plutus.api import create_app

# Uvicorn imports this module and looks for `app` at module level.
app = create_app()


def main() -> None:
    import uvicorn

    host = os.environ.get("PLUTUS_API_HOST", "0.0.0.0")
    port = int(os.environ.get("PLUTUS_API_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
