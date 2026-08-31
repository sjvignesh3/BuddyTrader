// ─────────────────────────────────────────────────────────────────────────────
// Plutus API — Supabase Edge Function (Deno)
//
// This is a faithful TypeScript port of `plutus/api/app.py`. The Python
// FastAPI service is retained for local dev and unit-testing (money-safety
// contract lives there), but production traffic now terminates here.
//
// Contract (identical to the Python version):
//   • READ-ONLY.  No POST/PUT/PATCH/DELETE anywhere.
//   • Every route returns JSON.
//   • Numeric columns arrive from PostgREST as JS `number` OR `string`
//     depending on Postgres type. We normalise money/ratio numerics to
//     strings via `toWire()` so the frontend contract (money-as-string)
//     never breaks.
//   • CORS: GET-only, permissive origin (narrowed via env in Stage 9).
//
// Deploy:
//   supabase functions deploy plutus-api --no-verify-jwt
//   (JWT off because the endpoint is public read-only under RLS.)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// ─── Money-safety wire encoder ──────────────────────────────────────────────
// PostgREST returns NUMERIC as JS number when it fits, which risks precision
// loss. We stringify every value we know is money/ratio. Booleans and
// integers pass through untouched.

// Exact NUMERIC column names from plutus/migrations/003, 004 and 006.
const MONEY_KEYS = new Set<string>([
  "open", "high", "low", "close", "adj_close",
  "market_cap", "pe_current", "forward_pe", "pb_current",
  "debt_to_equity_pct", "ebitda_ttm", "revenue_ttm", "profit_margin_pct",
  "high_52w", "low_52w",
  "dma_200", "below_200dma_pct",
  "ath", "fall_from_ath_pct",
  "distance_from_52w_low_pct", "distance_from_52w_high_pct",
  "last_rally_pct", "last_rally_low", "last_rally_high",
  "price_change_nd_pct",
  "sales", "pbt", "net_profit", "operating_margin_pct",
  "promoter_holding_pct", "institutional_pct", "public_holding_pct",
  "promoter_pledging_pct",
  "roce", "roe", "net_debt_to_equity",
  "pe_5y_avg", "pb_5y_avg",
  "score", "best_score", "duration_seconds",
]);

function toWire(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(toWire);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) { out[k] = null; continue; }
      if (MONEY_KEYS.has(k) && typeof v === "number") {
        // Preserve every digit PostgREST gave us.
        out[k] = String(v);
      } else if (MONEY_KEYS.has(k) && typeof v === "string") {
        out[k] = v;
      } else {
        out[k] = toWire(v);
      }
    }
    return out;
  }
  return value;
}

function serializeRows(rows: unknown[]): unknown[] {
  return rows.map(toWire);
}

// ─── Response helpers ───────────────────────────────────────────────────────

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function error(status: number, detail: string): Response {
  return json({ error: detail }, status);
}

// ─── Supabase client (anon key — RLS-enforced, read-only) ──────────────────
// This is a public read-only endpoint, so we prefer the anon key: RLS
// policies apply and only whitelisted reads succeed. The service-role key
// (which BYPASSES RLS) is used only as a last-resort fallback for
// environments where the anon key is not injected.
function getClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY")
    ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

// ─── Repository (mirrors plutus/api/repository.py 1-for-1) ─────────────────

async function listPools(cli: SupabaseClient) {
  const { data, error: err } = await cli
    .from("pools")
    .select("code,name,description,display_order,strategies,metadata")
    .order("display_order", { ascending: true });
  if (err) throw err;
  return data ?? [];
}

async function listStocks(
  cli: SupabaseClient,
  opts: { pool?: string | null; activeOnly: boolean; limit: number },
) {
  let q = cli.from("stocks").select(
    "id,symbol,name,sector,industry,exchange,active,pools,cap_type_manual,metadata",
  );
  if (opts.activeOnly) q = q.eq("active", true);
  // Filter in the DB (PostgREST `pools=cs.{<pool>}`) BEFORE applying the
  // limit — client-side filtering after `.limit()` would silently drop rows.
  if (opts.pool) q = q.contains("pools", [opts.pool]);
  const { data, error: err } = await q.limit(opts.limit);
  if (err) throw err;
  return data ?? [];
}

async function getStock(cli: SupabaseClient, symbol: string) {
  const { data, error: err } = await cli
    .from("stocks").select("*").eq("symbol", symbol).limit(1);
  if (err) throw err;
  return (data && data[0]) ?? null;
}

async function latestSnapshotDate(cli: SupabaseClient): Promise<string | null> {
  const { data, error: err } = await cli
    .from("daily_snapshots")
    .select("snapshot_date")
    .order("snapshot_date", { ascending: false })
    .limit(1);
  if (err) throw err;
  return (data && data[0]?.snapshot_date) ?? null;
}

async function snapshotsForPool(
  cli: SupabaseClient,
  opts: { pool: string; snapshotDate: string | null; limit: number },
) {
  const stocks = await listStocks(cli,
    { pool: opts.pool, activeOnly: true, limit: 1000 });
  const symbols = stocks.map((s: any) => s.symbol);
  if (symbols.length === 0) return { rows: [], effectiveDate: null };
  const d = opts.snapshotDate ?? await latestSnapshotDate(cli);
  if (!d) return { rows: [], effectiveDate: null };
  const { data, error: err } = await cli
    .from("daily_snapshots")
    .select("*")
    .in("symbol", symbols)
    .eq("snapshot_date", d)
    .limit(opts.limit);
  if (err) throw err;
  return { rows: data ?? [], effectiveDate: d };
}

async function snapshotHistory(
  cli: SupabaseClient, symbol: string, days: number,
) {
  const cap = Math.max(1, Math.min(days, 1000));
  const { data, error: err } = await cli
    .from("daily_snapshots")
    .select("snapshot_date,open,high,low,close,adj_close,volume")
    .eq("symbol", symbol)
    .order("snapshot_date", { ascending: false })
    .limit(cap);
  if (err) throw err;
  return data ?? [];
}

async function latestScan(cli: SupabaseClient, poolCode: string) {
  const { data, error: err } = await cli
    .from("scans").select("*")
    .eq("pool_code", poolCode)
    .order("snapshot_date", { ascending: false })
    .order("started_at", { ascending: false })
    .limit(1);
  if (err) throw err;
  return (data && data[0]) ?? null;
}

async function scanResults(
  cli: SupabaseClient,
  opts: { scanId: string; strategyId?: string | null; statusIn?: string[] | null },
) {
  let q = cli.from("scan_results").select("*").eq("scan_id", opts.scanId);
  if (opts.strategyId) q = q.eq("strategy_id", opts.strategyId);
  if (opts.statusIn && opts.statusIn.length) q = q.in("status", opts.statusIn);
  const { data, error: err } = await q;
  if (err) throw err;
  return data ?? [];
}

async function latestSyncJobs(
  cli: SupabaseClient,
  opts: { jobType?: string | null; limit: number },
) {
  let q = cli.from("sync_jobs").select("*");
  if (opts.jobType) q = q.eq("job_type", opts.jobType);
  const { data, error: err } = await q
    .order("started_at", { ascending: false })
    .limit(opts.limit);
  if (err) throw err;
  return data ?? [];
}

async function latestFundamentals(cli: SupabaseClient, symbol: string) {
  const { data, error: err } = await cli
    .from("fundamentals").select("*")
    .eq("symbol", symbol)
    .order("quarter_end_date", { ascending: false })
    .limit(1);
  if (err) throw err;
  return (data && data[0]) ?? null;
}

// ─── Router ─────────────────────────────────────────────────────────────────
// The handler is reachable under different mount prefixes depending on the
// entry point:
//   local CLI          : /functions/v1/plutus-api/api/...
//   prod functions host: /plutus-api/api/...   (https://<ref>.functions.supabase.co)
//   prod gateway       : /functions/v1/plutus-api/api/...
// Rather than stripping a hard-coded prefix, we locate the first "/api/"
// segment and route on everything from there, so URLs match the FastAPI
// version 1-for-1 in every environment. A pathname with no "/api/" segment
// is treated as the function root (health) when it reduces to "" or
// "/health" after removing the known mount prefixes.

function apiPath(pathname: string): string {
  const idx = pathname.indexOf("/api/");
  if (idx !== -1) return pathname.slice(idx);
  const tail = pathname
    .replace(/^\/functions\/v1(?=\/|$)/, "")
    .replace(/^\/plutus-api(?=\/|$)/, "")
    .replace(/\/+$/, "");
  if (tail === "" || tail === "/health") return "/";
  return pathname; // unknown → falls through to 404 with the original path
}

function intParam(url: URL, key: string, dflt: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return dflt;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function boolParam(url: URL, key: string, dflt: boolean): boolean {
  const raw = url.searchParams.get(key);
  if (raw === null) return dflt;
  return raw === "1" || raw.toLowerCase() === "true";
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return error(405, "read-only API — only GET allowed");
  }

  const url = new URL(req.url);
  const path = apiPath(url.pathname);

  // ── Health (no DB call) ──────────────────────────────────────────────
  if (path === "/api/health" || path === "/") {
    return json({ status: "ok", service: "plutus-api", version: "0.7.0" });
  }

  // Every other route needs a Supabase client.
  let cli: SupabaseClient;
  try { cli = getClient(); } catch (e) {
    return error(500, `client init failed: ${(e as Error).message}`);
  }

  try {
    // ── Pools ────────────────────────────────────────────────────────
    if (path === "/api/pools") {
      const rows = await listPools(cli);
      return json({ pools: serializeRows(rows) });
    }

    // ── Stocks ───────────────────────────────────────────────────────
    if (path === "/api/stocks") {
      const rows = await listStocks(cli, {
        pool: url.searchParams.get("pool"),
        activeOnly: boolParam(url, "active_only", true),
        limit: intParam(url, "limit", 500, 1, 2000),
      });
      return json({ stocks: serializeRows(rows), count: rows.length });
    }

    const stockMatch = path.match(/^\/api\/stocks\/([^/]+)$/);
    if (stockMatch) {
      const row = await getStock(cli, decodeURIComponent(stockMatch[1]));
      if (!row) return error(404, `unknown symbol: ${stockMatch[1]}`);
      return json({ stock: toWire(row) });
    }

    // ── Snapshots ────────────────────────────────────────────────────
    if (path === "/api/snapshots/latest") {
      const pool = url.searchParams.get("pool");
      if (!pool) return error(400, "pool is required");
      const { rows, effectiveDate } = await snapshotsForPool(cli, {
        pool,
        snapshotDate: url.searchParams.get("snapshot_date"),
        limit: intParam(url, "limit", 500, 1, 2000),
      });
      return json({
        pool,
        snapshot_date: effectiveDate,
        snapshots: serializeRows(rows),
        count: rows.length,
      });
    }

    const histMatch = path.match(/^\/api\/snapshots\/([^/]+)\/history$/);
    if (histMatch) {
      const rows = await snapshotHistory(
        cli, decodeURIComponent(histMatch[1]),
        intParam(url, "days", 60, 1, 1000),
      );
      return json({
        symbol: decodeURIComponent(histMatch[1]),
        days: intParam(url, "days", 60, 1, 1000),
        bars: serializeRows(rows),
      });
    }

    // ── Scans ────────────────────────────────────────────────────────
    if (path === "/api/scans/latest") {
      const pool = url.searchParams.get("pool");
      if (!pool) return error(400, "pool is required");
      const row = await latestScan(cli, pool);
      return json({ scan: toWire(row) });
    }

    if (path === "/api/scan_results") {
      const scanId = url.searchParams.get("scan_id");
      if (!scanId) return error(400, "scan_id is required");
      const statusRaw = url.searchParams.get("status");
      const rows = await scanResults(cli, {
        scanId,
        strategyId: url.searchParams.get("strategy_id"),
        statusIn: statusRaw ? statusRaw.split(",").map((s) => s.trim()) : null,
      });
      return json({ scan_id: scanId, results: serializeRows(rows), count: rows.length });
    }

    // ── Sync jobs ────────────────────────────────────────────────────
    if (path === "/api/sync_jobs/latest") {
      const rows = await latestSyncJobs(cli, {
        jobType: url.searchParams.get("job_type"),
        limit: intParam(url, "limit", 10, 1, 100),
      });
      return json({ jobs: serializeRows(rows), count: rows.length });
    }

    // ── Fundamentals ─────────────────────────────────────────────────
    const fundMatch = path.match(/^\/api\/fundamentals\/([^/]+)\/latest$/);
    if (fundMatch) {
      const row = await latestFundamentals(cli, decodeURIComponent(fundMatch[1]));
      if (!row) return error(404, `no fundamentals for ${fundMatch[1]}`);
      return json({ fundamentals: toWire(row) });
    }

    return error(404, `no route: ${path}`);
  } catch (e) {
    console.error("route_failed", { path, err: (e as Error).message });
    return error(502, (e as Error).message ?? "upstream error");
  }
});
