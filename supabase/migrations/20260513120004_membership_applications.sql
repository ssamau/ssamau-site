-- Port of netlify/database/migrations/0004_membership_applications.sql
--
-- Public form on /apply.html submits → row lands here at status='PendingTriage'.
-- Presidency triages to a committee → AssignedToCommittee. Committee head
-- Accepts (creates a members row), Rejects (with reason), or asks for an
-- interview. After Accepted, application carries the created member_id.
-- Hand-port from Netlify, unchanged.

CREATE TABLE IF NOT EXISTS membership_applications (
  application_id          TEXT PRIMARY KEY,

  -- Applicant-supplied fields. Email + phone optional but at least one is
  -- required (CHECK constraint at the bottom).
  full_name               TEXT NOT NULL,
  preferred_name          TEXT,
  email                   TEXT,
  phone                   TEXT,
  university              TEXT,
  major                   TEXT,
  gender                  TEXT,

  -- Committees the applicant ranked + optional motivation paragraph.
  interests               TEXT[] NOT NULL DEFAULT '{}',
  pitch                   TEXT,

  -- Workflow.
  status                  TEXT NOT NULL DEFAULT 'PendingTriage'
    CHECK (status IN ('PendingTriage','AssignedToCommittee','InterviewRequested','Accepted','Rejected')),
  -- The committee the presidency triaged the application to. After Accepted
  -- this is also the member's home committee.
  assigned_committee_id   TEXT REFERENCES committees(committee_id) ON DELETE SET NULL,

  -- Decision audit.
  decided_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at              TIMESTAMPTZ,
  decision_reason         TEXT,
  -- Set when status flips to 'Accepted' — points at the row we created in
  -- members. Helps reconcile applications ↔ active members later.
  created_member_id       TEXT REFERENCES members(member_id) ON DELETE SET NULL,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Sanity: at least one contact method.
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_apps_status     ON membership_applications(status);
CREATE INDEX IF NOT EXISTS idx_apps_committee  ON membership_applications(assigned_committee_id);
CREATE INDEX IF NOT EXISTS idx_apps_created_at ON membership_applications(created_at);

-- Reuse the shared updated_at trigger.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgname = 'set_updated_at'
                   AND tgrelid = 'membership_applications'::regclass) THEN
    EXECUTE 'CREATE TRIGGER set_updated_at BEFORE UPDATE ON membership_applications
             FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at()';
  END IF;
END$$;
