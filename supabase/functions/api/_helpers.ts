// Cross-cutting helpers shared by every action module.
//
// Three things live here, all small and uninteresting on their own:
//   1. shortId      — URL-safe ID generator (member_id / project_id / cert_code).
//   2. httpErr      — `throw httpErr('msg', 403)` style errors the dispatcher
//                     in index.ts turns into proper JSON responses.
//   3. JWT helpers  — Deno port of jsonwebtoken's sign + verify via jose,
//                     against the legacy HS256 JWT_SECRET. Stays until the
//                     Supabase Auth migration commit, then deleted wholesale.
//   4. bcrypt       — password hash + verify for the legacy `public.users`
//                     login flow. Also goes away after the auth migration.
//   5. Role guards  — requireAuth / requireSuperadmin / requireAdminScope,
//                     copy of netlify/functions/_auth.js's exports.

import { SignJWT, jwtVerify } from 'https://esm.sh/jose@5.6.3';
import * as bcrypt from 'https://deno.land/x/bcrypt@v0.4.1/mod.ts';

// ─── shortId ────────────────────────────────────────────────────────────
// URL-safe 32-char alphabet (no easily-confused chars: 0/O/1/I dropped).
// Same alphabet as Netlify so existing IDs in the DB pattern-match.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function shortId(prefix?: string, len = 6): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return prefix ? `${prefix}_${s}` : s;
}

// 9-char URL-safe random token for one-shot temp passwords and similar.
// Match netlify/functions/api.js's randomBytesB64Url() output shape.
export function randomBytesB64Url(len = 7): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── httpErr ────────────────────────────────────────────────────────────
// Tags errors with a `.status` the dispatcher reads.
export type HttpError = Error & { status?: number };
export function httpErr(message: string, status = 400): HttpError {
  const e = new Error(message) as HttpError;
  e.status = status;
  return e;
}

// ─── JWT (legacy HS256, transient) ──────────────────────────────────────
// Once the auth migration commit lands, these go away — Supabase Auth
// issues + verifies tokens itself.
const JWT_SECRET = Deno.env.get('JWT_SECRET') ?? '';
const JWT_TTL_SEC = 7 * 24 * 60 * 60; // 7 days, matches the Netlify side.

export interface LegacyJwtPayload {
  id: number;
  username: string;
  access: string;          // 'superadmin' | 'head' | 'member' | 'volunteer'
  member_id: string | null;
  committee_id: string | null;
  iat?: number;
  exp?: number;
}

export async function signToken(user: {
  id: number; username: string; access_level: string;
  member_id: string | null; committee_id?: string | null;
}): Promise<string> {
  if (!JWT_SECRET) throw new Error('JWT_SECRET not configured.');
  const key = new TextEncoder().encode(JWT_SECRET);
  return new SignJWT({
    id: user.id,
    username: user.username,
    access: user.access_level,
    member_id: user.member_id,
    committee_id: user.committee_id ?? null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + JWT_TTL_SEC)
    .sign(key);
}

export async function verifyToken(authHeader: string | null): Promise<LegacyJwtPayload | null> {
  if (!authHeader || !JWT_SECRET) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const key = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(m[1], key, { algorithms: ['HS256'] });
    return payload as unknown as LegacyJwtPayload;
  } catch {
    return null;
  }
}

// ─── bcrypt (legacy login flow, transient) ──────────────────────────────
// Deno's bcrypt is a pure-JS port — slow but correct, fine for the
// handful of admin logins per day during the transition. Once Supabase
// Auth takes over, this import goes too.
export async function bcryptHash(plain: string, rounds = 10): Promise<string> {
  return await bcrypt.hash(plain, await bcrypt.genSalt(rounds));
}

export async function bcryptCompare(plain: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(plain, hash);
}

// ─── Role guards (port of netlify/functions/_auth.js) ───────────────────
export function requireAuth(user: LegacyJwtPayload | null): asserts user is LegacyJwtPayload {
  if (!user) throw httpErr('Unauthorized', 401);
}

export function requireSuperadmin(user: LegacyJwtPayload | null): asserts user is LegacyJwtPayload {
  requireAuth(user);
  if (user.access !== 'superadmin') {
    throw httpErr('Forbidden — superadmin only', 403);
  }
}

// `head` is allowed to write within their own committee; `superadmin` everywhere.
export function requireAdminScope(user: LegacyJwtPayload | null, committeeId: string | null | undefined): void {
  requireAuth(user);
  if (user.access === 'superadmin') return;
  if (user.access === 'head') {
    if (!committeeId || user.committee_id === committeeId) return;
    throw httpErr('Forbidden — committee head can only modify their own committee', 403);
  }
  throw httpErr('Forbidden', 403);
}

// ─── Public / superadmin allowlists ─────────────────────────────────────
// Same lists as netlify/functions/_auth.js. Duplicated rather than imported
// so the Edge Function deploy has zero cross-folder dependencies.
export const PUBLIC_ACTIONS = new Set<string>([
  'auth',
  'getMembers', 'getCommittees', 'getAdvisors', 'getProjects',
  'certs.verify',
  'setup.bulkSeed',
  'applications.submit',
]);

export const SUPERADMIN_ACTIONS = new Set<string>([
  'createProject', 'deleteProject',
  'createAdvisor', 'updateAdvisor', 'deleteAdvisor',
  'createCommittee', 'updateCommittee', 'deleteCommittee',
  'deleteMember',
  'setup.seedMembers',
  'hours.finalApprove',
  'users.create', 'users.update', 'users.delete',
]);

// ─── Handler type ───────────────────────────────────────────────────────
export type Handler = (
  body: Record<string, unknown>,
  user: LegacyJwtPayload | null,
) => Promise<unknown>;
