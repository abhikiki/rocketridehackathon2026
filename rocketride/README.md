# RocketRide pipelines — Track A

## `correlation-engine.pipe` (Pipeline 1)

```
webhook_1 --text--> question_1 --questions--> llm_anthropic_1 --answers--> guardrails_1 --answers--> response_answers_1
```

| id | provider | purpose |
|---|---|---|
| `webhook_1` | `webhook` | Source. Accepts data via the RocketRide SDK's `send()`/`sendFiles()` — **not** a public HTTP endpoint (see "Deviations" below). |
| `question_1` | `question` | Wraps the raw text payload as a `Question` object, unmodified. |
| `llm_anthropic_1` | `llm_anthropic` | Claude Sonnet 4.6. Normalizes the alert's message into a stable template and reasons about correlation against nearby open incidents. This node has no separate prompt/instructions field — the full task (instructions, expected JSON output shape, alert fields, recent-incidents context) is baked into the text the caller sends via `question_1`. |
| `guardrails_1` | `guardrails` | Custom profile, `expected_format: "json"`, `policy_mode: "warn"` (log and continue rather than block — the caller has its own JSON-parse fallback, so a demo run shouldn't hard-fail on a slightly malformed response). |
| `response_answers_1` | `response_answers` | Returns the LLM's answer synchronously in the `send()` result. |

**project_id:** `32dcd7d6-7d16-46d6-b9ca-aa99f295e471` (literal GUID, per
RocketRide's rules — do not template it).

**Env var required:** `ROCKETRIDE_ANTHROPIC_KEY` — set in the RocketRide
extension's `.env` (or wherever the RocketRide server that owns this task
reads its environment from), not in `victim-app`.

**Expected caller-supplied text shape** (constructed by
`victim-app/src/rocketride.js`): a single string containing task
instructions, the required JSON output shape
(`{normalized_template, correlation: "new"|"linked", linked_incident_id,
confidence}`), the new alert's fields, and a JSON array of recent open
incidents for the same service (id, fingerprint, service, error_type,
file, first_seen, alert_count).

## Deviations from the original design doc

The original design doc assumed two things about RocketRide that don't
hold, confirmed against the actual schema/docs in `.rocketride/`:

1. **No public HTTP webhook URL exists.** There's no "deploy and get a
   URL" — the only transport is an authenticated WebSocket DAP connection
   (`ROCKETRIDE_OBSERVABILITY.md` §2.1), driven by the SDK's
   `connect()`/`use()`/`send()`. So the victim app doesn't POST to a
   RocketRide URL, and this pipeline doesn't POST to Pipeline 2's URL
   either — pipelines don't have URLs.
2. **`db_supabase`'s raw-SQL `allow_execute`/`QuestionType.EXECUTE` path
   is undocumented outside a schema field description** — not safe to
   build the race-critical atomic upsert on top of for a demo.

As a result, this pipeline is intentionally minimal:

- **No `db_supabase` node.** The atomic fingerprint upsert (the actual
  suppression gate — is this a duplicate or a new incident) and the
  "recent open incidents for this service" read both happen as plain
  Postgres queries in `victim-app/src/db.js`, run directly against
  Supabase via the pooler connection string. This pipeline only ever
  gets invoked for **genuinely new** fingerprints — never on a duplicate.
- **No hand-off node calling Pipeline 2.** `victim-app`'s error handler
  parses this pipeline's JSON answer and makes the outbound HTTP call to
  Track B's Pipeline 2 relay itself (`src/pipeline2-relay.js`), instead of
  an in-pipeline `agent_rocketride` + `tool_http_request` combo. One less
  LLM/tool round trip, and Track A's correctness doesn't depend on Track
  B's Pipeline 2 wiring being done yet.
- **No `hash` node.** RocketRide's `hash` component fingerprints whole
  document content with no multi-field config; the fingerprint here needs
  exactly `service|error_type|file|line`, so it's computed with
  `crypto.createHash('sha256')` in `victim-app/src/fingerprint.js`.

## Running it

Start the pipeline once (so a task stays running and `victim-app` can
reuse it via `getTaskToken` on every request, instead of starting a fresh
task per HTTP call):

```bash
rocketride start rocketride/correlation-engine.pipe --apikey $ROCKETRIDE_APIKEY
```

`victim-app/src/rocketride.js` falls back to starting the pipeline itself
(reading this exact `.pipe` file) if no running task is found for this
`project_id`/`source`. `victim-app/vercel.json` includes this file in the
serverless function bundle for that reason.
