const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildAlertPayload, createApp } = require('../src/app');
const { computeFingerprint } = require('../src/fingerprint');

let server;
let baseUrl;

beforeEach(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('victim app', () => {
  it('reports health and returns seeded users', async () => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const user = await fetch(`${baseUrl}/users/1`);
    assert.equal(user.status, 200);
    assert.deepEqual(await user.json(), { id: '1', name: 'Ada Lovelace' });
  });

  it('keeps the intentional missing-user failure for the demo', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const response = await fetch(`${baseUrl}/users/missing`);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'Internal Server Error' });
    } finally {
      console.error = originalError;
    }
  });

  it('fingerprints structural location rather than variable messages', () => {
    const base = { service: 'demo-repo', error_type: 'TypeError', file: 'src/app.js', line: 98 };
    assert.equal(
      computeFingerprint({ ...base, message: 'user 42', stack_trace: 'first' }),
      computeFingerprint({ ...base, message: 'user 99', stack_trace: 'second' })
    );
    assert.notEqual(computeFingerprint(base), computeFingerprint({ ...base, line: 99 }));
  });

  it('builds the complete alert contract', () => {
    const alert = buildAlertPayload(new TypeError('example'));
    assert.equal(alert.service, 'demo-repo');
    assert.equal(alert.error_type, 'TypeError');
    assert.equal(alert.file, 'src/app.js');
    assert.equal(alert.line, 98);
    assert.equal(alert.severity, 'high');
    assert.match(alert.received_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});
