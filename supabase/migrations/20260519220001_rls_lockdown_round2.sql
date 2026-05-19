-- Security audit fix 2026-05-19 — RLS lockdown round 2.
--
-- The original lockdown migration (20260514120002_rls_lockdown.sql)
-- enabled Row Level Security on every public table that existed at
-- the time. Two tables created AFTER that lockdown shipped without
-- RLS, leaving them readable + writable by anyone with the public
-- anon key via PostgREST at /rest/v1/<table>:
--
--   support_tickets   (added 2026-05-17) — bug report inbox.
--                      Exposes reporter user-agent, page URLs,
--                      email/name snapshots, ticket descriptions.
--   opportunity_roles (added 2026-05-18) — per-role headcount data.
--                      Anon writes could deface role names or wipe
--                      the role list mid-event.
--
-- Same fix the original lockdown used: enable RLS, add NO policies.
-- service_role bypasses RLS entirely → the Edge Function (which
-- uses service_role) keeps working. anon + authenticated tokens
-- hit zero policies → all reads/writes through PostgREST are denied.
--
-- Detection going forward: add a CI check that fails the build if
-- pg_tables shows any public table where pg_class.relrowsecurity is
-- FALSE. That would have caught both of these on the migration that
-- introduced them.

ALTER TABLE public.support_tickets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_roles  ENABLE ROW LEVEL SECURITY;
