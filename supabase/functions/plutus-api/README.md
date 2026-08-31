# plutus-api — Supabase Edge Function

Read-only HTTP API for Plutus. Port of `plutus/api/app.py` (FastAPI) to Deno
so it runs on Supabase's free tier (500K invocations / month) without a
separate host.

## Routes (unchanged from FastAPI version)

| Method | Path                                          | Notes |
|--------|-----------------------------------------------|------|
| GET    | `/api/health`                                 | No DB call. Cheap warm-up ping. |
| GET    | `/api/pools`                                  | All pools, ordered by `display_order`. |
| GET    | `/api/stocks?pool=&active_only=&limit=`       | Optional pool filter. |
| GET    | `/api/stocks/:symbol`                         | 404 on unknown symbol. |
| GET    | `/api/snapshots/latest?pool=&snapshot_date=`  | Auto-picks latest date when omitted. |
| GET    | `/api/snapshots/:symbol/history?days=`        | Newest first, capped at 1000. |
| GET    | `/api/scans/latest?pool=`                     | Latest scan row for a pool. |
| GET    | `/api/scan_results?scan_id=&strategy_id=&status=` | `status` = CSV. |
| GET    | `/api/sync_jobs/latest?job_type=&limit=`      | Header status pill uses this. |
| GET    | `/api/fundamentals/:symbol/latest`            | 404 when no rows exist. |

## Money-safety contract

Same as the FastAPI version:

* Every field in `MONEY_KEYS` is stringified before hitting the wire, so a
  Postgres `NUMERIC(18,6)` never becomes a lossy JS `Number`.
* No write verbs are wired.  The default handler rejects anything that
  isn't `GET`.
* Guarded by `plutus/tests/test_edge_function.py` — grep gates ensure
  no `POST`/`PUT`/`PATCH`/`DELETE` handler creeps in.

## Environment

Set from the Supabase dashboard (`supabase secrets set …`):

```
SUPABASE_URL              # auto-injected in the runtime, but read explicitly
SUPABASE_SERVICE_ROLE_KEY # preferred: full read of RLS-guarded tables
SUPABASE_ANON_KEY         # fallback when service key is not set
```

## Deploy

```bash
supabase functions deploy plutus-api --no-verify-jwt
```

`--no-verify-jwt` is required because the endpoint is public read-only under
RLS. When Stage 8 introduces the trades write path, it will land under a
**separate** function (`plutus-trades`) with JWT verification ON — this
function stays read-only.

## Local invocation

```bash
supabase functions serve plutus-api --env-file .env.local
curl http://localhost:54321/functions/v1/plutus-api/api/health
```
