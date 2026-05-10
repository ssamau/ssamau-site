-- SSAMAU schema for Netlify DB (Neon Postgres)
-- Mirrors the Google Sheet structure today; new entities (applications, opportunities,
-- help_requests, ...) come in a follow-up plan.

-- ─── COMMITTEES ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS committees (
  committee_id                  TEXT PRIMARY KEY,
  committee_name                TEXT NOT NULL,
  committee_description         TEXT,
  committee_head_member_id      TEXT,
  committee_vice_head_member_id TEXT,
  status                        TEXT NOT NULL DEFAULT 'Active',
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── MEMBERS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
  member_id          TEXT PRIMARY KEY,
  full_name          TEXT NOT NULL,
  preferred_name     TEXT,
  email              TEXT,
  phone              TEXT,
  gender             TEXT,
  profile_photo_url  TEXT,
  committee_id       TEXT REFERENCES committees(committee_id) ON DELETE SET NULL,
  club_role          TEXT,
  status             TEXT NOT NULL DEFAULT 'Active',
  join_date          DATE,
  total_hours        NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_committee ON members(committee_id);
CREATE INDEX IF NOT EXISTS idx_members_status    ON members(status);

-- Committee head/vice-head FKs (deferred — members table didn't exist yet when committees was created)
ALTER TABLE committees
  DROP CONSTRAINT IF EXISTS committees_head_fk,
  ADD CONSTRAINT committees_head_fk
    FOREIGN KEY (committee_head_member_id) REFERENCES members(member_id) ON DELETE SET NULL;
ALTER TABLE committees
  DROP CONSTRAINT IF EXISTS committees_vice_head_fk,
  ADD CONSTRAINT committees_vice_head_fk
    FOREIGN KEY (committee_vice_head_member_id) REFERENCES members(member_id) ON DELETE SET NULL;

-- ─── USERS (login credentials) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  member_id     TEXT REFERENCES members(member_id) ON DELETE CASCADE,
  access_level  TEXT NOT NULL CHECK (access_level IN ('superadmin','head','member','volunteer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- ─── ADVISORS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS advisors (
  id             SERIAL PRIMARY KEY,
  full_name      TEXT NOT NULL,
  advisory_role  TEXT,
  email          TEXT,
  phone          TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'Active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── PROJECTS / EVENTS (combined) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  project_id                          TEXT PRIMARY KEY,
  project_name                        TEXT NOT NULL,
  project_type                        TEXT NOT NULL DEFAULT 'Event' CHECK (project_type IN ('Project','Event')),
  project_description                 TEXT,
  event_date                          DATE,
  start_time                          TIME,
  end_time                            TIME,
  location                            TEXT,
  proposal_file_url                   TEXT,
  created_by_member_id                TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  assigned_project_manager_member_id  TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  assigned_event_manager_member_id    TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  owning_committee_id                 TEXT REFERENCES committees(committee_id) ON DELETE SET NULL,
  project_status                      TEXT NOT NULL DEFAULT 'Planned',
  notes                               TEXT,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_date      ON projects(event_date);
CREATE INDEX IF NOT EXISTS idx_projects_status    ON projects(project_status);
CREATE INDEX IF NOT EXISTS idx_projects_committee ON projects(owning_committee_id);

-- ─── PARTICIPANTS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS participants (
  id               SERIAL PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('Member','Volunteer')),
  member_id        TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  volunteer_name   TEXT,
  volunteer_email  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((participant_type = 'Member' AND member_id IS NOT NULL)
      OR (participant_type = 'Volunteer' AND volunteer_name IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_participants_project ON participants(project_id);
CREATE INDEX IF NOT EXISTS idx_participants_member  ON participants(member_id);

-- ─── ATTENDANCE ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id                SERIAL PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  participant_id    INTEGER REFERENCES participants(id) ON DELETE CASCADE,
  member_id         TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  volunteer_email   TEXT,
  attendance_status TEXT NOT NULL CHECK (attendance_status IN ('Present','Absent','Late','Excused','Deleted')),
  notes             TEXT,
  recorded_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attendance_project ON attendance(project_id);
CREATE INDEX IF NOT EXISTS idx_attendance_member  ON attendance(member_id);

-- ─── HOURS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hours (
  id              SERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  member_id       TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  volunteer_email TEXT,
  hours_count     NUMERIC(6,2) NOT NULL CHECK (hours_count >= 0),
  notes           TEXT,
  recorded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hours_project ON hours(project_id);
CREATE INDEX IF NOT EXISTS idx_hours_member  ON hours(member_id);

-- ─── INTEREST REQUESTS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interest_requests (
  id                SERIAL PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  member_id         TEXT NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
  interested        BOOLEAN NOT NULL,
  availability_type TEXT,
  comment           TEXT,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, member_id)
);

-- ─── THANKS EMAILS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS thanks_emails (
  id          SERIAL PRIMARY KEY,
  member_id   TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  project_id  TEXT REFERENCES projects(project_id) ON DELETE CASCADE,
  recipient_email TEXT,
  subject     TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'Sent',
  sent_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── CERTIFICATES ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS certificates (
  id          SERIAL PRIMARY KEY,
  cert_code   TEXT UNIQUE NOT NULL,
  member_id   TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  project_id  TEXT REFERENCES projects(project_id) ON DELETE CASCADE,
  recipient_name  TEXT,
  recipient_email TEXT,
  role        TEXT,
  hours       NUMERIC(6,2),
  issued_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_certs_member  ON certificates(member_id);
CREATE INDEX IF NOT EXISTS idx_certs_project ON certificates(project_id);

-- ─── updated_at triggers ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['committees','members','advisors','projects','attendance','hours']
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS set_updated_at ON %1$I;
       CREATE TRIGGER set_updated_at BEFORE UPDATE ON %1$I
         FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();', t);
  END LOOP;
END$$;
