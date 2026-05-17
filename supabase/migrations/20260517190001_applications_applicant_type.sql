-- Applications: applicant_type column for the seasonal volunteer/member toggle.
--
-- The public apply form used to be a single intake that admin triaged into
-- Member or Volunteer at the accept step. Going forward (president's call
-- 2026-05-17), the form behaviour is date-driven:
--   Jan 1 — May 31: Member applications accepted (with Volunteer still
--                   available as a side option).
--   Jun 1 — Dec 31: Volunteer-only; the form hides member language and
--                   the server forces applicant_type='Volunteer' regardless
--                   of what the body claims.
--
-- Legacy rows (everything submitted before this migration runs) backfill
-- to 'Member' — that matches the historical accept-path which always
-- created a club_role='Member' row. The president explicitly asked that
-- currently-submitted applications be left as-is.

ALTER TABLE membership_applications
  ADD COLUMN IF NOT EXISTS applicant_type TEXT
    DEFAULT 'Member'
    CHECK (applicant_type IN ('Member', 'Volunteer'));

-- Backfill existing NULLs (the DEFAULT only applies to new INSERTs).
UPDATE membership_applications
SET    applicant_type = 'Member'
WHERE  applicant_type IS NULL;

-- Tighten to NOT NULL now that the column is populated everywhere.
ALTER TABLE membership_applications
  ALTER COLUMN applicant_type SET NOT NULL;

-- Helpful for the admin members tab filter ("show only Volunteer
-- applications so I can invite them as members").
CREATE INDEX IF NOT EXISTS idx_applications_type_status
  ON membership_applications (applicant_type, status);
