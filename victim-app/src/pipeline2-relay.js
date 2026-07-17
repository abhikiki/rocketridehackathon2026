// POSTs the "new_or_reopen" incident signal to Track B's relay in front
// of Pipeline 2 (Incident Management). See the contract in the repo-root
// CLAUDE.md / plan: exact field set, X-Pipeline2-Key header auth.
async function notifyPipeline2(signal) {
  const url = process.env.PIPELINE2_RELAY_URL;
  const key = process.env.PIPELINE2_RELAY_KEY;

  if (!url || !key) {
    console.warn('[pipeline2-relay] PIPELINE2_RELAY_URL/KEY not set, skipping relay call', signal);
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pipeline2-Key': key,
    },
    body: JSON.stringify(signal),
  });

  if (!res.ok) {
    throw new Error(`pipeline2 relay responded ${res.status}: ${await res.text()}`);
  }
}

module.exports = { notifyPipeline2 };
