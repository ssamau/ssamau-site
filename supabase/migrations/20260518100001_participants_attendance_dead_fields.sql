-- Recover dead form fields on participants + attendance.
--
-- 2026-05-17 audit found the admin Participants and Attendance forms
-- collect fields the schema doesn't have:
--
--   Participants form:  participation_status / availability_type /
--                       manager_notes / outstanding_flag
--   Attendance form:    checked_by_member_id
--
-- Those values silently dropped on every save — the INSERT statements
-- in actions/participants.ts and actions/attendance.ts never referenced
-- the columns because the columns didn't exist. Worse, the list views
-- read the same fields back to render chips / stars / "who checked"
-- text and showed blanks. President's call (2026-05-18): add the
-- columns and start writing them, don't strip the forms.
--
-- All new columns are nullable so existing rows backfill to NULL on
-- ALTER. The frontend already sends every field on save, so the
-- handler updates (next commit) make the values land where they
-- always should have.

-- ─── PARTICIPANTS ────────────────────────────────────────────────────
ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS participation_status TEXT
    CHECK (participation_status IN ('Confirmed','Pending','Cancelled'));

ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS availability_type TEXT
    CHECK (availability_type IN ('Full','Partial'));

ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS manager_notes TEXT;

ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS outstanding_flag BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.participants.participation_status IS
  'Confirmed / Pending / Cancelled — admin-set per row. Drives the row''s status chip.';
COMMENT ON COLUMN public.participants.availability_type IS
  'Full / Partial — whether the participant is available the whole event or part of it.';
COMMENT ON COLUMN public.participants.outstanding_flag IS
  'Admin marks a participant as "outstanding" — surfaced in the participants list with a ⭐.';

-- ─── ATTENDANCE ──────────────────────────────────────────────────────
-- `recorded_by` already exists (FK to users.id, the system actor who
-- ran the save). `checked_by_member_id` is a separate concept: which
-- club member physically did the attendance check, which may be
-- different from the admin running the data-entry session. Keeps the
-- audit trail readable in Arabic ("checked by فيصل" not "checked by
-- user 1").
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS checked_by_member_id TEXT
    REFERENCES public.members(member_id) ON DELETE SET NULL;

COMMENT ON COLUMN public.attendance.checked_by_member_id IS
  'Member who physically marked attendance at the event. Distinct from recorded_by (the system user who ran the save). NULL when the data-entry admin was also the checker, or pre-migration rows.';
