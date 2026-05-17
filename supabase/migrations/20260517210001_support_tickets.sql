-- Support tickets — in-product channel for users to report bugs,
-- request features, or ask questions. Each ticket fans out to the dev's
-- inbox (xtlg511@icloud.com) on submit; superadmin sees the queue in
-- a new admin tab.
--
-- Attachments live in a PRIVATE storage bucket (`support-attachments`)
-- so screenshots that might contain account state / PII aren't exposed
-- to the public URL space. The admin tab fetches a 1h signed URL on
-- demand when the dev opens a ticket.
--
-- Manual one-time deploy step (bucket can't be created from a migration
-- because the migration role lacks ALTER on storage.buckets):
--   1. In the Supabase dashboard → Storage → Create bucket
--      "support-attachments", PRIVATE (uncheck "Public bucket").
--   2. No additional RLS policies needed — the Edge Function calls
--      with the service role key.

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id                  BIGSERIAL PRIMARY KEY,
  ticket_id           TEXT UNIQUE NOT NULL,                     -- SUP_XXXXX short id
  reporter_user_id    BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  reporter_member_id  TEXT REFERENCES public.members(member_id) ON DELETE SET NULL,
  reporter_email      TEXT,                                     -- snapshot at submit time
  reporter_name       TEXT,                                     -- snapshot at submit time
  reporter_access     TEXT,                                     -- snapshot: 'admin'/'head'/'member'/...
  category            TEXT NOT NULL CHECK (category IN ('Bug','Feature','Question')),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  repro_steps         TEXT,                                     -- nullable; Features + Questions usually skip
  page_url            TEXT,                                     -- window.location.href at submit
  user_agent          TEXT,                                     -- navigator.userAgent
  viewport            TEXT,                                     -- e.g. "1280x800"
  attachment_path     TEXT,                                     -- storage key under support-attachments/
  attachment_mime     TEXT,
  status              TEXT NOT NULL DEFAULT 'Open'
                      CHECK (status IN ('Open','InProgress','Resolved','Closed')),
  resolution_note     TEXT,                                     -- dev's reply notes (admin-only)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ
);

-- The admin queue sorts most-recent-first within an Open/InProgress
-- bucket, then resolved items. Index on status + created_at supports
-- that ordering without a sort.
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_created
  ON public.support_tickets (status, created_at DESC);

-- Reporter lookups for the "my submitted tickets" check (future-proof;
-- not surfaced in the UI yet but cheap to add).
CREATE INDEX IF NOT EXISTS idx_support_tickets_reporter
  ON public.support_tickets (reporter_user_id, created_at DESC);
