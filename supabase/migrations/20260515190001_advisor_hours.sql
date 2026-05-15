-- Advisor-with-hours role (Phase D of post-beta roadmap).
--
-- ── Why ────────────────────────────────────────────────────────────
-- President's feedback (2026-05-15): senior figures who advise the
-- club at the club level (not embedded in a committee) — the club
-- president, the cultural attaché's liaison, etc. — should get hours
-- logged for the time they put in, even though they have no system
-- access and aren't part of any committee. Currently `advisors`
-- exists as a directory table but there's no link to the hours
-- workflow.
--
-- ── Model ──────────────────────────────────────────────────────────
-- Mirror what `members` already does:
--   - advisors.total_hours: cached sum of FinalApproved hours for
--     that advisor (NUMERIC(10,2) NOT NULL DEFAULT 0 — same shape
--     as members.total_hours).
--   - hours.advisor_id: nullable FK to advisors.id. New rows pick
--     ONE of (member_id, advisor_id, volunteer_email) to identify
--     the participant. The Edge Function enforces "exactly one";
--     no DB-level CHECK because existing rows may technically have
--     both member_id and volunteer_email set in legacy edge cases
--     and we don't want to retro-break those.
--   - participant_type now accepts 'advisor' as a label alongside
--     the existing 'member' / 'volunteer'. Free-form TEXT — no
--     CHECK constraint, the value is purely informational.
--
-- The same two-stage approval chain applies (Draft → PrimaryApproved
-- → FinalApproved). The recompute helper in hours.ts will be
-- extended in this same PR to recalc advisor totals.
--
-- Idempotent.

ALTER TABLE public.advisors
  ADD COLUMN IF NOT EXISTS total_hours NUMERIC(10,2) NOT NULL DEFAULT 0;

ALTER TABLE public.hours
  ADD COLUMN IF NOT EXISTS advisor_id INTEGER NULL
    REFERENCES public.advisors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hours_advisor
  ON public.hours (advisor_id)
  WHERE advisor_id IS NOT NULL;

COMMENT ON COLUMN public.advisors.total_hours IS
  'Cached sum of FinalApproved hours rows where advisor_id = this row. Maintained by recomputeAdvisorTotalHours() in actions/hours.ts. Mirrors members.total_hours.';

COMMENT ON COLUMN public.hours.advisor_id IS
  'Optional link to the advisor whose contribution this row represents. Mutually exclusive with member_id + volunteer_email at the application layer (enforced in recordHours / recordAdvisorHours).';
