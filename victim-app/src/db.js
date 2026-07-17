const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    const connectionString = process.env.SUPABASE_POOLER_URL;
    if (!connectionString) {
      throw new Error('SUPABASE_POOLER_URL is not set');
    }
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

// The atomic upsert: this single statement IS the suppression gate.
// `is_new` (xmax = 0) is what decides whether the caller ever talks to
// RocketRide at all — on a duplicate fingerprint this returns false and
// the caller stops here, no LLM involved.
async function upsertIncident({ fingerprint, service, error_type, stack_trace }) {
  const { rows } = await getPool().query(
    `insert into incidents (fingerprint, service, error_type, stack_trace, first_seen, last_seen, alert_count, status)
     values ($1, $2, $3, $4, now(), now(), 1, 'open')
     on conflict (fingerprint) where status = 'open'
     do update set alert_count = incidents.alert_count + 1, last_seen = now()
     returning id, alert_count, (xmax = 0) as is_new`,
    [fingerprint, service, error_type, stack_trace]
  );
  return rows[0];
}

async function insertAlert({ incidentId, fingerprint, rawPayload }) {
  await getPool().query(
    `insert into alerts (incident_id, fingerprint, raw_payload) values ($1, $2, $3)`,
    [incidentId, fingerprint, rawPayload]
  );
}

async function getRecentOpenIncidents({ service, excludeIncidentId, limit = 10 }) {
  const { rows } = await getPool().query(
    `select id, fingerprint, service, error_type, first_seen, alert_count
     from incidents
     where service = $1
       and status = 'open'
       and ($2::uuid is null or id <> $2::uuid)
     order by last_seen desc
     limit $3`,
    [service, excludeIncidentId || null, limit]
  );
  return rows;
}

module.exports = { upsertIncident, insertAlert, getRecentOpenIncidents };
