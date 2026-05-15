-- Projects — add cover_photo_url for homepage event-card display.
--
-- ── Why ────────────────────────────────────────────────────────────
-- President's feedback (2026-05-15): "I want each event to be shown
-- with photos if any, number of attendees, project manager or event
-- manager according to size."
--
-- The homepage's renderRecentEvents() reads from `projects` to
-- populate the "آخر فعالياتنا" grid. Today the cards are text-only
-- because the schema doesn't carry a cover-photo path. This column
-- adds it. The frontend will resolve it to a public-bucket URL
-- (project-photos bucket; created via Management API since the
-- migration role can't ALTER storage.buckets).
--
-- Path scheme inside the bucket: <project_id>/<filename>
-- The column stores the PUBLIC URL directly (not a storage path)
-- since the bucket is public — saves a per-card signed-URL fetch on
-- every homepage load, which would otherwise add up fast at scale.
--
-- Idempotent.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS cover_photo_url TEXT NULL;

COMMENT ON COLUMN public.projects.cover_photo_url IS
  'Public URL of the event hero photo (project-photos bucket). NULL = no photo, renderer falls back to a coloured gradient header. Added 2026-05-15 for the homepage events display upgrade.';
