const { RocketRideClient } = require('rocketride');

// Must match rocketride/correlation-engine.pipe's project_id/source. Kept as
// a .pipe.js module (not a raw file read at runtime) because Vercel's
// `includeFiles` does not reliably bundle files outside a function's own
// source tree into the deployed function - a plain JS module is always
// traced and bundled correctly.
const pipelineDefinition = require('../rocketride/correlation-engine.pipe.js');
const PROJECT_ID = '32dcd7d6-7d16-46d6-b9ca-aa99f295e471';
const SOURCE = 'webhook_1';

function loadPipelineDefinition() {
  return pipelineDefinition;
}

function buildPrompt({ alert, fingerprint, incidentId, recentIncidents }) {
  return [
    'You are the correlation step of an automated error-triage pipeline.',
    'Two tasks:',
    '1. Normalize the error message into a stable template: strip variable data (ids, values, timestamps) so structurally identical errors produce the same template regardless of parameter values.',
    '2. Decide whether this alert is the same root cause as one of the recently-open incidents listed below (e.g. one bad deploy throwing several unrelated-looking errors), or whether it is genuinely new.',
    '',
    'Respond with ONLY a JSON object, no prose, matching exactly:',
    '{"normalized_template": string, "correlation": "new" | "linked", "linked_incident_id": string | null, "confidence": number between 0 and 1}',
    '',
    `New alert (incident_id=${incidentId}, fingerprint=${fingerprint}):`,
    JSON.stringify(
      {
        service: alert.service,
        error_type: alert.error_type,
        message: alert.message,
        file: alert.file,
        line: alert.line,
        severity: alert.severity,
      },
      null,
      2
    ),
    '',
    'Recently-open incidents for this service:',
    JSON.stringify(recentIncidents, null, 2),
  ].join('\n');
}

// Connects fresh per call (serverless: no state persists between
// invocations), reuses the already-running pipeline task via
// getTaskToken if one exists (started once via `rocketride start`, see
// rocketride/README.md), and falls back to starting it itself otherwise.
async function runCorrelation({ alert, fingerprint, incidentId, recentIncidents }) {
  const client = new RocketRideClient({
    uri: process.env.ROCKETRIDE_URI,
    auth: process.env.ROCKETRIDE_APIKEY,
  });

  try {
    await client.connect();

    let token = await client.getTaskToken({ projectId: PROJECT_ID, source: SOURCE });
    if (!token) {
      const result = await client.use({ pipeline: loadPipelineDefinition(), source: SOURCE });
      token = result.token;
    }

    const promptText = buildPrompt({ alert, fingerprint, incidentId, recentIncidents });
    const response = await client.send(token, promptText, undefined, 'text/plain');

    const rawAnswer = response && response.answers && response.answers[0];
    if (!rawAnswer) {
      throw new Error('correlation pipeline returned no answer');
    }
    return JSON.parse(rawAnswer);
  } finally {
    await client.disconnect();
  }
}

module.exports = { runCorrelation, PROJECT_ID, SOURCE };
