# Plutus Frontend v2

Vite + React 18 + TypeScript + TanStack Query + Tailwind.
Client for the Plutus FastAPI backend (`plutus/api`): read-only market
views plus the personal tools (Journal, Expenses, Position Sizer, Net Worth).

## Money safety

* All monetary and ratio fields arrive from the API as **strings** (Decimal
  preserved). Never coerce to `Number` for computation — only for
  `toLocaleString` at render time. See `src/lib/money.ts`.
* This frontend never writes to Supabase directly. Every read and write
  goes through the FastAPI backend (`VITE_PLUTUS_API_URL`); the Supabase
  anon client is used only for the sync-jobs realtime subscription.

## Dev

```bash
cp .env.example .env.local
npm install
npm run dev            # http://localhost:5173 — calls VITE_PLUTUS_API_URL
```

Start the backend separately:

```bash
python -m plutus.scripts.run_api        # http://127.0.0.1:8000 (PLUTUS_API_PORT to change)
```

## Build

```bash
npm run typecheck
npm run lint
npm run test           # Vitest — pure domain math in src/lib (sizing, net worth)
npm run build
```

Deployment (Vercel + Render + Supabase) is covered in
`Docs/Plutus_Free_Hosting_Guide.md`.

## Layout

```
src/
  components/   Header, StatusPill, LoadError + per-tool folders
                (journal/, expenses/, sizing/, networth/)
  hooks/        usePlutus — TanStack Query wrappers, cache keys
                useJournalCtx — capital + open lots + latest prices, shared by
                the Position Sizer and Net Worth tools
  lib/          api.ts (fetch), money.ts (format only, never math)
                journal.ts / expenses.ts / sizing.ts / networth.ts — pure domain
                math (the *.test.ts files next to them are the Vitest suites)
                journalApi.ts / expensesApi.ts / sizingApi.ts / networthApi.ts —
                the writable personal-tool clients (money as strings)
  pages/        PoolsPage, PoolDetailPage, StockDetailPage, JournalPage,
                ExpensesPage, PositionSizerPage, NetWorthPage, SyncStatusPage
  App.tsx       router
  main.tsx      Query client + StrictMode
```

## Personal tools

| Route | Tool | Data it derives from |
|-------|------|----------------------|
| `/journal` | Trading Journal | `journal_*` tables + `daily_snapshots` |
| `/expenses` | Expense Tracker | `expense*` tables |
| `/position-sizer` | Position Sizer | journal capital + open lots (with `stop_price`), `daily_snapshots`, `sizing_plans` |
| `/net-worth` | Net Worth | journal open lots × latest close (equity), `networth_*` tables, expenses (burn / savings rate) |

The Position Sizer and Net Worth tools never re-implement the journal's
rules: cap-bucket limits, allocation state and portfolio value all come from
`lib/journal.ts`, so every tool agrees on what "over the limit" means.
