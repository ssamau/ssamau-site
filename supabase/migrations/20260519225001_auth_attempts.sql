-- Brute-force lockout state — security audit findings M1 + M2.
--
-- Two endpoints needed an attempt counter:
--   M1 — legacy `auth` action (bcrypt login). Without lockout, a leaked
--   password_hash + GPU = recoverable password in hours (bcrypt rounds
--   were set to 6 by the original seed). All 4 remaining legacy
--   accounts have rotated passwords, but the structural gap remains.
--
--   M2 — `auth.signup.completeByPin`. The 6-digit PIN has 10^6 search
--   space and 72h validity; bcrypt's 100ms comparison slows brute force
--   but doesn't stop a scripted attacker.
--
-- Design: a SINGLE shared table in a `private` schema (not exposed via
-- PostgREST). Each failed attempt INSERTs a row. The handler counts
-- rows in a sliding window before allowing the next attempt. On success
-- DELETE all rows for that identifier so the next legitimate login
-- starts fresh.
--
-- Schema choice: `private` (not `public`). PostgREST exposes the
-- `public` schema by default; an `auth_attempts` table there would be
-- queryable via `/rest/v1/auth_attempts` with the anon key. The Edge
-- Function uses the service-role client which sees all schemas — so
-- moving the table to `private` removes the PostgREST surface without
-- changing the handler's access pattern.

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.auth_attempts (
  id         BIGSERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,             -- username, member_id:pin, etc.
  bucket     TEXT NOT NULL,             -- 'auth' | 'pin'
  failed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip         TEXT,                      -- optional context for audit logs
  user_agent TEXT                       -- optional context for audit logs
);

-- Sliding-window queries always filter by (identifier, bucket, failed_at).
-- The composite index covers both the lookup AND the DELETE on success.
CREATE INDEX IF NOT EXISTS idx_auth_attempts_identifier_bucket_time
  ON private.auth_attempts (identifier, bucket, failed_at DESC);

-- Auto-prune rows older than 7 days so the table doesn't grow forever.
-- A nightly cron would be cleaner, but Supabase cron requires extra
-- setup (pg_cron + grants) — the in-line cleanup inside the handler
-- below covers it at write time.

COMMENT ON TABLE private.auth_attempts IS
  'Failed-auth counter. INSERT on failure, DELETE on success. Sliding window of recent rows by (identifier, bucket) determines lockout state. See _helpers.ts:checkLockout / recordFailedAttempt.';
