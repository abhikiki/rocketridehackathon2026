# Track B: Incident and Resolution

This directory contains the two RocketRide pipelines owned by Track B:

- `incident-management.pipe` receives incident signals, creates/reopens/closes GitHub issues, and keeps Supabase state synchronized.
- `alert-solving.pipe` receives GitHub webhooks, creates a single-file fix PR for an `auto-triage` issue, and reports the incident as resolved only after that PR is merged.

Both pipelines use RocketRide's `webhook -> question -> agent_langchain -> response_answers` data path. Anthropic, GitHub, Supabase, and HTTP integrations are attached to the agent through RocketRide control-plane connections.

## Contract decisions

Track B uses these decisions to remove ambiguity from the original plan:

1. `incidents` has a nullable `pr_url text` column. Apply `sql/track-b-required.sql` to the shared Supabase project.
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
npm run check
```

Open the ignored `.env` file in VS Code and replace every `replace-me` value. The extension may manage `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY`. Keep the other values local; `env.example` documents what teammates need.

The GitHub token should be fine-grained, scoped only to `abhikiki/rocketridehackathon2026`, with read/write access for Contents, Issues, and Pull requests. Supabase must use the Supavisor **session** pooler on port 5432; the pooler user is `postgres.<project-ref>`.

After credentials are present, validate against the connected RocketRide server:

```bash
npm run validate:rocketride
```

Local `npm run check` validates JSON, provider names, source references, lane compatibility, control-plane requirements, required config fields, UUID uniqueness, environment-variable documentation, and obvious committed-secret patterns. Remote validation is still required before deployment because only the RocketRide server can validate runtime component behavior.

## Configure and deploy Pipeline 2

1. Open `incident-management.pipe` with the RocketRide visual editor.
2. Confirm the Webhook, Question, LangChain Agent, Anthropic, GitHub, Supabase, and Response nodes render without form errors.
3. Apply `sql/track-b-required.sql` in Supabase.
4. Deploy the pipeline and save its webhook URL in `ROCKETRIDE_INCIDENT_WEBHOOK_URL`.
5. Configure the deployed webhook to require `X-RocketRide-Key` matching `ROCKETRIDE_INCIDENT_WEBHOOK_KEY` if RocketRide Cloud exposes header-auth settings. Header authentication is deployment configuration because the installed Webhook node schema does not contain an auth field.
6. Give the Pipeline 2 URL and key to the owner of Pipeline 1.

Test in this order using `fixtures/incident-new.json` and `fixtures/incident-resolved.json`:

1. New fingerprint creates one `auto-triage` issue and stores `ticket_url`.
2. Repeating the identical signal is a no-op rather than a second issue.
3. A resolved signal for a genuinely merged PR closes the issue and incident.
4. A new signal inside the reopen window reopens the same issue and canonical incident.

## Configure and deploy Pipeline 3

1. Set `ROCKETRIDE_INCIDENT_WEBHOOK_URL` to Pipeline 2's deployed URL before starting/deploying Pipeline 3. The HTTP tool whitelist is intentionally limited to this value.
2. Open `alert-solving.pipe`, validate it, and deploy it.
3. In GitHub repository settings, create one webhook pointing at Pipeline 3. Use content type `application/json`, set a webhook secret, and subscribe to **Issues** and **Pull requests** events.
4. If RocketRide Cloud supports signature validation outside the `.pipe` file, require GitHub's `X-Hub-Signature-256`. The installed Webhook node itself does not expose a signature field.
5. Create a manual `auto-triage` issue with the metadata marker before relying on end-to-end delivery.

Pipeline 3 ignores all issue labels except `auto-triage`, all unmerged/irrelevant PR events, all repositories except the configured repository, unsafe file paths, and fixes that require more than one file. It checks for an existing `auto-fix-issue-N` PR before writing so GitHub webhook retries do not create duplicates.

## Track A handoff

Track A must provide:

- the deployed Supabase session-pooler host, user, password, and database;
- an `incidents` row before sending `new_or_reopen`;
- the exact signal fields shown above;
- Pipeline 1 behavior compatible with the redundant-row merge decision;
- the victim repository's default branch and target files.

Track B provides Pipeline 2's deployed URL/key as soon as available. Pipeline 3 is called by GitHub directly, so Track A does not normally call it.

## Security notes

- Never commit `.env`; it is ignored.
- Do not paste credentials into `.pipe` files or agent instructions.
- The HTTP callback key is expanded at RocketRide runtime and is sent to Anthropic as part of the agent's tool instructions. Use a narrowly scoped internal key, not a general RocketRide or GitHub credential.
- Agent-driven database and GitHub mutations match the hackathon plan but are nondeterministic. Review RocketRide traces and the generated PR before merging.
