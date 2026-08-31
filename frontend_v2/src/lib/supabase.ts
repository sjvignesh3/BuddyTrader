// -----------------------------------------------------------------------------
// Supabase browser client — Realtime only.
//
// We do NOT use this client for data reads. All data goes through the
// read-only Edge Function (`lib/api.ts`) so the money-safety contract
// (Decimals-as-strings) is enforced server-side. This client's ONLY job
// is subscribing to Realtime channels — currently just `sync_jobs` for
// the header status pill (Stage 8).
//
// Env vars (must be defined in `frontend_v2/.env`):
//   VITE_SUPABASE_URL       https://<project>.supabase.co
//   VITE_SUPABASE_ANON_KEY  anon JWT
//
// If either is missing the module exports `null` and every consumer falls
// back to polling. This keeps preview builds without secrets functional.
// -----------------------------------------------------------------------------
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null =
  url && anon
    ? createClient(url, anon, {
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 5 } },
      })
    : null;

export const realtimeEnabled = supabase !== null;
