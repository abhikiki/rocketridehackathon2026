# AI Error-Handling Pipeline — architecture

A deliberately-buggy Vercel app (`victim-app/`) reports errors; a fast,
deterministic dedupe/suppression gate runs in Postgres before anything
touches an LLM; genuinely new errors get correlated by Claude, filed as
GitHub issues, and auto-fixed by an AI-generated PR that, once merged,
redeploys the victim app and closes the loop. A dashboard (`dashboard/`)
shows live incident state via Supabase Realtime.

Three RocketRide pipelines, split across two build tracks:

- **Track A (this repo's `victim-app/`, `supabase/`,
  `rocketride/correlation-engine.pipe`, `dashboard/`)**: ingestion +
  correlation. Owns the Supabase schema.
- **Track B** (`track-b-relay/`, `rocketride/incident-management.pipe`,
  `rocketride/alert-solving.pipe`): Pipeline 2 creates/reopens/closes the
  GitHub issue; Pipeline 3 generates the fix PR and reports resolution only
  after merge. The relay exposes the authenticated HTTP endpoints and the
  shared schema includes `pr_url`.

## Deviations from the original design doc

The original design assumed RocketRide exposes public HTTP webhook URLs
and that `db_supabase`'s raw-SQL execute path was safe to build a
race-critical dedupe gate on. Neither holds — see
`rocketride/README.md` for the full reasoning. Net effect:

- The atomic fingerprint upsert (the actual duplicate-suppression logic)
  runs as plain Postgres from `victim-app`'s own server-side error
  handler, not inside RocketRide. On an exact-fingerprint duplicate, no
  RocketRide connection is opened at all.
- Pipeline 1 → Pipeline 2 hand-off is a plain HTTP call made by
  `victim-app`, not an in-pipeline agent+tool call.

## Supabase schema

See `supabase/schema.sql`: `incidents` (one open row per fingerprint,
enforced by a partial unique index) and `alerts` (audit log, FK to
`incidents`). RLS is enabled on `incidents` with a public-read policy so
the dashboard can use the Supabase anon key directly.

## Secrets — where each one lives (names only, no values here)

| Secret | Lives in |
|---|---|
| `ROCKETRIDE_OPENAI_KEY` | `.pipe` file config, set via the RocketRide extension's `.env` (server-side, not `victim-app`); must keep the `ROCKETRIDE_` prefix — the SDK only substitutes `${ROCKETRIDE_*}` template variables into pipeline configs |
| `SUPABASE_POOLER_URL` | Vercel env var on `victim-app` (server-side Postgres access) |
| `ROCKETRIDE_URI` / `ROCKETRIDE_APIKEY` | Vercel env var on `victim-app`, extension-managed |
| `PIPELINE2_RELAY_URL` / `PIPELINE2_RELAY_KEY` | Vercel env var on `victim-app`, provided by Track B |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel env var on `dashboard` (public, read-only via RLS) |
| `ROCKETRIDE_GITHUB_TOKEN`, Supabase pooler fields | Track B relay Vercel env; substituted into Pipeline 2/3 configs when the task starts |
| `GITHUB_WEBHOOK_SECRET` | Track B relay Vercel env; validates `/api/github` requests before RocketRide sees them |
| `PIPELINE2_RELAY_KEY` / `ROCKETRIDE_INCIDENT_WEBHOOK_KEY` | Track B relay Vercel env; set to the same random internal value |

No live credential values are ever committed; see each app's
`.env.example`.
