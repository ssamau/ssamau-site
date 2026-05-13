-- URGENT: enable Row Level Security on every public table.
--
-- Background: Supabase exposes the `public` schema via PostgREST at
-- /rest/v1/<table>. Without RLS, the `anon` role (whose JWT we ship
-- in assets/js/lib/api.js as SUPABASE_ANON_KEY) gets default GRANTs
-- on every table — so anyone visiting ssamau.com could
--
--   fetch('https://<project>.supabase.co/rest/v1/users
--          ?select=username,password_hash', {
--     headers: { apikey: <anon> }
--   })
--
-- and dump 22 bcrypt hashes. Confirmed exploitable in prod 14-May 2026.
-- The bcrypt rounds on those hashes are 6 (set by the legacy seed
-- script for fast local dev) — crackable at ~10,000/s on a single
-- modern GPU. A few hours per weak password.
--
-- The four still-on-legacy accounts whose passwords I rotated
-- earlier today (`president`, `lead_mbr_r82ypy`, `lead_mbr_enftku`,
-- `lead_mbr_22wj7q`) are the highest-risk targets here because their
-- whole authentication is bcrypt+HS256 — the 18 migrated accounts
-- have throwaway passwords stored in public.users that don't grant
-- access to anything anymore (Supabase Auth is the real gate for them).
--
-- Fix: ENABLE ROW LEVEL SECURITY on all 14 public tables. We add ZERO
-- policies, which means:
--   - service_role (Edge Function service-role client): bypasses RLS
--     entirely → everything keeps working unchanged
--   - anon (browser, public anon key): no matching policy → no rows
--   - authenticated (Supabase Auth tokens): no matching policy → no rows
--
-- The frontend talks to PostgREST exclusively for /auth/v1/* endpoints
-- (those are Auth API, not RLS-gated). Every data read/write goes
-- through /functions/v1/api (the Edge Function), which uses the
-- service_role client and isn't affected.
--
-- Future commits will ADD policies as we move pure-read actions out
-- of the Edge Function and let the frontend query directly via the
-- supabase-js client (the proper Supabase idiom). Until then, RLS
-- enabled + no policies = locked down, which is correct.

ALTER TABLE public.advisors                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.certificates             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.committees               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hours                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interest_requests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.members                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_applications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunities            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thanks_emails            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users                    ENABLE ROW LEVEL SECURITY;

-- Belt + braces: also FORCE row security so even table owners obey
-- RLS. Without FORCE, the owner role (postgres) can SELECT without
-- consulting policies. Doesn't directly affect our anon/authenticated
-- exposure (those aren't table owners), but it's a defence-in-depth
-- that matches the Supabase Security Advisor's recommended config.
ALTER TABLE public.advisors                 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.assignments              FORCE ROW LEVEL SECURITY;
ALTER TABLE public.attendance               FORCE ROW LEVEL SECURITY;
ALTER TABLE public.certificates             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.committees               FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hours                    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.interest_requests        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.members                  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.membership_applications  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.opportunities            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.participants             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.projects                 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.thanks_emails            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.users                    FORCE ROW LEVEL SECURITY;
