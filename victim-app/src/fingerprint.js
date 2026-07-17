const crypto = require('crypto');

// Deliberately excludes `message` and `stack_trace` — those carry
// variable data (user ids, values) that would break dedupe across
// otherwise-identical failures. Structurally identical bugs (same
// service/error_type/file/line) must hash identically.
function computeFingerprint({ service, error_type, file, line }) {
  const key = `${service}|${error_type}|${file}|${line}`;
  return crypto.createHash('sha256').update(key).digest('hex');
}

module.exports = { computeFingerprint };
