// Authentication + user-account management handlers.
//
// Port of the AUTH + USERS sections from netlify/functions/api.js
// (lines 67–292). Behaviour is identical — same SQL, same role-gating,
// same response shapes. Only the imports and a few TS types differ.
//
// The five handlers here all touch the legacy `public.users` table with
// bcrypt password_hash + HS256 JWTs. After the Supabase Auth migration
// commit this file shrinks to just `users.list / .create / .update /
// .delete / .resetPassword` (in some form) and `auth` is deleted —
// magic-link sign-in is done by the supabase-js client directly, not
// proxied through this Edge Function.

import { sql } from '../_sql.ts';
import {
  bcryptCompare, bcryptHash, signToken,
  httpErr, randomBytesB64Url,
  requireAuth, requireSuperadmin,
  type Handler,
} from '../_helpers.ts';
import { sendEmail } from '../_email.ts';

// ─── `auth.resolveIdentifier` — username / NID / email → login plan ─────
// Public action. The login form sends a single free-text identifier
// (could be email, national_id, or username) and we return what the
// client needs to do next:
//
//   { found: true, auth_provider: 'supabase', email: '...' }
//      → call supabase.auth.signInWithPassword({ email, password })
//
//   { found: true, auth_provider: 'legacy', username: '...' }
//      → call action `auth` with that username + password (existing flow)
//
//   { found: false }
//      → render "no account matches" — frontend can hide it behind a
//        generic "Invalid credentials" message after the password
//        attempt so we don't leak account-existence info on this
//        endpoint alone.
//
// Lookup priority (resolves to the FIRST match):
//   1. email = members.email OR email = auth.users.email
//   2. national_id = members.national_id
//   3. username = public.users.username
//
// Notes on existence-leak risk: this endpoint is intentionally vague
// (success doesn't include personal details, just "is this account
// migrated"), but it WILL confirm whether a given email/NID/username
// is in the system. Username + email enumeration was already possible
// against the legacy `auth` action via timing differences. National-ID
// enumeration is the new vector — but national IDs aren't secret
// inside the org, only emails are. Acceptable trade-off for the UX win.
const authResolveIdentifier: Handler = async (body) => {
  const raw = String(body.identifier ?? '').trim();
  if (!raw) return { found: false };
  const lower = raw.toLowerCase();

  const rows = await sql`
    SELECT
      u.id,
      u.username,
      u.auth_user_id,
      m.national_id,
      m.email     AS member_email,
      au.email    AS auth_email
    FROM public.users u
    LEFT JOIN public.members m  ON m.member_id = u.member_id
    LEFT JOIN auth.users    au  ON au.id = u.auth_user_id
    WHERE
      LOWER(u.username)  = ${lower}
      OR (m.national_id IS NOT NULL AND m.national_id = ${raw})
      OR (m.email       IS NOT NULL AND LOWER(m.email)  = ${lower})
      OR (au.email      IS NOT NULL AND LOWER(au.email) = ${lower})
    LIMIT 1
  ` as Array<{
    id: number; username: string; auth_user_id: string | null;
    national_id: string | null; member_email: string | null; auth_email: string | null;
  }>;

  const row = rows[0];
  if (!row) return { found: false };

  if (row.auth_user_id) {
    // Migrated account — frontend should use Supabase Auth.
    // Prefer auth.users.email (canonical) over members.email.
    const email = row.auth_email || row.member_email || null;
    if (!email) {
      // Shouldn't happen: auth_user_id implies an auth.users row which
      // has email. If it does, fall back to legacy gracefully.
      return { found: true, auth_provider: 'legacy', username: row.username };
    }
    return { found: true, auth_provider: 'supabase', email };
  }

  // Legacy account.
  return { found: true, auth_provider: 'legacy', username: row.username };
};

// ─── `auth` — username + password login, issues HS256 JWT ───────────────
const auth: Handler = async (body) => {
  const username = body.username as string | undefined;
  const password = body.password as string | undefined;
  if (!username || !password) throw httpErr('Missing credentials', 400);

  const rows = await sql`
    SELECT u.id, u.username, u.password_hash, u.access_level, u.member_id,
           m.full_name, m.preferred_name, m.committee_id
    FROM users u
    LEFT JOIN members m ON m.member_id = u.member_id
    WHERE LOWER(u.username) = LOWER(${username})
    LIMIT 1
  ` as Array<{
    id: number; username: string; password_hash: string; access_level: string;
    member_id: string | null;
    full_name: string | null; preferred_name: string | null; committee_id: string | null;
  }>;

  const u = rows[0];
  if (!u) throw httpErr('Invalid credentials', 401);

  const okPw = await bcryptCompare(password, u.password_hash);
  if (!okPw) throw httpErr('Invalid credentials', 401);

  await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${u.id}`;
  const token = await signToken(u);
  return {
    token,
    user: {
      id: u.id,
      username: u.username,
      name: u.preferred_name || u.full_name,
      role: u.access_level,
      access: u.access_level,
      member_id: u.member_id,
      committee_id: u.committee_id,
    },
  };
};

// ─── `users.list` — superadmin sees all; head sees own-committee members ───
const usersList: Handler = async (_body, user) => {
  requireAuth(user);

  // We expose auth_user_id and auth_email to the frontend so the admin
  // UI knows which password-reset flow to offer: legacy users (no
  // auth_user_id) get the temp-password 🔑 button; migrated users get
  // the magic-link 📧 button. The email is auth.users.email (canonical
  // after migration) — different from members.email which may diverge.
  if (user.access === 'head') {
    return sql`
      SELECT u.id, u.username, u.access_level, u.auth_user_id, u.created_at, u.last_login_at,
             au.email         AS auth_email,
             m.member_id,
             m.full_name      AS member_full_name,
             m.preferred_name AS member_preferred_name,
             m.committee_id   AS member_committee_id,
             m.club_role      AS member_club_role,
             c.committee_name AS member_committee_name
      FROM members m
      LEFT JOIN users      u  ON u.member_id    = m.member_id
      LEFT JOIN auth.users au ON au.id          = u.auth_user_id
      LEFT JOIN committees c  ON c.committee_id = m.committee_id
      WHERE m.committee_id = ${user.committee_id}
      ORDER BY
        CASE WHEN u.id IS NULL THEN 1 ELSE 0 END,
        CASE m.club_role
          WHEN 'Committee Head'      THEN 1
          WHEN 'Committee Vice Head' THEN 2
          ELSE 9
        END,
        m.full_name
    `;
  }
  if (user.access !== 'superadmin') throw httpErr('Forbidden', 403);

  return sql`
    SELECT u.id, u.username, u.access_level, u.auth_user_id, u.created_at, u.last_login_at,
           u.member_id,
           au.email         AS auth_email,
           m.full_name      AS member_full_name,
           m.preferred_name AS member_preferred_name,
           m.committee_id   AS member_committee_id,
           m.club_role      AS member_club_role,
           c.committee_name AS member_committee_name
    FROM users u
    LEFT JOIN members    m  ON m.member_id    = u.member_id
    LEFT JOIN auth.users au ON au.id          = u.auth_user_id
    LEFT JOIN committees c  ON c.committee_id = m.committee_id
    ORDER BY
      CASE u.access_level
        WHEN 'superadmin' THEN 1
        WHEN 'head'       THEN 2
        WHEN 'member'     THEN 3
        WHEN 'volunteer'  THEN 4
      END,
      u.username
  `;
};

// ─── `users.create` — superadmin only ────────────────────────────────────
const usersCreate: Handler = async (body, user) => {
  requireSuperadmin(user);
  const data = (body.data ?? body) as Record<string, unknown>;
  const username = String(data.username || '').trim().toLowerCase();
  const password = String(data.password || '');
  const memberId = (data.member_id as string | null) || null;
  const access   = (data.access_level as string) || 'member';

  if (!username) throw httpErr('username is required', 400);
  if (!password || password.length < 6) throw httpErr('password must be at least 6 characters', 400);
  if (!['superadmin','head','member','volunteer'].includes(access)) {
    throw httpErr(`invalid access_level: ${access}`, 400);
  }

  const [existsByUser] = await sql`SELECT id FROM users WHERE LOWER(username) = ${username}` as Array<{ id: number }>;
  if (existsByUser) throw httpErr(`Username "${username}" is already taken`, 409);

  if (memberId) {
    const [member] = await sql`SELECT member_id, full_name FROM members WHERE member_id = ${memberId}` as Array<{ member_id: string; full_name: string }>;
    if (!member) throw httpErr(`Member ${memberId} not found`, 404);
    const [existingForMember] = await sql`SELECT id, username FROM users WHERE member_id = ${memberId}` as Array<{ id: number; username: string }>;
    if (existingForMember) {
      throw httpErr(`Member ${memberId} (${member.full_name}) already has an account: "${existingForMember.username}"`, 409);
    }
  }

  const hash = await bcryptHash(password, 10);
  const [r] = await sql`
    INSERT INTO users (username, password_hash, member_id, access_level)
    VALUES (${username}, ${hash}, ${memberId}, ${access})
    RETURNING id, username, access_level, member_id
  ` as Array<{ id: number; username: string; access_level: string; member_id: string | null }>;
  return { id: r.id, username: r.username, access_level: r.access_level, member_id: r.member_id };
};

// ─── `users.update` — superadmin only, guards last-superadmin demotion ───
const usersUpdate: Handler = async (body, user) => {
  requireSuperadmin(user);
  const data = (body.data ?? body) as Record<string, unknown>;
  const id = data.id as number | undefined;
  if (!id) throw httpErr('id is required', 400);

  const [target] = await sql`SELECT * FROM users WHERE id = ${id}` as Array<{
    id: number; username: string; password_hash: string; access_level: string; member_id: string | null;
  }>;
  if (!target) throw httpErr('User not found', 404);

  if (target.access_level === 'superadmin' && data.access_level && data.access_level !== 'superadmin') {
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE access_level = 'superadmin'` as Array<{ count: number }>;
    if (count <= 1) throw httpErr('Cannot demote the only remaining superadmin', 409);
  }

  if (data.username) {
    const newU = String(data.username).trim().toLowerCase();
    if (newU !== target.username.toLowerCase()) {
      const [clash] = await sql`SELECT id FROM users WHERE LOWER(username) = ${newU} AND id <> ${id}` as Array<{ id: number }>;
      if (clash) throw httpErr(`Username "${newU}" is already taken`, 409);
    }
  }
  if (data.member_id && data.member_id !== target.member_id) {
    const [clash] = await sql`SELECT id, username FROM users WHERE member_id = ${data.member_id} AND id <> ${id}` as Array<{ id: number; username: string }>;
    if (clash) throw httpErr(`That member already has an account: "${clash.username}"`, 409);
    const [member] = await sql`SELECT member_id FROM members WHERE member_id = ${data.member_id}` as Array<{ member_id: string }>;
    if (!member) throw httpErr(`Member ${data.member_id} not found`, 404);
  }
  if (data.access_level && !['superadmin','head','member','volunteer'].includes(data.access_level as string)) {
    throw httpErr(`invalid access_level: ${data.access_level}`, 400);
  }

  await sql`
    UPDATE users SET
      username     = COALESCE(${data.username ? String(data.username).trim().toLowerCase() : null}, username),
      member_id    = COALESCE(${data.member_id}, member_id),
      access_level = COALESCE(${data.access_level}, access_level)
    WHERE id = ${id}
  `;
  return { id };
};

// ─── `users.delete` — superadmin only ───────────────────────────────────
const usersDelete: Handler = async (body, user) => {
  requireSuperadmin(user);
  const id = body.id as number | undefined;
  // Pull auth_user_id along with the existing fields so we can cascade
  // the delete into auth.users for Supabase-Auth accounts. Without
  // this, deleting a user via the admin UI leaves an orphaned auth.users
  // row behind — and the next time we try to re-invite the same member
  // (same email), `admin.auth.admin.createUser` fails with "User with
  // this email address has already been registered". Found by user
  // testing the Phase 3 signup flow when re-inviting a deleted member.
  const [target] = await sql`
    SELECT id, username, access_level, auth_user_id
    FROM users
    WHERE id = ${id}
  ` as Array<{
    id: number; username: string; access_level: string;
    auth_user_id: string | null;
  }>;
  if (!target) return { id };
  if (target.access_level === 'superadmin') {
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE access_level = 'superadmin'` as Array<{ count: number }>;
    if (count <= 1) throw httpErr('Cannot delete the only remaining superadmin', 409);
  }
  if (target.id === user!.id) throw httpErr('You cannot delete your own account', 409);

  // Delete auth.users FIRST when present, then public.users. This
  // ordering matters:
  //  - If auth.users deletion fails (network blip, missing service
  //    role key, etc.) the exception bubbles up and public.users
  //    stays intact → state remains consistent
  //  - If both succeed: ON DELETE SET NULL on the users.auth_user_id
  //    FK will null the column in public.users between the two
  //    statements, but we're about to delete that row anyway so it
  //    doesn't matter
  //  - Idempotent for legacy accounts (auth_user_id NULL): skips
  //    the admin SDK call entirely, only does the SQL delete
  if (target.auth_user_id) {
    const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.45.4');
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await admin.auth.admin.deleteUser(target.auth_user_id);
    // 404 from the admin SDK means "already deleted upstream" — fine,
    // we just proceed with the SQL delete. Other errors abort so the
    // admin sees what went wrong rather than getting a half-deleted state.
    if (error && !/not_found|user not found/i.test(error.message || '')) {
      console.error('[users.delete] auth.users deletion failed:', error);
      throw httpErr(`Supabase auth delete failed: ${error.message}`, 500);
    }
  }

  await sql`DELETE FROM users WHERE id = ${id}`;
  return { id };
};

// ─── `users.resetPassword` — superadmin OR head-scoped over own committee ───
const usersResetPassword: Handler = async (body, user) => {
  requireAuth(user);
  const id = body.id as number | undefined;

  const [target] = await sql`
    SELECT u.id, u.username, u.access_level, u.member_id,
           m.committee_id AS member_committee_id
    FROM users u
    LEFT JOIN members m ON m.member_id = u.member_id
    WHERE u.id = ${id}
  ` as Array<{
    id: number; username: string; access_level: string;
    member_id: string | null; member_committee_id: string | null;
  }>;
  if (!target) throw httpErr('User not found', 404);

  if (user!.access === 'head') {
    if (!target.member_id) throw httpErr('Forbidden', 403);
    if (target.access_level === 'superadmin' || target.access_level === 'head') {
      throw httpErr('Committee heads cannot reset admin or head passwords', 403);
    }
    if (target.member_committee_id !== user!.committee_id) {
      throw httpErr('Forbidden — that member is not in your committee', 403);
    }
  } else if (user!.access !== 'superadmin') {
    throw httpErr('Forbidden', 403);
  }

  const tempPw = randomBytesB64Url(7);
  const hash = await bcryptHash(tempPw, 10);
  await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${id}`;
  return { id, username: target.username, temp_password: tempPw };
};

// ─── `users.sendPasswordReset` — admin triggers Supabase recovery email ──
// Distinct from `users.resetPassword`: that one (legacy) mints a fresh
// temp password and returns it to the admin to communicate manually.
// This one (Supabase-Auth) generates a recovery LINK and Supabase sends
// it to the user's email automatically — they click the link, set
// their own password, and they're in. No temp-password handoff.
//
// Permissions match users.resetPassword:
//   - superadmin can trigger for any migrated account
//   - head can trigger for a member in their own committee
//   - legacy accounts (auth_user_id IS NULL) are refused — they need
//     the old temp-password flow via users.resetPassword instead
//
// Uses the Supabase admin client (service role) so it bypasses the
// default rate limits the anon client would enforce. Supabase Auth
// still applies its own per-user limits (typically 1 recovery email
// per minute per email address), so spam-clicking the button just
// returns the same "Sent" state.
const usersSendPasswordReset: Handler = async (body, user) => {
  requireAuth(user);
  const id = body.id as number | undefined;
  if (!id) throw httpErr('id is required', 400);

  const [target] = await sql`
    SELECT u.id, u.username, u.access_level, u.member_id, u.auth_user_id,
           m.committee_id AS member_committee_id,
           au.email       AS auth_email
    FROM public.users u
    LEFT JOIN public.members m ON m.member_id = u.member_id
    LEFT JOIN auth.users   au  ON au.id = u.auth_user_id
    WHERE u.id = ${id}
  ` as Array<{
    id: number; username: string; access_level: string;
    member_id: string | null; auth_user_id: string | null;
    member_committee_id: string | null; auth_email: string | null;
  }>;
  if (!target) throw httpErr('User not found', 404);

  if (!target.auth_user_id || !target.auth_email) {
    throw httpErr(
      'This account is on legacy auth — use the temp-password reset instead. ' +
      'Or add an email to the linked member and re-run the backfill.',
      409,
    );
  }

  // Same scope rules as users.resetPassword.
  if (user!.access === 'head') {
    if (target.access_level === 'superadmin' || target.access_level === 'head') {
      throw httpErr('Committee heads cannot reset admin or head passwords', 403);
    }
    if (target.member_committee_id !== user!.committee_id) {
      throw httpErr('Forbidden — that member is not in your committee', 403);
    }
  } else if (user!.access !== 'superadmin') {
    throw httpErr('Forbidden', 403);
  }

  // Fire the Supabase Auth recovery email. `redirectTo` is taken from
  // the request body (the frontend passes window.location.origin +
  // '/reset-password.html'), with a hard fallback to prod for safety
  // if the client forgot to send it. We don't need to sanity-check the
  // URL here: Supabase validates it against the project's Redirect
  // URLs allowlist (Authentication → URL Configuration), and silently
  // falls back to Site URL on a mismatch. That allowlist is the
  // security boundary, not us.
  const redirectTo = (body.redirectTo as string | undefined)?.trim()
    || 'https://ssamau.com/reset-password.html';

  const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.45.4');
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await admin.auth.resetPasswordForEmail(target.auth_email, { redirectTo });
  if (error) throw httpErr(`Supabase: ${error.message}`, 500);

  return {
    id: target.id,
    username: target.username,
    email: target.auth_email,
    sent: true,
  };
};

// ─── `auth.whoami` — current user's app-level profile ──────────────────
// Authed action. After a Supabase sign-in the frontend has the access
// token but not the app-level fields (access_level, member_id,
// committee_id, etc.) — those live in public.users, not auth.users.
// This action returns them in the same shape the legacy `auth` action
// did, so the frontend's saveSession() stores identical data either way.
const authWhoami: Handler = async (_body, user) => {
  requireAuth(user);
  // Pull the member's preferred display name too — same join the
  // legacy `auth` handler does, so the admin UI greeting matches.
  const rows = await sql`
    SELECT m.full_name, m.preferred_name
    FROM public.members m
    WHERE m.member_id = ${user.member_id}
    LIMIT 1
  ` as Array<{ full_name: string | null; preferred_name: string | null }>;
  const member = rows[0];
  return {
    id:           user.id,
    username:     user.username,
    name:         member?.preferred_name || member?.full_name || user.username,
    role:         user.access,
    access:       user.access,
    member_id:    user.member_id,
    committee_id: user.committee_id,
    email:        user.email,
    auth_user_id: user.auth_user_id,
    auth_provider: user.auth_provider,
  };
};

// ─── `auth.invite.byEmail` — head OR superadmin sends a signup link ─────
// Generates a 64-hex-char random token (256 bits of entropy from
// crypto.getRandomValues), stamps it onto the member's public.users row
// (creating that row if it doesn't exist yet), and emails the member a
// link to /signup.html?token=… so they can choose their own password.
//
// Permissions match users.resetPassword:
//   - superadmin can invite any member
//   - head can invite a member in their OWN committee only
//
// "Resend" behaviour: if a pending invite (token or PIN) already exists,
// we overwrite it with a fresh token. The previous token becomes
// immediately unusable (UNIQUE index would block re-insert anyway).
// We do NOT touch users rows that have already completed signup
// (signup_completed_at IS NOT NULL) — that's a 409.
const authInviteByEmail: Handler = async (body, user) => {
  requireAuth(user);
  const memberId   = String(body.member_id ?? '').trim();
  const redirectTo = (body.redirectTo as string | undefined)?.trim()
    || 'https://ssamau.com/signup.html';
  if (!memberId) throw httpErr('member_id is required', 400);

  const [member] = await sql`
    SELECT m.member_id, m.full_name, m.preferred_name, m.email, m.committee_id,
           c.committee_name
    FROM public.members m
    LEFT JOIN public.committees c ON c.committee_id = m.committee_id
    WHERE m.member_id = ${memberId}
  ` as Array<{
    member_id: string; full_name: string; preferred_name: string | null;
    email: string | null; committee_id: string | null;
    committee_name: string | null;
  }>;
  if (!member) throw httpErr(`Member ${memberId} not found`, 404);
  if (!member.email) {
    throw httpErr(
      `Member ${memberId} has no email on file — use auth.invite.byPin instead, ` +
      `or add an email to their member record first.`, 400);
  }

  // Scope: head can only invite within their own committee.
  if (user!.access === 'head') {
    if (member.committee_id !== user!.committee_id) {
      throw httpErr('Forbidden — that member is not in your committee', 403);
    }
  } else if (user!.access !== 'superadmin') {
    throw httpErr('Forbidden', 403);
  }

  // Look up existing users row (if any) for this member.
  const [existing] = await sql`
    SELECT id, signup_completed_at, auth_user_id
    FROM public.users
    WHERE member_id = ${memberId}
  ` as Array<{ id: number; signup_completed_at: string | null; auth_user_id: string | null }>;

  if (existing?.signup_completed_at || existing?.auth_user_id) {
    throw httpErr(
      `Member ${memberId} (${member.full_name}) has already joined the portal. ` +
      `Use users.sendPasswordReset to send them a password recovery email instead.`, 409);
  }

  const token = generateInviteToken();

  if (existing) {
    // Resend: overwrite the pending invite on the existing row, clear
    // any PIN that might also be pending (only one invite path at a time).
    await sql`
      UPDATE public.users SET
        signup_token            = ${token},
        signup_token_expires_at = NOW() + INTERVAL '7 days',
        signup_pin_hash         = NULL,
        signup_pin_expires_at   = NULL
      WHERE id = ${existing.id}
    `;
  } else {
    // First-time invite: create the users row in pending state. The
    // username is the deterministic placeholder `mbr_<member_id>` —
    // members never see this; it's an internal handle that satisfies
    // the UNIQUE NOT NULL constraint on the column.
    await sql`
      INSERT INTO public.users (
        username, member_id, access_level, password_hash,
        signup_token, signup_token_expires_at
      ) VALUES (
        ${'mbr_' + memberId.toLowerCase()},
        ${memberId},
        'member',
        NULL,
        ${token},
        NOW() + INTERVAL '7 days'
      )
    `;
  }

  // Compose + send the invite email. Fire-and-forget pattern with try/catch
  // is built into sendEmail() — it returns false rather than throwing on
  // failure, so an SMTP blip can't roll back the invite that just landed
  // in the DB. The admin can retry by clicking "Resend" if they don't
  // hear back from the member.
  const displayName = member.preferred_name || member.full_name;
  const link        = `${redirectTo}?token=${token}`;
  const subject     = `دعوة للانضمام إلى لوحة الأعضاء — SSAM`;
  const html        = composeInviteEmail({
    displayName,
    committeeName: member.committee_name,
    signupLink: link,
    mode: 'token',
  });
  const sent = await sendEmail({ to: member.email, subject, html });

  return {
    sent,
    member_id: memberId,
    email: member.email,
    expires_at_iso8601_plus_7d: true, // hint for the UI; exact ms not exposed
  };
};

// ─── `auth.invite.byPin` — head OR superadmin issues a 6-digit PIN ─────
// For members without a reliable email. Admin clicks "Invite by PIN",
// the action returns the plaintext PIN ONCE in the response, admin
// passes it to the member offline (WhatsApp, in person), member visits
// signup.html and enters their NID + PIN to claim the account.
//
// The PIN is bcrypt-hashed before storage (rounds=10) so a DB leak
// doesn't expose it. Brute-force in 72h would require ~3.86 attempts/sec
// over 10^6 combinations — server-side rate limiting on the eventual
// completeByPin action (Phase 3) closes that. The expiry alone isn't
// sufficient; add real rate limiting when implementing Phase 3.
const authInviteByPin: Handler = async (body, user) => {
  requireAuth(user);
  const memberId = String(body.member_id ?? '').trim();
  if (!memberId) throw httpErr('member_id is required', 400);

  const [member] = await sql`
    SELECT m.member_id, m.full_name, m.committee_id, m.national_id
    FROM public.members m
    WHERE m.member_id = ${memberId}
  ` as Array<{
    member_id: string; full_name: string;
    committee_id: string | null; national_id: string | null;
  }>;
  if (!member) throw httpErr(`Member ${memberId} not found`, 404);
  if (!member.national_id) {
    throw httpErr(
      `Member ${memberId} has no national_id on file — required for PIN-based ` +
      `signup. Use auth.invite.byEmail if they have an email, or update the ` +
      `member record first.`, 400);
  }

  if (user!.access === 'head') {
    if (member.committee_id !== user!.committee_id) {
      throw httpErr('Forbidden — that member is not in your committee', 403);
    }
  } else if (user!.access !== 'superadmin') {
    throw httpErr('Forbidden', 403);
  }

  const [existing] = await sql`
    SELECT id, signup_completed_at, auth_user_id
    FROM public.users
    WHERE member_id = ${memberId}
  ` as Array<{ id: number; signup_completed_at: string | null; auth_user_id: string | null }>;

  if (existing?.signup_completed_at || existing?.auth_user_id) {
    throw httpErr(
      `Member ${memberId} (${member.full_name}) has already joined the portal.`, 409);
  }

  // 6-digit numeric PIN. Math.random() isn't cryptographically strong,
  // but we use crypto.getRandomValues() then mod 1_000_000 to stay
  // uniform. The PIN is short-lived (72h) + bcrypt-hashed + rate-
  // limited at completion time, so 20 bits of entropy is acceptable.
  const r = new Uint32Array(1);
  crypto.getRandomValues(r);
  const pinNum = r[0] % 1_000_000;
  const pin = pinNum.toString().padStart(6, '0');
  const pinHash = await bcryptHash(pin, 10);

  if (existing) {
    await sql`
      UPDATE public.users SET
        signup_pin_hash         = ${pinHash},
        signup_pin_expires_at   = NOW() + INTERVAL '72 hours',
        signup_token            = NULL,
        signup_token_expires_at = NULL
      WHERE id = ${existing.id}
    `;
  } else {
    await sql`
      INSERT INTO public.users (
        username, member_id, access_level, password_hash,
        signup_pin_hash, signup_pin_expires_at
      ) VALUES (
        ${'mbr_' + memberId.toLowerCase()},
        ${memberId},
        'member',
        NULL,
        ${pinHash},
        NOW() + INTERVAL '72 hours'
      )
    `;
  }

  // Plaintext PIN goes back to the admin ONCE. We never persist it.
  // Admin must copy it now and pass it to the member (WhatsApp, etc.).
  return {
    member_id: memberId,
    member_name: member.full_name,
    pin,                       // ← unrecoverable after this response
    expires_in_hours: 72,
  };
};

// ─── `auth.invite.revoke` — cancel a pending invite ────────────────────
// Deletes the pending users row entirely (which only contains the invite
// state — no member activity to preserve). Refuses to touch rows where
// signup has been completed; those go through users.delete with the
// usual superadmin-only guard.
const authInviteRevoke: Handler = async (body, user) => {
  requireAuth(user);
  const memberId = String(body.member_id ?? '').trim();
  if (!memberId) throw httpErr('member_id is required', 400);

  const [existing] = await sql`
    SELECT u.id, u.signup_completed_at, u.auth_user_id,
           m.committee_id
    FROM public.users u
    LEFT JOIN public.members m ON m.member_id = u.member_id
    WHERE u.member_id = ${memberId}
  ` as Array<{
    id: number; signup_completed_at: string | null;
    auth_user_id: string | null; committee_id: string | null;
  }>;
  if (!existing) throw httpErr('No pending invite to revoke', 404);

  if (existing.signup_completed_at || existing.auth_user_id) {
    throw httpErr(
      'That member has already joined the portal — use users.delete ' +
      '(superadmin only) if you really need to remove their account.', 409);
  }

  if (user!.access === 'head') {
    if (existing.committee_id !== user!.committee_id) {
      throw httpErr('Forbidden — that member is not in your committee', 403);
    }
  } else if (user!.access !== 'superadmin') {
    throw httpErr('Forbidden', 403);
  }

  await sql`DELETE FROM public.users WHERE id = ${existing.id}`;
  return { member_id: memberId, revoked: true };
};

// ─── `auth.signup.completeByToken` — member completes email-link signup ─
// Public action (no auth). Called by signup.html when the member opens
// the link from their invite email. Looks up the pending users row by
// signup_token, creates an auth.users record via Supabase admin API
// using the member's email + the password the member just chose, links
// them via users.auth_user_id, and clears the signup state.
//
// On success returns { email, login_hint: 'redirect to login' } — the
// frontend redirects to login.html and the member signs in normally.
//
// Error shape is deliberately uniform across the failure modes so the
// frontend can show a single "هذا الرابط لم يعد صالحاً" message without
// leaking whether the token was wrong, expired, or already used —
// all of those mean the same thing to the member ("ask the admin to
// reissue"). Internal logging captures the distinction for debugging.
const authSignupCompleteByToken: Handler = async (body) => {
  const token    = String(body.token    ?? '').trim();
  const password = String(body.password ?? '');
  if (!token)             throw httpErr('Invite link is invalid', 400);
  if (password.length < 8) throw httpErr('كلمة المرور يجب أن تكون 8 أحرف على الأقل / Password must be at least 8 characters', 400);

  const [row] = await sql`
    SELECT u.id, u.member_id, u.signup_token_expires_at, u.signup_completed_at, u.auth_user_id,
           m.email, m.full_name, m.preferred_name
    FROM public.users u
    LEFT JOIN public.members m ON m.member_id = u.member_id
    WHERE u.signup_token = ${token}
    LIMIT 1
  ` as Array<{
    id: number; member_id: string; signup_token_expires_at: string | null;
    signup_completed_at: string | null; auth_user_id: string | null;
    email: string | null; full_name: string; preferred_name: string | null;
  }>;

  if (!row) {
    console.warn('[auth.signup.completeByToken] token not found');
    throw httpErr('هذا الرابط لم يعد صالحاً / Invite link is invalid or expired', 410);
  }
  if (row.signup_completed_at || row.auth_user_id) {
    console.warn(`[auth.signup.completeByToken] user ${row.id} already activated`);
    throw httpErr('هذا الحساب مفعّل سابقاً، الرجاء تسجيل الدخول مباشرةً / Account already activated — please sign in', 409);
  }
  if (row.signup_token_expires_at && new Date(row.signup_token_expires_at) < new Date()) {
    console.warn(`[auth.signup.completeByToken] token expired for user ${row.id}`);
    throw httpErr('انتهت صلاحية الدعوة، الرجاء طلب دعوة جديدة من المسؤول / Invite expired — ask the admin for a new one', 410);
  }
  if (!row.email) {
    // Shouldn't happen: invite.byEmail validates email-exists at issue time.
    // But the member's email column COULD have been cleared between issue
    // and completion. Refuse rather than create an unmappable auth.users.
    throw httpErr('لا يوجد بريد إلكتروني للعضو، الرجاء التواصل مع المسؤول / Member has no email on file — contact admin', 400);
  }

  // Create the auth.users row via the Supabase admin SDK (service role
  // bypasses RLS + the disabled enable_signup flag). email_confirm=true
  // skips the "click this link to confirm your email" step — the member
  // just used a one-time link FROM us, that's already confirmed enough.
  const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.45.4');
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.auth.admin.createUser({
    email:         row.email,
    password,
    email_confirm: true,
    user_metadata: {
      member_id: row.member_id,
      name:      row.preferred_name || row.full_name,
    },
  });
  if (error || !data?.user) {
    // Surface the Supabase error string so the user gets actionable
    // feedback (e.g. "User already registered" if they re-clicked the
    // link after a successful activation that didn't redirect cleanly).
    console.error('[auth.signup.completeByToken] createUser failed:', error);
    throw httpErr(error?.message || 'Failed to activate account', 500);
  }

  // Link + clear signup state. Done in one UPDATE so a crash between
  // createUser and this query doesn't leave orphan rows pointing at
  // a usable token. (Worst case: createUser succeeded but the UPDATE
  // failed — member's auth.users row exists but our users row still
  // has signup_token. Next attempt to complete will hit the "already
  // registered" error from createUser and bounce the user to login.
  // Annoying but not insecure.)
  await sql`
    UPDATE public.users SET
      auth_user_id             = ${data.user.id},
      signup_token             = NULL,
      signup_token_expires_at  = NULL,
      signup_pin_hash          = NULL,
      signup_pin_expires_at    = NULL,
      signup_completed_at      = NOW()
    WHERE id = ${row.id}
  `;

  console.log(`[auth.signup.completeByToken] activated user ${row.id} (member ${row.member_id})`);
  return { email: row.email, login_hint: 'redirect to login' };
};

// ─── `auth.signup.completeByPin` — member completes NID+PIN signup ──────
// Public action (no auth). Called by signup.html when the member chose
// the NID-flow path. Looks up the member by national_id, validates the
// PIN against the bcrypt-hashed signup_pin_hash on the corresponding
// users row, then creates auth.users + links + clears state — same
// terminal flow as completeByToken.
//
// Brute-force mitigation today:
//   - bcrypt comparison is ~100ms (rounds=10), throttling rapid retries
//   - PIN expires 72h after issue (auth.invite.byPin sets the deadline)
//   - Edge Function endpoint has Supabase's per-IP rate limit on top
// A proper attempt-counter + auto-lockout will land as a follow-up; for
// now error messages are deliberately UNIFORM across "NID not found" /
// "no invite issued" / "PIN wrong" so attackers can't tell which of
// those they hit — same generic credentials-style response.
const authSignupCompleteByPin: Handler = async (body) => {
  const nationalId = String(body.national_id ?? '').trim();
  const pin        = String(body.pin         ?? '').trim();
  const password   = String(body.password    ?? '');
  if (!nationalId || !pin) throw httpErr('بيانات ناقصة / Missing credentials', 400);
  if (password.length < 8) throw httpErr('كلمة المرور يجب أن تكون 8 أحرف على الأقل / Password must be at least 8 characters', 400);

  // Single query covering member lookup + linked users row + PIN state.
  // Returning eagerly with a uniform error message means the attacker
  // can't time-distinguish "NID doesn't exist" from "no users row" from
  // "PIN hash empty" — they're all "Invalid credentials" to them.
  const [row] = await sql`
    SELECT u.id, u.member_id, u.signup_pin_hash, u.signup_pin_expires_at,
           u.signup_completed_at, u.auth_user_id,
           m.email, m.full_name, m.preferred_name
    FROM public.members m
    LEFT JOIN public.users u ON u.member_id = m.member_id
    WHERE m.national_id = ${nationalId}
    LIMIT 1
  ` as Array<{
    id: number | null; member_id: string;
    signup_pin_hash: string | null; signup_pin_expires_at: string | null;
    signup_completed_at: string | null; auth_user_id: string | null;
    email: string | null; full_name: string; preferred_name: string | null;
  }>;

  const generic = httpErr('بيانات الدخول غير صحيحة / Invalid credentials', 401);

  if (!row || !row.id || !row.signup_pin_hash) {
    console.warn(`[auth.signup.completeByPin] no pending PIN for NID ${nationalId}`);
    // Still do a fake bcrypt compare to keep timing consistent with the
    // valid-row path (~100ms per attempt regardless of NID validity).
    // Without this, attackers could enumerate valid NIDs by measuring
    // response time. Use a known-junk hash that will reliably mismatch.
    await bcryptCompare('___fake___', '$2a$10$abcdefghijklmnopqrstuvwx0123456789ABCDEFGHIJKLMNOPQR');
    throw generic;
  }
  if (row.signup_completed_at || row.auth_user_id) {
    console.warn(`[auth.signup.completeByPin] user ${row.id} already activated`);
    throw httpErr('هذا الحساب مفعّل سابقاً، الرجاء تسجيل الدخول مباشرةً / Account already activated — please sign in', 409);
  }
  if (row.signup_pin_expires_at && new Date(row.signup_pin_expires_at) < new Date()) {
    console.warn(`[auth.signup.completeByPin] PIN expired for user ${row.id}`);
    throw httpErr('انتهت صلاحية الرمز، الرجاء طلب دعوة جديدة من المسؤول / PIN expired — ask the admin for a new one', 410);
  }
  if (!row.email) {
    // PIN flow doesn't strictly REQUIRE email at invite time (per
    // auth.invite.byPin), but Supabase Auth needs an email to create
    // an auth.users row. Refuse here with a clear message.
    throw httpErr('لا يوجد بريد إلكتروني للعضو، الرجاء التواصل مع المسؤول / Member has no email on file — contact admin', 400);
  }

  const pinOk = await bcryptCompare(pin, row.signup_pin_hash);
  if (!pinOk) {
    console.warn(`[auth.signup.completeByPin] wrong PIN for user ${row.id}`);
    throw generic;
  }

  // Create auth.users (same as completeByToken path).
  const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.45.4');
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.auth.admin.createUser({
    email:         row.email,
    password,
    email_confirm: true,
    user_metadata: {
      member_id: row.member_id,
      name:      row.preferred_name || row.full_name,
    },
  });
  if (error || !data?.user) {
    console.error('[auth.signup.completeByPin] createUser failed:', error);
    throw httpErr(error?.message || 'Failed to activate account', 500);
  }

  await sql`
    UPDATE public.users SET
      auth_user_id             = ${data.user.id},
      signup_token             = NULL,
      signup_token_expires_at  = NULL,
      signup_pin_hash          = NULL,
      signup_pin_expires_at    = NULL,
      signup_completed_at      = NOW()
    WHERE id = ${row.id}
  `;

  console.log(`[auth.signup.completeByPin] activated user ${row.id} (member ${row.member_id})`);
  return { email: row.email, login_hint: 'redirect to login' };
};

// Generate a 64-hex-char invite token (32 bytes from crypto.getRandomValues
// → 256 bits of entropy). Used for the email-link signup flow.
// Exported so applications.accept can issue an auto-invite on the same
// pattern when a committee head accepts a membership application.
export function generateInviteToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Compose the Arabic-first invite email body. Same design language as
// the application-notification email (green band header + RTL body)
// and the password-recovery template (proven to render across Gmail,
// Apple Mail, Outlook). Reuses the bulletproof patterns:
//   - role="presentation" + bgcolor mirror style for Gmail strip
//   - <meta name="color-scheme" content="light only"> opts out of
//     Gmail's auto-dark transform
//   - !important on header text colors so dark-mode Gmail doesn't
//     re-colour white text to grey
//   - CTA button = <a> inside a single-cell <table> with bgcolor
//
// Token vs PIN mode share most copy. We pass `mode` so the body text
// can vary: "click the link" vs "enter the PIN".
// Exported so other actions (e.g. applications.accept auto-invite)
// can compose using the same template.
export function composeInviteEmail(opts: {
  displayName: string;
  committeeName: string | null;
  signupLink: string;
  mode: 'token' | 'pin';
}): string {
  const esc = (s: string) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const committeeLine = opts.committeeName
    ? `<p style="margin:0 0 14px 0;font-size:14px;color:#374151;">عضو في <strong>${esc(opts.committeeName)}</strong>.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>دعوة للانضمام إلى لوحة الأعضاء — SSAM</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f4;font-family:'Helvetica Neue',Arial,sans-serif;color:#111827;line-height:1.55;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f4f6f4" style="background-color:#f4f6f4;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" bgcolor="#ffffff" style="max-width:600px;background-color:#ffffff;border-radius:12px;border:1px solid #e5e7eb;">
        <tr>
          <td bgcolor="#1A5C2E" style="background-color:#1A5C2E;padding:22px 24px;border-top-left-radius:12px;border-top-right-radius:12px;">
            <div style="font-size:13px;color:#c9a032 !important;letter-spacing:.5px;">SSAM — دعوة للانضمام</div>
            <div style="font-size:20px;font-weight:700;margin-top:4px;color:#ffffff !important;">أهلًا ${esc(opts.displayName)} 👋</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <p style="margin:0 0 14px 0;font-size:15px;color:#111827;">
              تم تفعيل حسابك في لوحة الأعضاء الخاصة بنادي الطلبة السعوديين في ملبورن.
            </p>
            ${committeeLine}
            <p style="margin:0 0 14px 0;font-size:14px;color:#374151;">
              من خلال اللوحة تقدر:
            </p>
            <ul style="margin:0 0 18px 0;padding-right:20px;font-size:14px;color:#374151;">
              <li style="margin-bottom:6px;">عرض ساعات تطوّعك المعتمدة وقيد المراجعة.</li>
              <li style="margin-bottom:6px;">التسجيل في الفعاليات والفرص التطوعية.</li>
              <li style="margin-bottom:6px;">تحديث بياناتك الشخصية ورفع السيرة الذاتية.</li>
            </ul>
            <p style="margin:0 0 14px 0;font-size:14px;color:#374151;">
              اضغط الزر أدناه لإنشاء كلمة مرورك وتفعيل الحساب:
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:18px auto 22px auto;">
              <tr>
                <td align="center" bgcolor="#1A5C2E" style="background-color:#1A5C2E;border-radius:10px;">
                  <a href="${esc(opts.signupLink)}" style="display:inline-block;padding:14px 36px;background-color:#1A5C2E;color:#ffffff !important;text-decoration:none;font-weight:700;font-size:15px;border-radius:10px;">
                    تفعيل الحساب
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px 0;font-size:12px;color:#6b7280;">
              أو انسخ هذا الرابط والصقه في المتصفح:
            </p>
            <p dir="ltr" style="margin:0 0 16px 0;font-size:12px;color:#374151;word-break:break-all;background-color:#f4f6f4;padding:10px 12px;border-radius:8px;border:1px solid #e5e7eb;text-align:left;">
              ${esc(opts.signupLink)}
            </p>
            <p style="margin:8px 0 0 0;font-size:12px;color:#9ca3af;">
              صلاحية هذا الرابط 7 أيام من وقت الإرسال. إن لم تكن تتوقع هذه الدعوة، يمكنك تجاهل الرسالة بأمان.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" bgcolor="#f9fafb" style="background-color:#f9fafb;padding:14px 24px;border-top:1px solid #e5e7eb;border-bottom-left-radius:12px;border-bottom-right-radius:12px;font-size:11px;color:#9ca3af;line-height:1.6;">
            <span dir="rtl">رسالة آلية من نظام إدارة النادي — لا ترد عليها.</span><br/>
            <span dir="ltr">SSAM — Saudi Students Association in Melbourne</span>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export const authActions: Record<string, Handler> = {
  'auth':                    auth,
  'auth.resolveIdentifier':  authResolveIdentifier,
  'auth.whoami':             authWhoami,
  'auth.invite.byEmail':         authInviteByEmail,
  'auth.invite.byPin':           authInviteByPin,
  'auth.invite.revoke':          authInviteRevoke,
  'auth.signup.completeByToken': authSignupCompleteByToken,
  'auth.signup.completeByPin':   authSignupCompleteByPin,
  'users.list':              usersList,
  'users.create':            usersCreate,
  'users.update':            usersUpdate,
  'users.delete':            usersDelete,
  'users.resetPassword':     usersResetPassword,
  'users.sendPasswordReset': usersSendPasswordReset,
};
