-- Port of netlify/database/migrations/0006_members_full_profile.sql
--
-- Denormalise the application-time fields onto members so bulk-import (and
-- any future apply-form-v2 → accept path) can persist the full profile in
-- one row. xlsx ships dual phones (`رقم الجوال` + `رقم الواتس اب`), each
-- stored as standalone E.164 — primary phone reuses members.phone, the
-- second number lives on the new whatsapp column.
-- Hand-port from Netlify, unchanged.

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
