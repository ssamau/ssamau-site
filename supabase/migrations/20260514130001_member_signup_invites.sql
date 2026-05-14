-- Member signup state on the public.users table.
--
-- Branch 4 (feature/member-portal) introduces a new lifecycle for the
-- ~98 SSAM members who currently exist as `members` rows but have no
-- way to log in. The flow we're scaffolding here:
--
--   1. Admin clicks "Invite to portal" for a member (Members tab).
--   2. Edge Function generates either:
--        - a 64-char hex `signup_token` for an email-link invite, OR
--        - a 6-digit PIN whose bcrypt hash goes in `signup_pin_hash`
--      …and creates a `users` row in "pending signup" state
--      (access_level='member'/'volunteer', password_hash NULL,
--      auth_user_id NULL).
--   3. Member visits /signup.html — either via the email link or by
--      entering their NID + PIN — and chooses a password.
--   4. Edge Function creates an auth.users row via Supabase admin API,
--      links it via `users.auth_user_id`, clears the signup_* columns,
--      stamps `signup_completed_at`.
--
-- State machine on public.users (no CHECK constraint — too rigid
-- during the still-mixed legacy/Supabase transition; documented in
-- column COMMENTs instead):
--
--   Legacy (pre-Supabase-Auth, only 4 holdouts):
--     password_hash NOT NULL, auth_user_id NULL,
--     signup_* NULL.
--
--   Pending signup (after invite, before completion):
--     password_hash NULL, auth_user_id NULL,
--     EXACTLY ONE of signup_token / signup_pin_hash set,
--     matching *_expires_at set,
--     signup_completed_at NULL.
--
--   Active (after completion):
--     password_hash NULL, auth_user_id NOT NULL,
--     signup_token / signup_pin_hash both NULL,
--     signup_completed_at = NOW() at the moment of completion.
--
-- See docs/branch-4-plan.md for the broader plan this migration is
-- the first step of.

-- ─── Allow password_hash to be NULL ─────────────────────────────────────
-- Supabase-only accounts (members + any future leadership signups) have
-- their password held by Supabase Auth, not us. Only the 4 legacy
-- holdouts (president, lead_mbr_enftku, lead_mbr_r82ypy, lead_mbr_22wj7q)
-- still need a non-null value here, and they keep theirs unchanged.
ALTER TABLE public.users
  ALTER COLUMN password_hash DROP NOT NULL;

COMMENT ON COLUMN public.users.password_hash IS
  'bcrypt hash for legacy HS256-auth accounts. NULL = Supabase Auth account (password stored by Supabase under auth_user_id). Only ~4 legacy holdouts have a non-NULL value as of the auth migration.';

-- ─── Signup-by-PIN columns ──────────────────────────────────────────────
-- PIN is 6 digits (10^6 combinations). Brute-forcing in 72h would
-- require ~3.86 attempts/sec at constant rate — feasible for an
-- attacker who knows the target NID. Mitigations:
--   1. Rate-limit `auth.signup.completeByPin` server-side (TBD in
--      Phase 3 — not added here because it's a behaviour, not a
--      schema concern).
--   2. PIN expires in 72h (signup_pin_expires_at).
--   3. Hashed with bcrypt rounds=10 (matches legacy convention,
--      _helpers.bcryptHash default) so even DB-leak doesn't reveal
--      the plaintext.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS signup_pin_hash       TEXT,
  ADD COLUMN IF NOT EXISTS signup_pin_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN public.users.signup_pin_hash IS
  'bcrypt hash of a one-time 6-digit signup PIN (NID-flow invites). Set by auth.invite.byPin, cleared by auth.signup.completeByPin or auth.invite.revoke. NULL = no pending PIN invite.';
COMMENT ON COLUMN public.users.signup_pin_expires_at IS
  'When the signup PIN stops being accepted. auth.invite.byPin sets this to NOW() + 72h. NULL when signup_pin_hash is NULL.';

-- ─── Signup-by-token columns ────────────────────────────────────────────
-- Token is 64 hex chars (256 bits of entropy from crypto.getRandomValues).
-- Brute-force infeasible. UNIQUE so a leaked token can't be reused
-- against another user, and so the lookup query in
-- auth.signup.completeByToken can use the index.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS signup_token            TEXT,
  ADD COLUMN IF NOT EXISTS signup_token_expires_at TIMESTAMPTZ;

-- Separate UNIQUE INDEX rather than column-level UNIQUE so we can make
-- it partial (only enforce uniqueness when the token is non-NULL —
-- most rows have NULL since most users have already completed signup).
-- Postgres handles multi-NULL fine in a regular UNIQUE constraint, but
-- a partial index is cleaner and slightly faster on a large table.
CREATE UNIQUE INDEX IF NOT EXISTS users_signup_token_uniq
  ON public.users (signup_token)
  WHERE signup_token IS NOT NULL;

COMMENT ON COLUMN public.users.signup_token IS
  'Opaque random token (64 hex chars / 256 bits) issued for email-link signup invites. UNIQUE among non-NULL values via users_signup_token_uniq partial index. Set by auth.invite.byEmail, cleared by auth.signup.completeByToken or auth.invite.revoke.';
COMMENT ON COLUMN public.users.signup_token_expires_at IS
  'When the signup token stops being accepted. auth.invite.byEmail sets this to NOW() + 7d. NULL when signup_token is NULL.';

-- ─── Completion timestamp ──────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS signup_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.users.signup_completed_at IS
  'Audit timestamp: when the member finished the signup flow (set by auth.signup.completeBy* actions). NULL = either never invited, or invited but not completed yet (check signup_token / signup_pin_hash to distinguish).';
