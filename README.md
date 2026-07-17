# Self-Healing Error Pipeline

**Team:** The Auto-fixers

When this app crashes, it fixes itself.

A small demo app is seeded with a real bug. When a user hits it, the
error doesn't just get logged and forgotten — it flows through a
pipeline that figures out whether this is a new problem or one it's
already seen, files a GitHub issue for genuinely new errors, writes a
fix, opens a pull request, and closes the loop once that PR is merged
and deployed. A live dashboard shows every incident as it happens.

## How it works

1. **Something breaks.** The demo app hits its seeded bug and throws an
   error.
2. **Instant dedupe.** Before anything else happens, the error is
   fingerprinted and checked against open incidents in the database.
   If it's the same error happening again, it's just counted — nothing
   further happens. No AI call, no new ticket, no noise.
3. **AI correlation.** If it's a genuinely new fingerprint, an OpenAI
   model looks at it alongside other recently-open incidents to decide
   whether it's actually a new problem or a variant of something
   already being tracked.
4. **Issue filed.** A new incident opens a GitHub issue automatically,
   with the error details attached.
5. **AI writes the fix.** An OpenAI-powered agent reads the error,
   proposes a code fix, and opens a pull request against the repository.
6. **Resolved, for real.** Once that PR is merged and the app redeploys,
   the incident is marked resolved — resolution is reported only after
   the fix is actually live, not when a PR merely opens.
7. **Live dashboard.** Every incident's status, alert count, linked
   GitHub issue, and fixing PR are visible in real time.

## Why the dedupe step matters

A single bug can throw the same error thousands of times. Running every
one of those through an AI pipeline would be slow and expensive for no
benefit. So the very first thing that happens is a fast, deterministic
check: is this fingerprint already an open incident? If yes, stop there
— just bump the count. Only truly new errors ever reach the AI.

## What's in the box

- **Demo app** — a small app with an intentionally broken endpoint, used
  to generate real errors to react to.
- **Correlation engine** — decides whether a new error is genuinely new
  or related to something already open.
- **Incident pipeline** — turns new incidents into GitHub issues, and
  reopens or closes them as the underlying error reappears or gets
  fixed.
- **Auto-fix pipeline** — generates and opens the pull request that
  fixes the bug, and confirms resolution once it's merged and deployed.
- **Dashboard** — a live, real-time view of every incident, its status,
  its GitHub issue, and its fixing PR.

## Pipelines

Three AI pipelines do the actual reasoning, built and run on RocketRide.
Each one is invoked only when it's actually needed — never for duplicate
errors, never on every webhook event.

### 1. Correlation engine

- **Trigger:** a genuinely new error fingerprint (one the dedupe check
  hasn't seen before).
- **Input:** the new error's details plus a list of other recently-open
  incidents for the same service.
- **What it does:** an OpenAI model normalizes the error into a stable
  template and decides whether this is a brand-new problem or a variant
  of something already tracked.
- **Output:** a correlation verdict, used to decide how the incident gets
  recorded.

### 2. Incident management

- **Trigger:** a new-or-reopened incident signal.
- **What it does:** creates a GitHub issue for a brand-new incident,
  reopens the existing issue if the same underlying error resurfaces
  after being marked resolved, and keeps the incident's database record
  in sync with GitHub throughout.
- **Output:** an open GitHub issue linked to the incident.

### 3. Auto-fix (alert-solving)

- **Trigger:** GitHub issue and pull-request events, delivered via
  webhook.
- **What it does:** on a new auto-triage issue, an OpenAI-powered agent
  reads the error context, writes a fix for the affected file, and opens
  a pull request. On a merged pull request tied to one of its own fixes,
  it reports the incident as resolved.
- **Output:** a fix PR, and — only after that PR is merged and deployed
  — a closed incident.

Together, these three form the loop: an error becomes an incident, an
incident becomes a fix, and a merged fix closes the incident.

## Running it locally

### Prerequisites

- Node.js
- A [Supabase](https://supabase.com) project (for the incident database)
- A RocketRide account + API key
- An OpenAI API key
- A GitHub token with access to the repo you want fixes opened against

### 1. Install dependencies

```bash
npm run setup
```

This installs the demo app, dashboard, and relay service.

### 2. Configure environment variables

Copy `env.example` to `.env` in the repo root and fill in your values.
Each app also has its own `.env.example` (in `victim-app/`, `dashboard/`,
`track-b-relay/`) — copy those to `.env` in their respective folders too.
You'll need:

- A Supabase pooler connection string (server-side database access)
- Your Supabase project URL + anon key (for the dashboard)
- Your RocketRide API key
- Your OpenAI API key (used by the pipeline's AI steps)
- A GitHub token and a webhook secret (for filing issues and receiving
  PR-merge events)

### 3. Set up the database

Run `supabase/schema.sql` against your Supabase project (via the SQL
editor in the Supabase dashboard, or the Supabase CLI). This creates the
`incidents` and `alerts` tables the whole pipeline reads and writes.

### 4. Start each piece

In separate terminals:

```bash
npm run dev --prefix victim-app     # demo app, http://localhost:3000
npm run dev --prefix track-b-relay  # relay + pipelines, http://localhost:3001
npm run dev --prefix dashboard      # dashboard, http://localhost:3000 (Next.js default)
```

### 5. Trigger it

Hit the demo app's broken endpoint (e.g. `GET /users/999`, an ID that
doesn't exist) to throw the seeded error and kick off the pipeline. Watch
the dashboard update in real time as the incident is created, an issue
is filed, and — once a fix PR merges — the incident closes.

### Sanity-checking your setup

```bash
npm run check          # validates the .pipe files are well-formed
npm run test:all        # runs all app tests + a production build of the dashboard
```
