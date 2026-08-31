# Plutus Frontend v2

Vite + React 18 + TypeScript + TanStack Query + Tailwind.
Read-only client for the Plutus FastAPI backend.

## Money safety

* All monetary and ratio fields arrive from the API as **strings** (Decimal
  preserved). Never coerce to `Number` for computation — only for
  `toLocaleString` at render time. See `src/lib/money.ts`.
* This frontend never calls Supabase directly for writes. It reads through
  `plutus-api` which enforces RLS. Trades UI (Stage 8) will use the anon
  Supabase client under RLS auth.

## Dev

```bash
cp .env.example .env.local
npm install
npm run dev            # http://localhost:5173 — proxies /api → :8000
```

Start the backend separately:

```bash
uvicorn plutus.scripts.run_api:app --reload --port 8000
```

## Build

```bash
npm run typecheck
npm run build
```

## Layout

```
src/
  components/   Header, StatusPill, LoadError
  hooks/        usePlutus — TanStack Query wrappers, cache keys
  lib/          api.ts (fetch), money.ts (format only, never math)
  pages/        PoolsPage, PoolDetailPage, SyncStatusPage
  App.tsx       router
  main.tsx      Query client + StrictMode
```
