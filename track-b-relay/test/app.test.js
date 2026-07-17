const crypto = require('crypto');
const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const {
  PIPELINES,
  isTransientConnectionError,
  loadPipeline,
  resolvePipelinePath,
} = require('../src/pipeline-runner');

const REPOSITORY = 'abhikiki/rocketridehackathon2026';
const WEBHOOK_SECRET = 'test-webhook-secret';
const RELAY_KEY = 'test-relay-key';
let server;
let baseUrl;
let incidentCalls;
let githubCalls;

function githubHeaders(body, event = 'issues') {
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
    'X-Hub-Signature-256': `sha256=${signature}`,
  };
}

beforeEach(async () => {
  incidentCalls = [];
  githubCalls = [];
  const app = createApp({
    githubRepository: REPOSITORY,
    githubWebhookSecret: WEBHOOK_SECRET,
    pipeline2Key: RELAY_KEY,
    internalKey: 'internal-key',
    executeIncident: async (payload) => {
      incidentCalls.push(payload);
      return { ok: true, action: payload.signal };
    },
    executeGithub: async (payload) => {
      githubCalls.push(payload);
      return { ok: true, action: 'accepted' };
    },
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('track-b relay', () => {
  it('finds and loads both pipeline files from the monorepo', () => {
    for (const spec of Object.values(PIPELINES)) {
      assert.match(resolvePipelinePath(spec.filename), /rocketride\/.*\.pipe$/);
      assert.equal(loadPipeline(spec).project_id, spec.projectId);
    }
  });

  it('retries only transport-level RocketRide failures', () => {
    assert.equal(isTransientConnectionError(new Error('Unexpected server response: 502')), true);
    assert.equal(isTransientConnectionError(new Error('Connection closed unexpectedly')), true);
    assert.equal(isTransientConnectionError(new Error('agent returned invalid output')), false);
  });

  it('reports health', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'track-b-relay' });
  });

  it('rejects an incident without the shared key', async () => {
    const response = await fetch(`${baseUrl}/api/incident`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signal: 'resolved' }),
    });
    assert.equal(response.status, 401);
    assert.equal(incidentCalls.length, 0);
  });

  it('validates and forwards a new incident', async () => {
    const payload = {
      signal: 'new_or_reopen',
      incident_id: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'sha256:demo',
      service: 'demo-repo',
      error_type: 'TypeError',
      file: 'src/app.js',
      line: 98,
      stack_trace: 'TypeError: example',
    };
    const response = await fetch(`${baseUrl}/api/incident`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pipeline2-Key': RELAY_KEY },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(incidentCalls, [payload]);
  });

  it('rejects a forged GitHub webhook', async () => {
    const body = JSON.stringify({ repository: { full_name: REPOSITORY } });
    const response = await fetch(`${baseUrl}/api/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': 'sha256=forged',
      },
      body,
    });
    assert.equal(response.status, 401);
    assert.equal(githubCalls.length, 0);
  });

  it('verifies and forwards a GitHub issue event', async () => {
    const payload = { action: 'opened', repository: { full_name: REPOSITORY }, issue: { number: 7 } };
    const body = JSON.stringify(payload);
    const response = await fetch(`${baseUrl}/api/github`, {
      method: 'POST',
      headers: githubHeaders(body),
      body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(githubCalls, [{ ...payload, rocketride_github_event: 'issues' }]);
  });
});
