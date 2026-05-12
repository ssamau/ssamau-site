-- Expanded membership-application schema to match the production apply.html
-- form. The §6 doc says applicants supply identity + contact + study + a few
-- discretionary text fields; previously we only captured a subset. This
-- migration adds the rest and introduces `national_id` as the natural key
-- that the upcoming signup-by-reference flow will look up.

-- ─── members: add the natural identifier ──────────────────────────────────────
-- Surrogate key (member_id MBR_xxx) stays as the primary key — every existing
-- foreign key still works. national_id is a *separate* unique column used by
-- the signup-from-reference flow to find a pre-imported member.
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS national_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_members_national_id
  ON members(national_id) WHERE national_id IS NOT NULL;

-- ─── membership_applications: expand to the full apply-form-v2 spec ───────────
ALTER TABLE membership_applications
  -- Identity (matched against NID / passport)
  ADD COLUMN IF NOT EXISTS national_id             TEXT,
  ADD COLUMN IF NOT EXISTS name_ar                 TEXT,         -- 4-part Arabic name
  ADD COLUMN IF NOT EXISTS name_en                 TEXT,         -- 4-part English name
  ADD COLUMN IF NOT EXISTS date_of_birth           DATE,

  -- Contact
  ADD COLUMN IF NOT EXISTS address_melbourne       TEXT,
  ADD COLUMN IF NOT EXISTS phone_country_code      TEXT,         -- '+966' | '+61'

  -- Sponsorship / scholarship — canonical key + Other free-text fallback.
  -- See apply.html for the full list of canonical values.
  ADD COLUMN IF NOT EXISTS scholarship_entity       TEXT,
  ADD COLUMN IF NOT EXISTS scholarship_entity_other TEXT,

  -- Study
  ADD COLUMN IF NOT EXISTS study_level             TEXT,
    -- 'PhD' | 'Masters' | 'Bachelor' | 'Diploma' | 'Language'
  ADD COLUMN IF NOT EXISTS degree_field            TEXT,
  ADD COLUMN IF NOT EXISTS university              TEXT,
    -- canonical: 'melbourne' | 'monash' | 'rmit' | 'deakin' | 'latrobe' |
    -- 'swinburne' | 'victoria' | 'acu' | 'other'
  ADD COLUMN IF NOT EXISTS university_other        TEXT,
  ADD COLUMN IF NOT EXISTS study_started_window    TEXT,
    -- '<6mo' | '6mo-1y' | '>1y'
  ADD COLUMN IF NOT EXISTS expected_graduation_window TEXT,
    -- 'Jul2027' | 'Dec2027' | '2028+'

  -- About / extras
  ADD COLUMN IF NOT EXISTS cv_url                  TEXT,
  ADD COLUMN IF NOT EXISTS skills_hobbies          TEXT,
  ADD COLUMN IF NOT EXISTS about_self              TEXT,
  ADD COLUMN IF NOT EXISTS referral_source         TEXT,
    -- 'twitter' | 'snapchat' | 'instagram' | 'whatsapp' | 'website' |
    -- 'friend' | 'other'
  ADD COLUMN IF NOT EXISTS referral_source_other   TEXT,
  ADD COLUMN IF NOT EXISTS suggestions             TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_accepted   BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_apps_national_id ON membership_applications(national_id);

-- ─── notes ────────────────────────────────────────────────────────────────────
-- `full_name` stays on membership_applications for backward compat; we now
-- expect new submissions to also fill `name_ar` (and treat it as canonical for
-- display). `pitch` is superseded by `about_self` but stays so the in-flight
-- rows from before this migration still read cleanly.
