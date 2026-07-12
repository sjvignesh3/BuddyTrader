# 📈 Buddy – Swing Trading Scanner Dashboard

An end-of-day NSE stock scanner that screens the entire universe of listed equities
against configurable swing-trading strategies and displays results in a React dashboard.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Setup Guide](#4-setup-guide)
   - [4.1 Clone the Repository](#41-clone-the-repository)
   - [4.2 Backend Setup](#42-backend-setup)
   - [4.3 Frontend Setup](#43-frontend-setup)
   - [4.4 UserData Configuration](#44-userdata-configuration)
5. [Running the App](#5-running-the-app)
6. [Project Structure](#6-project-structure)
7. [Available Strategies](#7-available-strategies)
8. [Configuration Reference](#8-configuration-reference)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Project Overview

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Backend** | Python · FastAPI · yfinance | Fetches EOD price data, runs strategy scans, exposes REST API |
| **Frontend** | React 18 · Vite | Interactive dashboard – scan controls, results table, strategy matrix |
| **Data Source** | Yahoo Finance (NSE suffix `.NS`) | Free, no API key required |
| **Universe** | `UserData/` CSV | Configurable list of NSE tickers to scan |

---

## 2. Architecture

```
Browser (React)
     │  HTTP  /api/*
     ▼
FastAPI (port 8000)
  ├── /api/scan        ← triggers strategy scan
  ├── /api/strategies  ← list configured strategies
  └── /api/universe    ← ticker universe metadata
     │  yfinance
     ▼
Yahoo Finance (NSE data)
```

---

## 3. Prerequisites

Ensure the following are installed on the target machine before setup.

| Tool | Minimum Version | Check Command |
|------|----------------|---------------|
| **Python** | 3.10+ | `python3 --version` |
| **pip** | 23+ | `pip --version` |
| **Node.js** | 18+ | `node --version` |
| **npm** | 9+ | `npm --version` |
| **Git** | any | `git --version` |

> **Internet access** is required at runtime – the scanner fetches live/EOD price data
> from Yahoo Finance.

---

## 4. Setup Guide

### 4.1 Clone the Repository

```bash
git clone <your-repo-url> Buddy
cd Buddy
```

---

### 4.2 Backend Setup

```bash
# 1 – Move into the backend directory
cd backend

# 2 – Create an isolated Python virtual environment
python3 -m venv .venv

# 3 – Activate it
#   Linux / macOS:
source .venv/bin/activate
#   Windows (Command Prompt):
.venv\Scripts\activate.bat
#   Windows (PowerShell):
.venv\Scripts\Activate.ps1

# 4 – Upgrade pip (recommended)
pip install --upgrade pip

# 5 – Install all Python dependencies
pip install -r requirements.txt

# 6 – Return to the project root
cd ..
```

**Verify the backend works:**

```bash
cd backend
source .venv/bin/activate          # skip if already active
uvicorn app.main:app --reload --port 8000
```

Open [http://localhost:8000/docs](http://localhost:8000/docs) – you should see the
FastAPI Swagger UI.

---

### 4.3 Frontend Setup

Open a **new terminal tab** (keep the backend running).

```bash
# From the project root
cd frontend

# Install Node dependencies
npm install

# Start the Vite dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) – the Buddy dashboard will load.

> **Proxy note:** Vite is configured to proxy all `/api/*` requests to
> `http://localhost:8000`, so no CORS issues during development.

---

### 4.4 UserData Configuration

The `UserData/` folder holds the two files that drive the scanner:

#### `Vicky - Master Template - Master.csv`
The ticker universe – one NSE symbol per row.

| Column | Description |
|--------|-------------|
| `Symbol` | NSE ticker without suffix, e.g. `RELIANCE` |
| `Sector` | (optional) sector label used in pool cards |
| `Industry` | (optional) industry label |

Copy your existing CSV here or use the provided template as a starting point.

#### `strategy_rules.json`
Defines scan parameters for each strategy. Edit thresholds to match your rules.

```jsonc
{
  "week52_high_low": {
    "proximity_pct": 5          // % within 52-week high/low
  },
  "envelope": {
    "period": 20,
    "deviation_pct": 10         // envelope band width
  }
}
```

---

## 5. Running the App

Two terminal sessions are required:

**Terminal 1 – Backend**

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Terminal 2 – Frontend**

```bash
cd frontend
npm run dev
```

| URL | Description |
|-----|-------------|
| `http://localhost:3000` | React dashboard |
| `http://localhost:8000/docs` | FastAPI interactive API docs |
| `http://localhost:8000/redoc` | Alternative API docs |

### Production Build (optional)

```bash
# Build the React app
cd frontend
npm run build
# Compiled files land in frontend/dist/

# Serve everything from FastAPI only (no Node needed)
cd ../backend
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

---

## 6. Project Structure

```
Buddy/
├── backend/
│   ├── app/
│   │   ├── api/
│   │   │   └── routes.py          # All REST endpoints
│   │   ├── core/
│   │   │   ├── config.py          # Paths, constants, strategy rules loader
│   │   │   └── universe.py        # Ticker universe parser
│   │   ├── services/
│   │   │   ├── data_fetcher.py    # yfinance wrapper with caching
│   │   │   ├── metrics_engine.py  # Technical indicator calculations
│   │   │   └── scanner.py         # Orchestrates scans across universe
│   │   ├── strategies/
│   │   │   ├── base.py            # Abstract strategy interface
│   │   │   ├── envelope.py        # Envelope / moving-average strategy
│   │   │   ├── week52_high_low.py # 52-week high/low proximity strategy
│   │   │   └── registry.py        # Strategy registry (name → class)
│   │   └── main.py                # FastAPI app factory
│   ├── data/                      # Runtime cache (git-ignored)
│   └── requirements.txt
│
├── frontend/
│   ├── src/
│   │   ├── components/            # Reusable UI components
│   │   ├── context/               # React context providers
│   │   ├── pages/                 # Route-level page components
│   │   └── services/api.js        # Axios/fetch wrapper for backend
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
│
├── UserData/
│   ├── Vicky - Master Template - Master.csv   # Ticker universe
│   ├── strategy_rules.json                    # Strategy parameters
│   └── Fundamental POinters.md               # Research notes
│
├── Docs/                          # Planning and dev documentation
├── .gitignore
└── README.md
```

---

## 7. Available Strategies

| Strategy ID | Description |
|-------------|-------------|
| `week52_high_low` | Flags stocks within a configurable % of their 52-week high or low |
| `envelope` | Identifies stocks touching upper/lower envelope bands around a moving average |

New strategies can be added by subclassing `strategies/base.py` and registering them
in `strategies/registry.py`.

---

## 8. Configuration Reference

| File | Purpose | Tracked by Git |
|------|---------|---------------|
| `UserData/strategy_rules.json` | Strategy thresholds and parameters | ✅ Yes |
| `UserData/Vicky - Master Template - Master.csv` | Ticker universe | ✅ Yes |
| `backend/app/core/config.py` | Paths, CORS, cache TTL | ✅ Yes |
| `backend/data/` | Runtime price cache | ❌ No (auto-generated) |
| `frontend/.env` | Local env overrides | ❌ No |

---

## 9. Troubleshooting

### `ModuleNotFoundError` on backend start
Virtual environment is not activated. Run:
```bash
source backend/.venv/bin/activate
```

### Port 8000 / 3000 already in use
```bash
# Find and kill the occupying process
lsof -ti:8000 | xargs kill -9
lsof -ti:3000 | xargs kill -9
```

### `yfinance` returns empty data
- Yahoo Finance rate-limits aggressive requests. Wait a few minutes and retry.
- Verify internet connectivity and that NSE market hours don't affect data availability.
- Check ticker symbols include no `.NS` suffix in the CSV (the app appends it automatically).

### Frontend shows `Network Error` / blank results
- Confirm the backend is running on port `8000`.
- Check browser console for CORS errors – ensure `CORS_ORIGINS = ["*"]` is set in
  `backend/app/core/config.py` during development.

### `strategy_rules.json` not found
- Confirm the file exists at `UserData/strategy_rules.json` relative to the project root.
- The path is resolved in `backend/app/core/config.py` (`STRATEGY_RULES_PATH`).

---

> **Docs folder:** See `Docs/DevDoc.MD` for deeper technical decisions and
> `Docs/Plan.MD` for the product roadmap.
