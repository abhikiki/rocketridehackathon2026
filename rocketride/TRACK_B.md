# Track B: Incident and Resolution

This directory contains the two RocketRide pipelines owned by Track B:

- `incident-management.pipe` receives incident signals, creates/reopens/closes GitHub issues, and keeps Supabase state synchronized.
- `alert-solving.pipe` receives GitHub webhooks, creates a single-file fix PR for an `auto-triage` issue, and reports the incident as resolved only after that PR is merged.

Both pipelines use RocketRide's `webhook -> question -> agent_langchain -> response_answers` data path. Anthropic, GitHub, Supabase, and HTTP integrations are attached to the agent through RocketRide control-plane connections.

RocketRide does not expose these Webhook source nodes as public HTTP URLs.
The deployable `track-b-relay/` service owns `/api/incident` and
`/api/github`, authenticates those requests, then uses the RocketRide SDK to
start/reuse and send text into the corresponding pipeline.

## Contract decisions

Track B uses these decisions to remove ambiguity from the original plan:

1. `incidents` has a nullable `pr_url text` column in the shared `supabase/schema.sql`. `sql/track-b-required.sql` remains available for projects that applied the old Track A schema first.
2. Creating a PR does **not** close an incident. Pipeline 3 sends `resolved` only for a GitHub `pull_request.closed` event where `merged=true`.
3. Pipeline 1 may create a redundant open row before discovering a recently closed incident. Pipeline 2 merges that row into the canonical prior incident: it reassigns alerts, combines counts/timestamps, deletes the redundant row, then reopens the prior row.
4. GitHub issue and PR bodies include machine-readable HTML comments. The rest of the bodies remain readable during the demo.

### Pipeline 2 input

Fresh incident or possible reopen:

```json
{
  "signal": "new_or_reopen",
  "incident_id": "11111111-1111-4111-8111-111111111111",
  "fingerprint": "sha256:example",
  "service": "demo-repo",
  "error_type": "TypeError",
  "file": "src/users.js",
  "line": 42,
  "stack_trace": "TypeError: ..."
}
```

Merged fix:

```json
{
  "signal": "resolved",
  "incident_id": "11111111-1111-4111-8111-111111111111",
  "pr_url": "https://github.com/abhikiki/rocketridehackathon2026/pull/12"
}
```

### Machine-readable GitHub metadata

Pipeline 2 puts this one-line marker in every issue body:

```html
<!-- rocketride-incident {"incident_id":"UUID","fingerprint":"VALUE","service":"VALUE","error_type":"VALUE","file":"PATH","line":42} -->
```

Pipeline 3 puts this marker in every generated PR body:

```html
<!-- rocketride-resolution {"incident_id":"UUID"} -->
```

Do not change these marker names or fields without updating both pipelines.

## Local setup

Requirements: Node.js 18+, the RocketRide VS Code extension, and access to the shared RocketRide server.

```bash
npm install
npm run setup
npm run test:all
```

Open the ignored `.env` file in VS Code and replace every `replace-me` value. The extension may manage `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY`. Keep the other values local; `env.example` documents what teammates need.

The GitHub token should be fine-grained, scoped only to `abhikiki/rocketridehackathon2026`, with read/write access for Contents, Issues, and Pull requests. Supabase must use the Supavisor **session** pooler on port 5432; the pooler user is `postgres.<project-ref>`.

After credentials are present, validate against the connected RocketRide server:

```bash
npm run validate:rocketride
```

Local `npm run check` validates JSON, provider names, source references, lane compatibility, control-plane requirements, required config fields, UUID uniqueness, environment-variable documentation, and obvious committed-secret patterns. Remote validation is still required before deployment because only the RocketRide server can validate runtime component behavior.

## Configure and deploy the Track B relay

1. Open `incident-management.pipe` with the RocketRide visual editor.
2. Confirm the Webhook, Question, LangChain Agent, Anthropic, GitHub, Supabase, and Response nodes render without form errors.
3. Deploy the relay from the **repository root** as its own Vercel project with `vercel --prod --local-config vercel.track-b.json`. This is required so Vercel can bundle the canonical `rocketride/*.pipe` files. Configure every value in `track-b-relay/.env.example`.
4. Set `ROCKETRIDE_INCIDENT_WEBHOOK_URL` to `https://<relay-domain>/api/incident`.
5. Set `PIPELINE2_RELAY_KEY` and `ROCKETRIDE_INCIDENT_WEBHOOK_KEY` to the same random internal secret.
6. Configure Track A's victim app with `PIPELINE2_RELAY_URL=https://<relay-domain>/api/incident` and the same `PIPELINE2_RELAY_KEY`.

The relay starts or reuses both RocketRide tasks with `useExisting: true`.
The public authentication boundary lives in Express because the installed
RocketRide Webhook source schema has no HTTP authentication fields.

Test in this order using `fixtures/incident-new.json` and `fixtures/incident-resolved.json`:

1. New fingerprint creates one `auto-triage` issue and stores `ticket_url`.
2. Repeating the identical signal is a no-op rather than a second issue.
3. A resolved signal for a genuinely merged PR closes the issue and incident.
4. A new signal inside the reopen window reopens the same issue and canonical incident.

## Configure the GitHub webhook

1. Ensure `ROCKETRIDE_INCIDENT_WEBHOOK_URL` is the relay's `/api/incident` endpoint before Pipeline 3 starts. Its HTTP tool whitelist is limited to this value.
2. In GitHub repository Settings -> Webhooks, point a webhook at `https://<relay-domain>/api/github`.
3. Use content type `application/json`, set the same value in GitHub and the relay's `GITHUB_WEBHOOK_SECRET`, and subscribe to **Issues** and **Pull requests** events.
4. The relay verifies `X-Hub-Signature-256` before any payload reaches RocketRide.
5. Create a manual `auto-triage` issue with the metadata marker before relying on end-to-end delivery.

Pipeline 3 ignores all issue labels except `auto-triage`, all unmerged/irrelevant PR events, all repositories except the configured repository, unsafe file paths, and fixes that require more than one file. It checks for an existing `auto-fix-issue-N` PR before writing so GitHub webhook retries do not create duplicates.

## Track A handoff

Track A must provide:

- the deployed Supabase session-pooler host, user, password, and database;
- an `incidents` row before sending `new_or_reopen`;
- the exact signal fields shown above;
- Pipeline 1 behavior compatible with the redundant-row merge decision;
- the victim repository's default branch and target files.

Track B provides the relay's `/api/incident` URL/key as soon as available.
GitHub calls the relay's `/api/github` route directly; Track A does not call
Pipeline 3.

## Security notes

- Never commit `.env`; it is ignored.
- Do not paste credentials into `.pipe` files or agent instructions.
- The HTTP callback key is expanded at RocketRide runtime and is sent to Anthropic as part of the agent's tool instructions. Use a narrowly scoped internal key, not a general RocketRide or GitHub credential.
- Agent-driven database and GitHub mutations match the hackathon plan but are nondeterministic. Review RocketRide traces and the generated PR before merging.
