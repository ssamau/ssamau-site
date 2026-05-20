-- Apply form role picker — president's spec 2026-05-20.
--
-- The original applicant_type column (20260517190001) allowed two
-- values: 'Member' and 'Volunteer'. The new apply-form UI offers
-- three options:
--   - 'Head'       — عضو إداري (committee leadership)
--   - 'Member'     — عضو
--   - 'Volunteer'  — متطوع
--
-- Currently only 'Volunteer' is selectable (enforced by the server's
-- gateApplicantType helper). 'Member' and 'Head' will be enabled by
-- bumping ENABLED_TYPES in applications.ts when the president gives
-- the green light. Adding 'Head' to the CHECK constraint NOW means
-- the database is ready to store the value without a follow-up
-- migration when that flip happens.

-- Drop the old constraint (its auto-generated name is preserved by
-- looking it up — Postgres assigns these as <table>_<column>_check
-- by default). If it has a custom name, this is a no-op.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM   pg_constraint
  WHERE  conrelid = 'public.membership_applications'::regclass
    AND  contype  = 'c'
    AND  pg_get_constraintdef(oid) ILIKE '%applicant_type%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.membership_applications DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- Re-add with the expanded allowed-values set.
ALTER TABLE public.membership_applications
  ADD CONSTRAINT membership_applications_applicant_type_check
  CHECK (applicant_type IN ('Member', 'Volunteer', 'Head'));

COMMENT ON COLUMN public.membership_applications.applicant_type IS
  'Self-selected role on the apply form: Head, Member, or Volunteer. The server gates which values are currently accepted via gateApplicantType — see applications.ts.';
