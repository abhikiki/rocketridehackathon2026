-- Track A owns this file. Track B (Pipeline 2/3) reads/writes the same
-- `incidents` table and will need an additive migration for a `pr_url`
-- column once Pipeline 3 exists — this schema does not define one yet.

create extension if not exists pgcrypto;

create table incidents (
  id uuid default gen_random_uuid() primary key,
  fingerprint text not null,
  alert_count int default 1,
  status text default 'open',
  first_seen timestamptz default now(),
  last_seen timestamptz default now(),
  closed_at timestamptz,
  service text,
  error_type text,
  stack_trace text,
  ticket_url text,
  previous_issue_number int
);

-- Only one *open* incident per fingerprint may exist at a time. This is
-- the constraint the atomic upsert below relies on for race-safe
-- dedupe/suppression under concurrent alert bursts.
create unique index one_open_incident_per_fingerprint
  on incidents(fingerprint) where status = 'open';

create table alerts (
  id uuid default gen_random_uuid() primary key,
  incident_id uuid references incidents(id),
  fingerprint text not null,
  received_at timestamptz default now(),
  raw_payload jsonb
);

-- The dashboard (dashboard/) is a browser client using the Supabase
-- anon key + Realtime, not the pooler connection string — so `incidents`
-- needs RLS enabled with an explicit read-only policy for that key
-- (writes still go through victim-app's server-side `pg` pool, which
-- uses the pooler connection and bypasses RLS as usual).
alter table incidents enable row level security;

create policy "incidents are publicly readable"
  on incidents for select
  using (true);

-- Realtime also needs the table added to the realtime publication (or
-- toggle "Enable Realtime" on the table in the Supabase dashboard UI):
-- alter publication supabase_realtime add table incidents;

-- Reference query only — this is what victim-app/src/db.js runs directly
-- against Supabase via `pg` (Supavisor pooler connection) for every
-- incoming alert. It is the entire fast-path suppression gate: on an
-- exact-fingerprint duplicate, `is_new` comes back false and the caller
-- stops there — no LLM, no RocketRide pipeline invocation.
--
-- insert into incidents (fingerprint, service, error_type, stack_trace, first_seen, last_seen, alert_count, status)
-- values ($1, $2, $3, $4, now(), now(), 1, 'open')
-- on conflict (fingerprint) where status = 'open'
-- do update set alert_count = incidents.alert_count + 1, last_seen = now()
-- returning id, alert_count, (xmax = 0) as is_new;
