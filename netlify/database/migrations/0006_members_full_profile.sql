-- Denormalise the rest of the application-time fields onto `members` so that
-- the bulk-import (and any future apply-form-v2 → accept path) can store the
-- full profile in one row. Until now those fields lived only on the
-- applications table; the imported leadership/member list never went through
-- that flow, so without these columns the data would be lost.
--
-- Phones: the xlsx ships TWO phone numbers per row (`رقم الجوال` and
-- `رقم الواتس اب`) and many people legitimately have both — one Saudi
-- (+966) and one Australian (+61). We store each as a standalone E.164
-- string. The existing `members.phone` column is reused for the primary
-- phone; the new `members.whatsapp` column holds the second number.

ALTER TABLE members
  -- Contact
  ADD COLUMN IF NOT EXISTS whatsapp                   TEXT,
  -- Identity
  ADD COLUMN IF NOT EXISTS name_en                    TEXT,
  ADD COLUMN IF NOT EXISTS date_of_birth              DATE,
  ADD COLUMN IF NOT EXISTS address_melbourne          TEXT,
  -- Sponsorship + study
  ADD COLUMN IF NOT EXISTS scholarship_entity         TEXT,
  ADD COLUMN IF NOT EXISTS scholarship_entity_other   TEXT,
  ADD COLUMN IF NOT EXISTS study_level                TEXT,
  ADD COLUMN IF NOT EXISTS degree_field               TEXT,
  ADD COLUMN IF NOT EXISTS university                 TEXT,
  ADD COLUMN IF NOT EXISTS university_other           TEXT,
  ADD COLUMN IF NOT EXISTS study_started_window       TEXT,
  ADD COLUMN IF NOT EXISTS expected_graduation_window TEXT,
  -- About
  ADD COLUMN IF NOT EXISTS skills_hobbies             TEXT,
  ADD COLUMN IF NOT EXISTS about_self                 TEXT,
  ADD COLUMN IF NOT EXISTS cv_url                     TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_url               TEXT;
