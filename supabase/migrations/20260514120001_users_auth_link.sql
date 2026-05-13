-- Add the link from the legacy `public.users` table to Supabase Auth's
-- `auth.users` table. Migration step 1 of N for the auth cutover.
--
-- Design:
--   - auth_user_id UUID, nullable, references auth.users(id) ON DELETE SET NULL.
--   - NULL = legacy account (still authenticates via public.users.password_hash +
--     custom HS256 JWT minted by the Edge Function's `auth` action).
--   - non-NULL = migrated account (authenticates via Supabase Auth's
--     signInWithPassword + Supabase-issued JWT; the public.users row becomes
--     just an app-level profile carrying access_level + member_id).
--
-- The column is nullable indefinitely. Once every account has an
-- auth.users row we may add NOT NULL via a follow-up migration, but
-- four leadership accounts (president, lead_mbr_r82ypy, lead_mbr_enftku,
-- lead_mbr_22wj7q) intentionally stay on legacy until their owners
-- supply an email — so for now nullable is correct.
--
-- ON DELETE SET NULL is the right cascade: if a row is removed from
-- auth.users (admin-side account deletion via Supabase dashboard, or
-- the eventual GDPR-style hard-delete from member self-service), we
-- don't want the public.users row to vanish — it still owns hours
-- approvals, attendance records, etc. via assignments.assigned_by and
-- other FKs. The account just reverts to "no auth source", and an
-- admin can re-link or delete the public.users row manually.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_user_id UUID
    REFERENCES auth.users(id) ON DELETE SET NULL;

-- Looking up users by their auth.users.id is the hot path in the
-- Edge Function's authentication middleware — every authed request
-- does a `SELECT ... FROM users WHERE auth_user_id = $1`. Index it.
-- Partial index because most queries care about migrated accounts
-- only; the four legacy stragglers with NULL get found via the
-- existing username unique index.
CREATE INDEX IF NOT EXISTS users_auth_user_id_idx
  ON public.users (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- Note on enforcement: we don't add a UNIQUE constraint on auth_user_id
-- yet. Conceptually one auth.users row → one public.users row, but
-- making it UNIQUE now would block re-running the backfill script if
-- one user accidentally gets two auth.users rows (which the backfill
-- guards against, but better not to compound mistakes with hard DB
-- constraints during the transition). After the auth-migration commits
-- stabilise we'll add `UNIQUE (auth_user_id)` in a follow-up migration.

COMMENT ON COLUMN public.users.auth_user_id IS
  'Link to auth.users.id for accounts migrated to Supabase Auth. NULL = legacy bcrypt+HS256 account. See supabase/migrations/20260514120001 for design notes.';
