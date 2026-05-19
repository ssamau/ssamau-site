-- Per-role assignments — president's spec 2026-05-19.
--
-- Why this migration: today an `assignments` row only carries an
-- opportunity_id, not the specific role within that opportunity. The
-- multi-role refactor (2026-05-18) put roles on a child table
-- (opportunity_roles) and tagged each interest_request with role_id,
-- but ASSIGNMENTS never got the role_id column. That has two
-- consequences:
--   1. We can't compute "how many people are confirmed on role X"
--      because assignments don't know which role they belong to.
--   2. Heads can over-fill a role: the assign modal lets them keep
--      adding members past `opportunity_roles.headcount_needed`
--      because nothing checks capacity.
--
-- Fix: add `assignments.role_id` → opportunity_roles(id). Backfill
-- from interest_requests when the (opportunity, member) pair matches.
-- Existing assignments where no interest row exists get NULL (legacy
-- single-role opps already have exactly one role in opportunity_roles,
-- so the frontend can derive their role_id by lookup at read time).

-- ─── Column ──────────────────────────────────────────────────────────
ALTER TABLE public.assignments
  ADD COLUMN IF NOT EXISTS role_id BIGINT
    REFERENCES public.opportunity_roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_assignments_opp_role
  ON public.assignments (opportunity_id, role_id);

COMMENT ON COLUMN public.assignments.role_id IS
  'Optional FK into opportunity_roles. Set when the head/admin picks a specific role for the assignee. NULL is allowed for legacy rows + edge cases (e.g. single-role opportunities where the role is implicit). Capacity guard counts assignments per (opportunity_id, role_id).';

-- ─── Backfill from interest_requests ─────────────────────────────────
-- For every existing assignment, if there's a matching interest row
-- for the same (opportunity, member) with a role_id, adopt it.
-- Skipped when:
--   - assignments.role_id already set (idempotent re-runs)
--   - no interest row exists (manual assignment, head added directly)
--   - interest row has role_id NULL ("any role" — head was supposed
--     to pick on assign but never did; leave as NULL)
UPDATE public.assignments a
SET    role_id = ir.role_id
FROM   public.interest_requests ir
WHERE  a.role_id IS NULL
  AND  a.opportunity_id = ir.opportunity_id
  AND  a.member_id      = ir.member_id
  AND  ir.role_id IS NOT NULL;

-- For SINGLE-role opportunities (only one row in opportunity_roles),
-- backfill the role_id automatically — there's no ambiguity. This
-- catches legacy assignments that pre-date the multi-role refactor.
UPDATE public.assignments a
SET    role_id = r.id
FROM   public.opportunity_roles r
WHERE  a.role_id IS NULL
  AND  a.opportunity_id = r.opportunity_id
  AND  (SELECT COUNT(*) FROM public.opportunity_roles r2
        WHERE r2.opportunity_id = a.opportunity_id) = 1;
