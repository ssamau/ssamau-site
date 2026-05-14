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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { sql } from './_sql.ts';

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

// ─── Supabase Auth token verification ───────────────────────────────────
// Verifies a Supabase-issued JWT by asking the Supabase Auth API to
// decode it. Using `auth.getUser(token)` over verifying the JWT locally
// costs one network round-trip (~30ms) per authed request, but means
// we don't need to mirror the project's JWT secret here or track key
// rotation — Supabase owns that lifecycle.
//
// If performance becomes a concern, swap this for a local `jose.jwtVerify`
// against `SUPABASE_JWT_SECRET` (auto-injected into Edge Functions).
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

export interface SupabaseAuthUser {
  id: string;             // UUID — matches public.users.auth_user_id
  email?: string;
  user_metadata?: Record<string, unknown>;
}

export async function verifySupabaseToken(authHeader: string | null): Promise<SupabaseAuthUser | null> {
  if (!authHeader || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) return null;
    return {
      id:            data.user.id,
      email:         data.user.email ?? undefined,
      user_metadata: data.user.user_metadata ?? {},
    };
  } catch {
    return null;
  }
}

// ─── Unified UserContext (post-auth, used by every handler) ─────────────
// Whichever auth path succeeded — Supabase JWT or legacy HS256 — we
// flatten the result to this shape. The handlers in actions/*.ts read
// `user.id` (public.users.id integer, used for FK references),
// `user.access`, `user.member_id`, `user.committee_id` regardless of
// how the request was authenticated.
//
// `auth_provider` lets handlers branch behaviour if they need to (e.g.
// users.resetPassword should refuse to overwrite the bcrypt hash for
// Supabase-managed accounts — that's a Supabase Auth flow now).
export interface UserContext {
  id: number;                          // public.users.id
  username: string;
  access: string;
  member_id: string | null;
  committee_id: string | null;
  auth_provider: 'supabase' | 'legacy';
  email: string | null;                // auth.users.email for Supabase, null for legacy
  auth_user_id: string | null;         // UUID for Supabase, null for legacy
}

// Resolves an incoming Authorization header to a UserContext, trying the
// Supabase path first (the long-term path) and falling back to the
// legacy HS256 path (the 4 unmigrated leadership accounts). Returns
// null if both paths fail — the dispatcher renders 401 from there.
export async function resolveUserContext(authHeader: string | null): Promise<UserContext | null> {
  // Path 1: Supabase JWT. Almost every authed request after migration.
  const supaUser = await verifySupabaseToken(authHeader);
  if (supaUser) {
    const rows = await sql`
      SELECT u.id, u.username, u.access_level, u.member_id, m.committee_id
      FROM public.users u
      LEFT JOIN public.members m ON m.member_id = u.member_id
      WHERE u.auth_user_id = ${supaUser.id}
      LIMIT 1
    ` as Array<{ id: number; username: string; access_level: string; member_id: string | null; committee_id: string | null }>;
    const row = rows[0];
    if (!row) {
      // Supabase user exists but no public.users mapping. Shouldn't
      // happen in normal flow — would mean someone signed up via
      // supabase-js directly without us creating the public.users row.
      // Treat as auth failure rather than a crash.
      return null;
    }
    return {
      id:            row.id,
      username:      row.username,
      access:        row.access_level,
      member_id:     row.member_id,
      committee_id:  row.committee_id,
      auth_provider: 'supabase',
      email:         supaUser.email ?? null,
      auth_user_id:  supaUser.id,
    };
  }

  // Path 2: Legacy HS256 JWT — the 4 unmigrated accounts.
  const legacyPayload = await verifyToken(authHeader);
  if (legacyPayload) {
    return {
      id:            legacyPayload.id,
      username:      legacyPayload.username,
      access:        legacyPayload.access,
      member_id:     legacyPayload.member_id,
      committee_id:  legacyPayload.committee_id,
      auth_provider: 'legacy',
      email:         null,
      auth_user_id:  null,
    };
  }

  return null;
}

// ─── bcrypt (legacy login flow, transient) ──────────────────────────────
// Deno's bcrypt is a pure-JS port. Use the *Sync* variants:
// - bcrypt.compare()/hash() spin up a Web Worker for CPU offload, but
//   Supabase Edge Functions don't expose the Worker constructor — calling
//   them returns `Worker is not defined` at runtime.
// - bcrypt.compareSync()/hashSync() run on the main thread. Slower for
//   parallel calls but we're doing one login at a time, so it's fine.
//
// The Node-side `bcryptjs` hashes have `$2b$06$...` prefix (rounds=6).
// Deno bcrypt understands `$2a`/`$2b`/`$2y` interchangeably so the
// hashes round-trip without re-hashing. Once Supabase Auth takes over,
// this whole block is deleted.
export async function bcryptHash(plain: string, rounds = 10): Promise<string> {
  return bcrypt.hashSync(plain, bcrypt.genSaltSync(rounds));
}

export async function bcryptCompare(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compareSync(plain, hash);
}

// ─── Role guards (port of netlify/functions/_auth.js) ───────────────────
// Take UserContext (the unified post-auth shape) rather than the legacy
// JWT payload — the dispatcher resolves both auth paths to UserContext
// before invoking the handler, so guards don't care which path ran.
export function requireAuth(user: UserContext | null): asserts user is UserContext {
  if (!user) throw httpErr('Unauthorized', 401);
}

// Role-system refactor (2026-05-15): split the old single-tier
// `superadmin` into `superadmin` (dev-only) + `admin` (presidency).
// Most existing call sites want "presidency or dev" semantics, which
// is now requireAdmin(). requireSuperadmin() stays as a guard for
// truly dev-only ops (handover flow + future dev tooling); call sites
// that need it should be deliberate.

// Dev tier ONLY (currently: faisal-admin). Reserve for ops where the
// presidency shouldn't have the authority — e.g. transferring the dev
// account itself, or future Supabase-config-shaped tools. Most current
// callers that historically used requireSuperadmin() actually wanted
// the presidency-or-above semantics; those should switch to requireAdmin().
export function requireSuperadmin(user: UserContext | null): asserts user is UserContext {
  requireAuth(user);
  if (user.access !== 'superadmin') {
    throw httpErr('Forbidden — dev access required', 403);
  }
}

// Presidency tier OR dev. This is the right guard for nearly every
// "admin operation" that isn't dev-shaped — member CRUD, application
// triage, project / event creation, hours final-approval, etc.
export function requireAdmin(user: UserContext | null): asserts user is UserContext {
  requireAuth(user);
  if (user.access !== 'superadmin' && user.access !== 'admin') {
    throw httpErr('Forbidden — admin access required', 403);
  }
}

// Committee-scoped admin actions: `head` allowed within their own
// committee; `admin` and `superadmin` allowed everywhere. Used for
// things like "edit member in MY committee", "approve hours for one
// of MY committee's projects".
export function requireAdminScope(user: UserContext | null, committeeId: string | null | undefined): void {
  requireAuth(user);
  if (user.access === 'superadmin' || user.access === 'admin') return;
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
  'auth.resolveIdentifier',
  // Phase 3 of Branch 4 — member completes the signup flow from
  // signup.html using either the email-link token or the NID+PIN combo.
  // These are intentionally public: at the moment the member calls
  // them they don't yet have an auth.users row, so JWT-gated access
  // would be impossible. The actions enforce their own credential
  // checks (token uniqueness + expiry, bcrypt PIN compare + expiry).
  'auth.signup.completeByToken',
  'auth.signup.completeByPin',
  'getMembers', 'getCommittees', 'getAdvisors', 'getProjects',
  'certs.verify',
  'setup.bulkSeed',
  'applications.submit',
]);

// Admin-tier actions: callable by `admin` (presidency) OR `superadmin`
// (dev). Enforced at the dispatcher layer in index.ts so handlers
// don't have to re-check the same thing on every entry. These are
// the actions that USED to live in SUPERADMIN_ACTIONS before the
// 2026-05-15 role split — the surface didn't shrink, just the
// allowed audience widened.
export const ADMIN_ACTIONS = new Set<string>([
  'createProject', 'deleteProject',
  'createAdvisor', 'updateAdvisor', 'deleteAdvisor',
  'createCommittee', 'updateCommittee', 'deleteCommittee',
  'deleteMember',
  'setup.seedMembers',
  'hours.finalApprove',
  'users.create', 'users.update', 'users.delete',
]);

// Dev-tier actions: callable ONLY by `superadmin`. Reserved for
// truly dev-shaped ops the presidency shouldn't be able to invoke.
// Empty today — added pre-emptively for the future dev-account-
// handover flow (which will need this), and any later Supabase-
// config-shaped tooling we build.
export const SUPERADMIN_ACTIONS = new Set<string>([
  // (future: 'dev.transferDevAccount' etc.)
]);

// ─── Handler type ───────────────────────────────────────────────────────
export type Handler = (
  body: Record<string, unknown>,
  user: UserContext | null,
) => Promise<unknown>;
