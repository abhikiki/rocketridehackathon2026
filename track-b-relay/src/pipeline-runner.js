const fs = require('fs');
const path = require('path');
const { RocketRideClient } = require('rocketride');

const PIPELINES = {
  incident: {
    projectId: '16e0c066-f82b-4b3f-bfd0-53d259f3472e',
    source: 'webhook_1',
    filename: 'incident-management.pipe',
  },
  github: {
    projectId: 'f41d5453-5947-43fd-be49-3e879062be16',
    source: 'webhook_1',
    filename: 'alert-solving.pipe',
  },
};

function resolvePipelinePath(filename) {
  const candidates = [
    // track-b-relay's own copy, bundled via includeFiles (Vercel only
    // bundles paths inside the project directory, not ../rocketride/*).
    path.join(__dirname, '..', 'rocketride', filename),
    // Local monorepo layout: track-b-relay/src -> repository root.
    path.join(__dirname, '..', '..', 'rocketride', filename),
    path.join(process.cwd(), 'rocketride', filename),
    path.join(process.cwd(), '..', 'rocketride', filename),
  ];
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) throw new Error(`Unable to locate bundled RocketRide pipeline ${filename}`);
  return match;
}

// Prefer track-b-relay's own bundled rocketride/*.pipe.js module: Vercel's
// `includeFiles` does not reliably bundle files outside a function's own
// source tree into the deployed function, but a plain JS module is always
// traced and bundled correctly. Falls back to reading the repository-root
// .pipe file directly for local dev and tests.
function loadPipeline(spec) {
  let pipeline;
  let source;
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    pipeline = require(`../rocketride/${spec.filename}.js`);
    source = `../rocketride/${spec.filename}.js`;
  } catch {
    source = resolvePipelinePath(spec.filename);
    pipeline = JSON.parse(fs.readFileSync(source, 'utf8'));
  }
  if (pipeline.project_id !== spec.projectId || pipeline.source !== spec.source) {
    throw new Error(`Pipeline identity mismatch for ${source}`);
  }
  return pipeline;
}

function parseAgentAnswer(response) {
  const answer = response && response.answers && response.answers[0];
  if (answer === undefined || answer === null) {
    throw new Error('RocketRide pipeline returned no agent answer');
  }
  if (typeof answer !== 'string') return answer;
  try {
    return JSON.parse(answer);
  } catch {
    return { ok: true, raw: answer };
  }
}

function isTransientConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to connect|Unexpected server response: 5\d\d|Connection closed unexpectedly|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message);
}

async function runPipelineOnce(kind, payload) {
  const spec = PIPELINES[kind];
  if (!spec) throw new Error(`Unknown pipeline kind: ${kind}`);

  if (!process.env.ROCKETRIDE_URI || !process.env.ROCKETRIDE_APIKEY) {
    throw new Error('ROCKETRIDE_URI and ROCKETRIDE_APIKEY must be configured');
  }

  const client = new RocketRideClient({
    uri: process.env.ROCKETRIDE_URI,
    auth: process.env.ROCKETRIDE_APIKEY,
  });

  try {
    await client.connect();
    const pipeline = loadPipeline(spec);
    const result = await client.use({
      pipeline,
      source: spec.source,
      useExisting: true,
    });
    const response = await client.send(
      result.token,
      JSON.stringify(payload),
      undefined,
      'text/plain'
    );
    return parseAgentAnswer(response);
  } finally {
    await client.disconnect();
  }
}

async function runPipeline(kind, payload) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runPipelineOnce(kind, payload);
    } catch (error) {
      lastError = error;
      if (!isTransientConnectionError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

module.exports = {
  PIPELINES,
  isTransientConnectionError,
  loadPipeline,
  parseAgentAnswer,
  resolvePipelinePath,
  runPipeline,
};
