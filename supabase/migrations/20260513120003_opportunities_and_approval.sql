-- Port of netlify/database/migrations/0003_opportunities_and_approval.sql
--
-- Opportunities + Assignments + two-stage hour approval (Draft →
-- PrimaryApproved → FinalApproved). Carries the "no attendance, no hours"
-- gate from the requirements doc. Hand-port from Netlify, unchanged
-- except the placeholder-hours TRUNCATE is omitted — we run this on an
-- empty Supabase DB before the data import, so there's nothing to wipe.

-- ─── opportunities ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opportunities (
  opportunity_id      TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  role_name           TEXT NOT NULL,
  role_key            TEXT,
  estimated_hours     NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (estimated_hours >= 0),
  headcount_needed    INTEGER NOT NULL DEFAULT 1 CHECK (headcount_needed >= 1),
  owning_committee_id TEXT REFERENCES committees(committee_id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'Open'
    CHECK (status IN ('Open','Filled','NeedsHelp','Cancelled','Done')),
  notes               TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opportunities_project   ON opportunities(project_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_committee ON opportunities(owning_committee_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_status    ON opportunities(status);

-- ─── assignments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assignments (
  assignment_id        SERIAL PRIMARY KEY,
  opportunity_id       TEXT NOT NULL REFERENCES opportunities(opportunity_id) ON DELETE CASCADE,
  member_id            TEXT REFERENCES members(member_id) ON DELETE SET NULL,
  volunteer_name       TEXT,
  volunteer_email      TEXT,
  assigned_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  attendance_status    TEXT NOT NULL DEFAULT 'Pending'
    CHECK (attendance_status IN ('Pending','Attended','Absent','Excused')),
  attendance_notes     TEXT,
  attendance_marked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  attendance_marked_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (member_id IS NOT NULL OR volunteer_name IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_assignments_opportunity ON assignments(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_assignments_member      ON assignments(member_id);
CREATE INDEX IF NOT EXISTS idx_assignments_attendance  ON assignments(attendance_status);

-- ─── hours: link to assignment + add approval columns ────────────────────
ALTER TABLE hours
  ADD COLUMN IF NOT EXISTS assignment_id        INTEGER REFERENCES assignments(assignment_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approval_status      TEXT NOT NULL DEFAULT 'Draft'
    CHECK (approval_status IN ('Draft','PrimaryApproved','FinalApproved','Rejected')),
  ADD COLUMN IF NOT EXISTS primary_approver_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS primary_approved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS final_approver_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS final_approved_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_reason      TEXT;

CREATE INDEX IF NOT EXISTS idx_hours_assignment      ON hours(assignment_id);
CREATE INDEX IF NOT EXISTS idx_hours_approval_status ON hours(approval_status);

-- ─── updated_at trigger on opportunities ─────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at' AND tgrelid = 'opportunities'::regclass) THEN
    EXECUTE 'CREATE TRIGGER set_updated_at BEFORE UPDATE ON opportunities
             FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at()';
  END IF;
END$$;
