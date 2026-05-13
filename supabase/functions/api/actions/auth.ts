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

  if (user.access === 'head') {
    return sql`
      SELECT u.id, u.username, u.access_level, u.created_at, u.last_login_at,
             m.member_id,
             m.full_name      AS member_full_name,
             m.preferred_name AS member_preferred_name,
             m.committee_id   AS member_committee_id,
             m.club_role      AS member_club_role,
             c.committee_name AS member_committee_name
      FROM members m
      LEFT JOIN users      u ON u.member_id      = m.member_id
      LEFT JOIN committees c ON c.committee_id   = m.committee_id
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
    SELECT u.id, u.username, u.access_level, u.created_at, u.last_login_at,
           u.member_id,
           m.full_name      AS member_full_name,
           m.preferred_name AS member_preferred_name,
           m.committee_id   AS member_committee_id,
           m.club_role      AS member_club_role,
           c.committee_name AS member_committee_name
    FROM users u
    LEFT JOIN members    m ON m.member_id    = u.member_id
    LEFT JOIN committees c ON c.committee_id = m.committee_id
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
  const [target] = await sql`SELECT id, username, access_level FROM users WHERE id = ${id}` as Array<{
    id: number; username: string; access_level: string;
  }>;
  if (!target) return { id };
  if (target.access_level === 'superadmin') {
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE access_level = 'superadmin'` as Array<{ count: number }>;
    if (count <= 1) throw httpErr('Cannot delete the only remaining superadmin', 409);
  }
  if (target.id === user!.id) throw httpErr('You cannot delete your own account', 409);
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

export const authActions: Record<string, Handler> = {
  'auth':                auth,
  'users.list':          usersList,
  'users.create':        usersCreate,
  'users.update':        usersUpdate,
  'users.delete':        usersDelete,
  'users.resetPassword': usersResetPassword,
};
