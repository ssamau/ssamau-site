-- Make hours.project_id nullable so meeting attendance (which has no
-- linked project) can be represented as a hours row.
--
-- Context: 2026-05-21 president's integrity ask. Before this, credits
-- lived in two places: hours table + attendance.meeting_hours. Now
-- the hours table is the single canonical source, and meeting
-- attendance auto-creates a linked hours row via _syncMeetingHoursRow
-- in supabase/functions/api/actions/attendance.ts. Committee meetings
-- have no project_id; that row needs to exist with project_id NULL.
--
-- The foreign key constraint hours_project_id_fkey is preserved — a
-- non-null project_id still has to reference an existing project.
-- NULL just means "no project linked".

ALTER TABLE public.hours ALTER COLUMN project_id DROP NOT NULL;
