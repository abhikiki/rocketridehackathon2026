const fs = require('fs');
const path = require('path');
const { RocketRideClient } = require('rocketride');

const PIPELINES = {
  incident: {
    projectId: '17a810aa-a0ce-4750-b98b-f1792ddbf181',
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
    // Vercel places includeFiles from outside the project under /var/task.
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

function loadPipeline(spec) {
  const pipelinePath = resolvePipelinePath(spec.filename);
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf8'));
  if (pipeline.project_id !== spec.projectId || pipeline.source !== spec.source) {
    throw new Error(`Pipeline identity mismatch for ${pipelinePath}`);
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
