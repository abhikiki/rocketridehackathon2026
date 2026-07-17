-- Track B stores the pull request that actually resolved an incident.
-- This migration is safe to run more than once.
alter table public.incidents
  add column if not exists pr_url text;

comment on column public.incidents.pr_url is
  'Merged GitHub pull request reported by the Track B alert-solving pipeline.';
