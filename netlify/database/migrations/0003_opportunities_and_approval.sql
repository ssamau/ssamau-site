-- ─────────────────────────────────────────────────────────────────────────────
-- Phase-1 finish: Opportunities + Assignments + two-stage hour approval (§4, §7)
-- ─────────────────────────────────────────────────────────────────────────────
-- Per the requirements doc:
--   • Opportunity = a role within a Project/Event (e.g. منسق استقبال, مصور),
--     with estimated hours, headcount, owning committee, and a status. The
--     14 standard roles in §12 are surfaced in the UI as a dropdown.
--   • Assignment = one person filling one opportunity. Carries the attendance
--     status — Principle 2 ("لا تُسجَّل فرصة لشخص لم يحضرها") gates hours.
--   • Hours go Draft → PrimaryApproved (by committee head) → FinalApproved
--     (by presidency). members.total_hours rollups count only FinalApproved.
--
-- Test data wipe: existing hours rows are placeholder dev data; this migration
-- truncates them so the new approval workflow starts from a clean slate. (One
-- of three explicit decisions made before this branch was started — see the
-- branch's first commit message.)

-- ─── 1. wipe placeholder hours ────────────────────────────────────────────────
TRUNCATE hours RESTART IDENTITY CASCADE;
UPDATE members SET total_hours = 0;

-- ─── 2. opportunities ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opportunities (
  opportunity_id      TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  role_name           TEXT NOT NULL,
  -- canonical key for §12 standard roles ('reception_coordinator', 'food_lead',
  -- 'photographer', …) or NULL for free-text custom roles. Lets the UI render
  -- the right tag colour and surface the default-hours hint.
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

-- ─── 3. assignments ───────────────────────────────────────────────────────────
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

-- ─── 4. hours: link to assignment + add approval columns ──────────────────────
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

-- ─── 5. updated_at trigger on opportunities ───────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at' AND tgrelid = 'opportunities'::regclass) THEN
    EXECUTE 'CREATE TRIGGER set_updated_at BEFORE UPDATE ON opportunities
             FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at()';
  END IF;
END$$;
