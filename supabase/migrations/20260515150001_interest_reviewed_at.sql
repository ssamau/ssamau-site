-- Interest workflow — add a `reviewed_at` timestamp so admins can
-- triage the طلبات المشاركة tab without losing history.
--
-- ── Why ────────────────────────────────────────────────────────────
-- Before this migration, interest_requests rows were immortal — every
-- "اهتمام" click stayed visible in the admin tab forever. With the
-- member portal now letting members self-submit, that list will grow
-- to dozens of rows per event. Admins need a way to mark "I've seen
-- this and dealt with it" without deleting the row (we want the
-- audit trail of who-expressed-interest-in-what).
--
-- ── Model ──────────────────────────────────────────────────────────
-- reviewed_at  IS NULL  → un-triaged, render at top of the list
-- reviewed_at  NOT NULL → triaged at that time, fade to bottom of list
-- The frontend filter can also hide reviewed rows entirely (toggle).
--
-- Setting it is via `interest.markReviewed`; un-setting (e.g. admin
-- wants to reconsider) is the same action with reviewed=false.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS lets re-apply be a no-op.

ALTER TABLE public.interest_requests
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.interest_requests.reviewed_at IS
  'Admin triage timestamp. NULL = unreviewed (default). Set via interest.markReviewed when the admin has acted on the request (typically by assigning the member to an opportunity).';

-- Helpful for the admin tab default-sort (unreviewed first, then
-- reviewed by date). NULLs FIRST on DESC needs the explicit clause.
CREATE INDEX IF NOT EXISTS idx_interest_reviewed_at
  ON public.interest_requests (reviewed_at NULLS FIRST, submitted_at DESC);
