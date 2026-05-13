-- Port of netlify/database/migrations/0005_apply_form_v2.sql
--
-- Expand membership_applications + members to match the production apply.html
-- form. Introduces national_id as the natural identifier the signup-by-NID
-- flow looks up. Hand-port from Netlify, unchanged.

-- ─── members: natural identifier (NID) ──────────────────────────────────
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS national_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_members_national_id
  ON members(national_id) WHERE national_id IS NOT NULL;

-- ─── membership_applications: full apply-form-v2 spec ───────────────────
ALTER TABLE membership_applications
  -- Identity
  ADD COLUMN IF NOT EXISTS national_id             TEXT,
  ADD COLUMN IF NOT EXISTS name_ar                 TEXT,
  ADD COLUMN IF NOT EXISTS name_en                 TEXT,
  ADD COLUMN IF NOT EXISTS date_of_birth           DATE,

  -- Contact
  ADD COLUMN IF NOT EXISTS address_melbourne       TEXT,
  ADD COLUMN IF NOT EXISTS phone_country_code      TEXT,

  -- Sponsorship / scholarship
  ADD COLUMN IF NOT EXISTS scholarship_entity       TEXT,
  ADD COLUMN IF NOT EXISTS scholarship_entity_other TEXT,

  -- Study
  ADD COLUMN IF NOT EXISTS study_level             TEXT,
  ADD COLUMN IF NOT EXISTS degree_field            TEXT,
  ADD COLUMN IF NOT EXISTS university              TEXT,
  ADD COLUMN IF NOT EXISTS university_other        TEXT,
  ADD COLUMN IF NOT EXISTS study_started_window    TEXT,
  ADD COLUMN IF NOT EXISTS expected_graduation_window TEXT,

  -- About / extras
  ADD COLUMN IF NOT EXISTS cv_url                  TEXT,
  ADD COLUMN IF NOT EXISTS skills_hobbies          TEXT,
  ADD COLUMN IF NOT EXISTS about_self              TEXT,
  ADD COLUMN IF NOT EXISTS referral_source         TEXT,
  ADD COLUMN IF NOT EXISTS referral_source_other   TEXT,
  ADD COLUMN IF NOT EXISTS suggestions             TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_accepted   BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_apps_national_id ON membership_applications(national_id);
