-- Member self-attendance with head/admin confirmation.
--
-- Members can record their own attendance; a head or admin confirms it
-- before it counts. All columns below are ADDITIVE with safe defaults, so
-- existing rows and every existing insert path (recordAttendance,
-- head.attendance.record, head.attendance.bulkRecord) are unaffected:
-- they never set these columns, so they get confirmation_status =
-- 'Confirmed' (staff-recorded attendance is auto-confirmed) and
-- self_recorded = false.
--
-- HOURS SAFETY (no change to the recompute math): a Pending self-record
-- keeps meeting_hours NULL and stores the member's claim in
-- proposed_hours. The existing recompute sums
-- attendance.meeting_hours WHERE meeting_hours IS NOT NULL, so a Pending
-- row is invisible to it and credits nothing. On confirm, the server
-- copies proposed_hours -> meeting_hours and runs the *existing*
-- recompute unchanged.

ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS confirmation_status text NOT NULL DEFAULT 'Confirmed',
  ADD COLUMN IF NOT EXISTS self_recorded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmed_by integer,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS proposed_hours numeric,
  ADD COLUMN IF NOT EXISTS rejected_reason text;

-- Constrain the new status enum + FK (guarded so re-runs don't error).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_confirmation_status_check'
  ) THEN
    ALTER TABLE public.attendance
      ADD CONSTRAINT attendance_confirmation_status_check
      CHECK (confirmation_status IN ('Pending','Confirmed','Rejected'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_confirmed_by_fkey'
  ) THEN
    ALTER TABLE public.attendance
      ADD CONSTRAINT attendance_confirmed_by_fkey
      FOREIGN KEY (confirmed_by) REFERENCES public.users(id);
  END IF;
END$$;

-- Partial index: fast lookup of a member's outstanding self-records and
-- of a committee's pending-confirmation queue.
CREATE INDEX IF NOT EXISTS idx_attendance_pending_self
  ON public.attendance (member_id)
  WHERE self_recorded = true AND confirmation_status = 'Pending';
