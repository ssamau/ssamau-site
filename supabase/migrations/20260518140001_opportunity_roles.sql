-- Multi-role opportunities — president's spec 2026-05-18.
--
-- Until now, an `opportunities` row carried exactly one role
-- (`role_name`, `role_key`, `estimated_hours`, `headcount_needed`).
-- That model can't represent the common reality: an event needs
-- several distinct roles, and a member who wants to help often has
-- a preference (or "help with anything"). Going forward, an
-- opportunity is the EVENT-level entry; roles live in a child table.
--
-- Data shape:
--   opportunities (existing columns kept for backwards compat with
--   the old admin form + email templates while the rollout lands,
--   marked legacy via column comments. The new flow ignores them
--   and reads from opportunity_roles.)
--
--   opportunity_roles (NEW)
--     - opportunity_id  → opportunities.opportunity_id (CASCADE on delete)
--     - role_name       — text, required
--     - role_key        — optional canonical id (for the role-preset menu)
--     - estimated_hours
--     - headcount_needed
--     - notes
--     - sort_order      — admin-controlled display order
--
--   interest_requests gains two nullable columns + new partial unique
--   indexes:
--     - opportunity_id  → opportunities.opportunity_id
--     - role_id         → opportunity_roles.id (NULL = "any role")
--   Legacy (project-level) interest rows keep opportunity_id NULL and
--   the existing (project_id, member_id) unique constraint stays
--   enforceable through a partial index limited to those rows.
--
-- Backfill: every existing opportunities row gets one auto-created
-- opportunity_roles entry mirroring its legacy fields, so the join
-- always returns at least one role. Frontend can render single-role
-- opportunities identically to before.
--
-- Reversibility: dropping opportunity_roles would lose the new admin's
-- role-list edits. The legacy columns on opportunities are preserved
-- so a rollback is feasible until we drop them in a follow-up
-- migration (not in scope here).

-- ─── opportunity_roles ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.opportunity_roles (
  id                BIGSERIAL PRIMARY KEY,
  opportunity_id    TEXT NOT NULL REFERENCES public.opportunities(opportunity_id) ON DELETE CASCADE,
  role_name         TEXT NOT NULL,
  role_key          TEXT,
  estimated_hours   NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (estimated_hours >= 0),
  headcount_needed  INTEGER NOT NULL DEFAULT 1 CHECK (headcount_needed >= 0),
  notes             TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opportunity_roles_opp
  ON public.opportunity_roles (opportunity_id, sort_order);

-- One-time backfill from the legacy single-role columns. The WHERE
-- clause makes it idempotent — re-running this migration won't
-- duplicate rows.
INSERT INTO public.opportunity_roles
  (opportunity_id, role_name, role_key, estimated_hours, headcount_needed)
SELECT o.opportunity_id,
       COALESCE(o.role_name, '—'),
       o.role_key,
       o.estimated_hours,
       o.headcount_needed
FROM   public.opportunities o
WHERE  NOT EXISTS (
  SELECT 1 FROM public.opportunity_roles r
  WHERE  r.opportunity_id = o.opportunity_id
);

COMMENT ON COLUMN public.opportunities.role_name        IS 'LEGACY (pre-2026-05-18). New flow reads from opportunity_roles. Kept for backwards-compat with old admin form / email templates while the rollout lands.';
COMMENT ON COLUMN public.opportunities.role_key         IS 'LEGACY (pre-2026-05-18). See opportunity_roles.role_key.';
COMMENT ON COLUMN public.opportunities.estimated_hours  IS 'LEGACY (pre-2026-05-18). See opportunity_roles.estimated_hours.';
COMMENT ON COLUMN public.opportunities.headcount_needed IS 'LEGACY (pre-2026-05-18). See opportunity_roles.headcount_needed.';

-- ─── interest_requests: opportunity_id + role_id ─────────────────────
ALTER TABLE public.interest_requests
  ADD COLUMN IF NOT EXISTS opportunity_id TEXT
    REFERENCES public.opportunities(opportunity_id) ON DELETE CASCADE;

ALTER TABLE public.interest_requests
  ADD COLUMN IF NOT EXISTS role_id BIGINT
    REFERENCES public.opportunity_roles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.interest_requests.opportunity_id IS
  'When set, the interest is for a specific opportunity (not project-level). Required for new multi-role interest flow.';
COMMENT ON COLUMN public.interest_requests.role_id IS
  'Optional role within the opportunity. NULL = "any role" — member is willing to help where most needed. Set when set the head still picks which role to assign on the assignment side.';

-- Two partial unique indexes replace the existing
-- (project_id, member_id) constraint:
--   - rows with opportunity_id NULL: legacy project-level interest →
--     unique per (project_id, member_id) as before.
--   - rows with opportunity_id NOT NULL: multi-role interest →
--     unique per (opportunity_id, member_id). One row per
--     (member, opportunity) — the role choice flips via UPDATE on
--     the same row, not a second insert.
DO $$
BEGIN
  -- Drop the original constraint if present (its name was assigned by
  -- the initial schema). Idempotent: skip if it's already gone.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'interest_requests_project_id_member_id_key'
  ) THEN
    ALTER TABLE public.interest_requests
      DROP CONSTRAINT interest_requests_project_id_member_id_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_interest_project_member_legacy
  ON public.interest_requests (project_id, member_id)
  WHERE opportunity_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_interest_opportunity_member
  ON public.interest_requests (opportunity_id, member_id)
  WHERE opportunity_id IS NOT NULL;
