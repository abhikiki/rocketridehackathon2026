const crypto = require('crypto');
const express = require('express');
const { runPipeline } = require('./pipeline-runner');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function constantTimeEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateIncidentSignal(payload, repository) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'body must be a JSON object';
  }
  if (!['new_or_reopen', 'resolved'].includes(payload.signal)) {
    return 'signal must be new_or_reopen or resolved';
  }
  if (!UUID_RE.test(payload.incident_id || '')) return 'incident_id must be a UUID';

  if (payload.signal === 'resolved') {
    const prefix = `https://github.com/${repository}/pull/`;
    if (typeof payload.pr_url !== 'string' || !payload.pr_url.startsWith(prefix)) {
      return `pr_url must be a pull request in ${repository}`;
    }
    return null;
  }

  for (const field of ['fingerprint', 'service', 'error_type', 'file', 'stack_trace']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) {
      return `${field} must be a non-empty string`;
    }
  }
  if (!Number.isInteger(payload.line) || payload.line < 1) return 'line must be a positive integer';
  if (payload.file.startsWith('/') || payload.file.split('/').includes('..')) {
    return 'file must be a safe relative path';
  }
  return null;
}

function validGithubSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return constantTimeEqual(signature, expected);
}

function createApp(options = {}) {
  const executeIncident = options.executeIncident || ((payload) => runPipeline('incident', payload));
  const executeGithub = options.executeGithub || ((payload) => runPipeline('github', payload));
  const config = {
    githubRepository: options.githubRepository || process.env.ROCKETRIDE_GITHUB_REPO || 'abhikiki/rocketridehackathon2026',
    githubWebhookSecret: options.githubWebhookSecret || process.env.GITHUB_WEBHOOK_SECRET,
    pipeline2Key: options.pipeline2Key || process.env.PIPELINE2_RELAY_KEY,
    internalKey: options.internalKey || process.env.ROCKETRIDE_INCIDENT_WEBHOOK_KEY,
  };

  const app = express();
  app.use(
    express.json({
      limit: '1mb',
      verify(req, res, buffer) {
        req.rawBody = Buffer.from(buffer);
      },
    })
  );

  app.get('/healthz', (req, res) => res.json({ ok: true, service: 'track-b-relay' }));

  app.post('/api/incident', async (req, res, next) => {
    try {
      const suppliedKey = req.get('X-Pipeline2-Key') || req.get('X-RocketRide-Key') || '';
      const accepted = [config.pipeline2Key, config.internalKey].filter(Boolean);
      if (accepted.length === 0) return res.status(503).json({ error: 'relay key is not configured' });
      if (!accepted.some((key) => constantTimeEqual(suppliedKey, key))) {
        return res.status(401).json({ error: 'unauthorized' });
      }

      const validationError = validateIncidentSignal(req.body, config.githubRepository);
      if (validationError) return res.status(400).json({ error: validationError });

      const result = await executeIncident(req.body);
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/github', async (req, res, next) => {
    try {
      if (!config.githubWebhookSecret) {
        return res.status(503).json({ error: 'GitHub webhook secret is not configured' });
      }
      if (!validGithubSignature(req.rawBody, req.get('X-Hub-Signature-256'), config.githubWebhookSecret)) {
        return res.status(401).json({ error: 'invalid GitHub signature' });
      }

      const event = req.get('X-GitHub-Event');
      if (event === 'ping') return res.json({ ok: true, action: 'pong' });
      if (!['issues', 'pull_request'].includes(event)) {
        return res.status(202).json({ ok: true, action: 'ignored', event });
      }
      if (req.body?.repository?.full_name !== config.githubRepository) {
        return res.status(403).json({ error: 'unexpected repository' });
      }

      const result = await executeGithub({ ...req.body, rocketride_github_event: event });
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, req, res, next) => {
    console.error('[track-b-relay]', error);
    res.status(500).json({ error: 'pipeline execution failed' });
  });

  return app;
}

module.exports = {
  constantTimeEqual,
  createApp,
  validGithubSignature,
  validateIncidentSignal,
};
