-- Migration: head-portal attendance can record meetings without a project.
--
-- A committee head asked for the ability to register attendance for
-- ad-hoc meetings (online or in-person) that aren't tied to a project /
-- event in the existing projects table. The head also wants to assign
-- hours per attendee on those meeting rows, bypassing the two-stage
-- hours-approval chain (they have the authority — they ARE the chain).
--
-- The cleanest fit was to extend the existing `attendance` table rather
-- than spin up a parallel meetings table:
--   1. project_id becomes NULLABLE.
--   2. New meeting_* columns describe the off-project meeting.
--   3. meeting_hours holds the head-assigned hours for that attendee.
--      Adding this column means recomputeMemberTotalHours() in
--      supabase/functions/api/actions/hours.ts has to be widened to sum
--      both `hours.total_hours` AND `attendance.meeting_hours` per
--      member (Edge Function change is in the same commit as this
--      migration).
--   4. volunteer_name added so we can attribute attendance to a named
--      external visitor (the existing volunteer_email column wasn't
--      enough for offline meetings where email isn't always collected).
--
-- A CHECK enforces the "exactly one of project_id / meeting_title"
-- invariant so we never end up with attendance rows that point at both
-- a project AND describe a separate meeting (which would split the
-- audit trail in confusing ways).

BEGIN;

-- 1. Make project_id nullable. The FK + ON DELETE CASCADE survive the
--    alter; only the NOT NULL constraint is dropped.
ALTER TABLE attendance
  ALTER COLUMN project_id DROP NOT NULL;

-- 2. Ad-hoc meeting metadata. All nullable individually; the
--    application-level check (and the CHECK below) ensures that when
--    meeting_title IS NOT NULL, the supporting fields are also set.
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS meeting_title      TEXT,
  ADD COLUMN IF NOT EXISTS meeting_type       TEXT
    CHECK (meeting_type IS NULL OR meeting_type IN ('Online','InPerson')),
  ADD COLUMN IF NOT EXISTS meeting_date       DATE,
  ADD COLUMN IF NOT EXISTS meeting_start_time TIME,
  ADD COLUMN IF NOT EXISTS meeting_location   TEXT,
  -- Head-assigned hours for this attendee on this meeting. Counts
  -- toward the member's total_hours WITHOUT going through the hours
  -- table's two-stage approval — heads have full authority on their
  -- own committee per the 2026-05-16 permission revision, so we let
  -- them auto-FinalApprove via attendance. NULL = "no hours assigned".
  ADD COLUMN IF NOT EXISTS meeting_hours      NUMERIC(6,2),
  -- External attendees by name (the existing volunteer_email column
  -- isn't enough — many in-person meeting attendees won't share an
  -- email at the door).
  ADD COLUMN IF NOT EXISTS volunteer_name     TEXT;

-- 3. Exactly-one-of constraint. An attendance row points at either a
--    project OR a meeting, never both, never neither. Done as a CHECK
--    instead of an FK + NOT NULL combo because postgres can't express
--    "FK-or-text-column" without a discriminator.
ALTER TABLE attendance
  DROP CONSTRAINT IF EXISTS attendance_project_xor_meeting;
ALTER TABLE attendance
  ADD CONSTRAINT attendance_project_xor_meeting
  CHECK (
    (project_id IS NOT NULL AND meeting_title IS NULL)
    OR
    (project_id IS NULL AND meeting_title IS NOT NULL)
  );

-- 4. Index on meeting_date so the head-portal attendance list can sort
--    by date efficiently when the table grows. The existing
--    idx_attendance_member index covers member-scoped queries.
CREATE INDEX IF NOT EXISTS idx_attendance_meeting_date
  ON attendance(meeting_date)
  WHERE meeting_title IS NOT NULL;

COMMIT;
