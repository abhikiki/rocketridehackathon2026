-- Track A owns this file. Track B (Pipeline 2/3) reads/writes the same
-- `incidents` table. Track B stores the merged fixing PR in `pr_url`.

create extension if not exists pgcrypto;

create table if not exists incidents (
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
  pr_url text,
  previous_issue_number int
);

-- Supports projects that applied Track A's earlier schema before Track B
-- added merged-PR tracking.
alter table incidents add column if not exists pr_url text;

-- Only one *open* incident per fingerprint may exist at a time. This is
-- the constraint the atomic upsert below relies on for race-safe
-- dedupe/suppression under concurrent alert bursts.
create unique index if not exists one_open_incident_per_fingerprint
  on incidents(fingerprint) where status = 'open';

create table if not exists alerts (
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

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'incidents'
      and policyname = 'incidents are publicly readable'
  ) then
    create policy "incidents are publicly readable"
      on incidents for select
      using (true);
  end if;
end
$$;

-- Realtime also needs the table added to the realtime publication (or
-- toggle "Enable Realtime" on the table in the Supabase dashboard UI):
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'incidents'
     ) then
    alter publication supabase_realtime add table incidents;
  end if;
end
$$;

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
