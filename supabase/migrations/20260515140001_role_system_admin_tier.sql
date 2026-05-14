-- Role system refactor — introduce the `admin` tier between `head` and
-- `superadmin`, and migrate the 8 leadership accounts (President + 2 VPs
-- + 5 DVPs) into it.
--
-- ── Background ──────────────────────────────────────────────────────────
-- Before this migration the role enum had 4 values:
--   superadmin → 9 accounts (1 dev + 8 leadership) — full access to
--                everything, no separation between dev-only ops and
--                operational presidency work
--   head       → 11 committee heads — scoped to their committee
--   member     → 3 test accounts — view-own access
--   volunteer  → 0 accounts (not used yet) — per-opportunity access
--
-- That meant the dev account (Faisal — username `faisal-admin`, no
-- member_id) was indistinguishable from the President/VPs in the
-- permission system. Two problems:
--
--   1. No way to scope dev-only ops (e.g. the future handover mechanism
--      that transfers the `superadmin` role itself, or dev tools we
--      haven't built yet) — anyone marked superadmin could call them.
--   2. Hard to hand off the dev account cleanly when Faisal graduates,
--      because the role is conflated with "presidency".
--
-- ── New model ──────────────────────────────────────────────────────────
--   superadmin → Just the dev. Reserved for dev-only ops (future:
--                role-handover UI, advanced config tools). Currently
--                does everything an admin can do, plus is the only
--                account that can promote / demote `admin` users.
--   admin      → New. President + 2 VPs + 5 DVPs (8 accounts).
--                Full operational access — same surface as today's
--                superadmin minus dev-only stuff. Can manage member
--                accounts, accept applications, create projects, etc.
--   head       → Unchanged. Committee Heads scoped to their committee.
--   member     → Unchanged. Regular members with view-own access.
--   volunteer  → Unchanged. Reserved for non-committee participants.
--
-- ── Migration steps ────────────────────────────────────────────────────
-- 1. Drop the old CHECK constraint that pinned access_level to the
--    4-value enum.
-- 2. Add the new CHECK with `admin` included as a 5th valid value.
-- 3. Migrate the 8 leadership accounts from `superadmin` to `admin`.
--    Identified by exclusion — any current superadmin that isn't the
--    dev account (`faisal-admin`) is, by current usage, presidency.
--
-- Idempotent on re-run: re-applying the constraint with `IF EXISTS` and
-- the UPDATE with the WHERE filter both no-op on second pass.

-- ─── Schema: widen the CHECK to allow 'admin' ──────────────────────────
-- Constraint name in Postgres is auto-generated; we use ALTER TABLE
-- DROP CONSTRAINT IF EXISTS so we don't have to know the exact name
-- (would be `users_access_level_check`). Then re-create explicitly so
-- it can be re-applied idempotently.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_access_level_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_access_level_check
    CHECK (access_level IN ('superadmin', 'admin', 'head', 'member', 'volunteer'));

COMMENT ON COLUMN public.users.access_level IS
  'Role tier. superadmin = dev-only (handover-target, configurable ops). admin = presidency tier (full operational access). head = committee head (scoped to own committee). member = regular member (view-own). volunteer = non-committee participant. Refactored 2026-05-15 — see migration 20260515140001 for the split rationale.';

-- ─── Data: migrate the 8 leadership accounts ──────────────────────────
-- `faisal-admin` is the canonical dev username (no member_id linkage,
-- which is the distinguishing trait — every other superadmin is also
-- a presidency member with a member_id). Any future migrations that
-- need to identify the dev account should also use this username as
-- the stable identifier.
UPDATE public.users
SET    access_level = 'admin'
WHERE  access_level = 'superadmin'
  AND  username <> 'faisal-admin';

-- Note: the "can't demote the only remaining superadmin" check in
-- the users.update handler (auth.ts) remains valid AND still binding
-- after this migration. faisal-admin is now the only superadmin row,
-- so any attempt to demote them via the admin UI is correctly blocked
-- at the application layer. The handover-the-dev-role flow (when it
-- exists) will need to atomically promote the new dev BEFORE demoting
-- the old one to avoid tripping that guard.
