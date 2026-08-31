# Deploying `frontend_v2`

The old Render `plutus-frontend` service is gone. Deploy the built
static bundle to any free-tier CDN. Two supported targets:

## Cloudflare Pages (recommended — unlimited requests on free tier)

1. Push repo to GitHub.
2. In Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Build settings:
   * **Build command:** `npm install && npm run build`
   * **Build output directory:** `dist`
   * **Root directory:** `frontend_v2`
4. Environment variables (Production + Preview):
   * `VITE_PLUTUS_API_URL` = `https://<project-ref>.functions.supabase.co/plutus-api`
   * `VITE_SUPABASE_URL` = your Supabase project URL
   * `VITE_SUPABASE_ANON_KEY` = your Supabase anon key
5. SPA fallback is handled by `public/_redirects` (already in repo).

## Vercel (alternative — 100 GB bandwidth / month free)

1. Import repo → set **Root Directory** to `frontend_v2`.
2. Framework preset auto-detects Vite.
3. Same three env vars as above.
4. `vercel.json` is not required — the default Vite preset already
   rewrites all routes to `index.html`.

## Local preview

```bash
cd frontend_v2
cp .env.example .env.local           # then edit
npm install
npm run dev                            # http://localhost:5173
# ...or, after building:
npm run preview                        # http://localhost:4173
```

## Sanity check after deploy

```bash
curl "$VITE_PLUTUS_API_URL/api/health"
# → {"status":"ok","service":"plutus-api","version":"0.7.0"}
```

If health returns 200 but the pools tab is empty, the Edge Function is
reaching Supabase but `pools` is empty — seed the universe first
(`python -m plutus.scripts.seed_universe --csv ...`).
