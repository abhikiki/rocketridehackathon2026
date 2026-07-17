const express = require('express');
const { computeFingerprint } = require('./fingerprint');
const { upsertIncident, insertAlert, getRecentOpenIncidents } = require('./db');
const { runCorrelation } = require('./rocketride');
const { notifyPipeline2 } = require('./pipeline2-relay');

const SERVICE_NAME = 'demo-repo';

// Seeded bug lives at the res.json(...) line below: no null check on a
// missing user lookup. See NOTES.md for the ground-truth fix.
const USERS = {
  '1': { id: '1', name: 'Ada Lovelace' },
  '2': { id: '2', name: 'Grace Hopper' },
};

const BUG_LOCATION = { file: 'src/app.js', line: 98 };

function deriveSeverity(errorType) {
  if (['TypeError', 'ReferenceError', 'SyntaxError'].includes(errorType)) return 'high';
  if (errorType === 'AppError') return 'medium';
  return 'low';
}

function buildAlertPayload(err) {
  const error_type = err.constructor.name || 'Error';
  return {
    service: SERVICE_NAME,
    error_type,
    message: err.message,
    file: BUG_LOCATION.file,
    line: BUG_LOCATION.line,
    stack_trace: err.stack || '',
    severity: deriveSeverity(error_type),
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    deploy_id: process.env.VERCEL_DEPLOYMENT_ID || 'local',
    received_at: new Date().toISOString(),
  };
}

// The orchestrator: fast-path suppression gate (deterministic, direct
// Postgres) first, RocketRide correlation only on a genuinely new
// fingerprint, then hand off to Track B's Pipeline 2 relay.
async function handleAlert(alert) {
  const fingerprint = computeFingerprint(alert);

  const { id: incidentId, alert_count, is_new } = await upsertIncident({
    fingerprint,
    service: alert.service,
    error_type: alert.error_type,
    stack_trace: alert.stack_trace,
  });

  await insertAlert({ incidentId, fingerprint, rawPayload: alert });

  if (!is_new) {
    console.log(`[alert] duplicate fingerprint=${fingerprint} alert_count=${alert_count} - suppressed, no RocketRide call`);
    return;
  }

  console.log(`[alert] new fingerprint=${fingerprint} incident=${incidentId} - invoking correlation engine`);

  const recentIncidents = await getRecentOpenIncidents({ service: alert.service });

  let correlation;
  try {
    correlation = await runCorrelation({ alert, fingerprint, incidentId, recentIncidents });
  } catch (correlationErr) {
    console.error('[alert] correlation engine call failed, defaulting to "new"', correlationErr);
    correlation = { correlation: 'new', normalized_template: null, linked_incident_id: null, confidence: 0 };
  }

  console.log('[alert] correlation result', correlation);

  // Cross-fingerprint linking (merging this incident into an existing
  // open one) is Pipeline 2's decision, not Track A's — the shared
  // `incidents` schema has no linking column yet. We always report the
  // incident this alert actually created; `correlation` is logged for
  // visibility only and intentionally not added to the wire contract
  // below to avoid drifting from what Track B agreed to parse.
  await notifyPipeline2({
    signal: 'new_or_reopen',
    incident_id: incidentId,
    fingerprint,
    service: alert.service,
    error_type: alert.error_type,
    file: alert.file,
    line: alert.line,
    stack_trace: alert.stack_trace,
  });
}

function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/users/:id', (req, res) => {
    const user = USERS[req.params.id]; // undefined when id is unknown
    res.json({ id: user.id, name: user.name }); // BUG_LOCATION: no null check
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Express error-handling middleware (must have 4 args to be recognized
  // as such). Awaited on purpose: Vercel serverless functions don't run
  // background work after the response is sent, so the alert pipeline
  // must finish before we respond, even though that adds latency to the
  // client's 500. Always responds 500 regardless of pipeline outcome.
  app.use(async (err, req, res, next) => {
    const alert = buildAlertPayload(err);
    try {
      await handleAlert(alert);
    } catch (handlerErr) {
      console.error('[alert] pipeline failed', handlerErr);
    }
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}

module.exports = { createApp, buildAlertPayload, handleAlert };
