// Session storage helpers.
//
// Security audit finding H2 (2026-05-19): JWTs no longer live in
// localStorage. The Edge Function sets an HttpOnly `ssam_session`
// cookie on every successful login (legacy `auth` action OR the
// Supabase-token bridge). JavaScript can't read the cookie; the
// browser attaches it automatically to every `credentials: 'include'`
// fetch from lib/api.js.
//
// What localStorage still holds:
//   - `ssam_session`  → user METADATA only (name, role, member_id,
//                        committee_id, loginAt). Read by the SPA shells
//                        to render the sidebar before the first API
//                        call. NOT auth-sensitive.
//   - `ssam_last_user`→ identifier the user last successfully signed
//                        in with (pre-fills the login form).
//
// What localStorage NO LONGER holds (cleared on import):
//   - `ssam_token`              → legacy HS256 JWT
//   - `ssam_supabase_session`   → Supabase access_token + refresh_token
//
// After deploy, any user with stale localStorage tokens loses no data:
// their first API call returns 401 (no cookie present), `api.js`
// clears local state and routes them to /login.html. They re-log,
// the server sets the cookie, and from then on auth is invisible to
// JS code.

import { SUPABASE_URL, SUPABASE_ANON_KEY, API_URL } from './api.js';

const SESSION_KEY = 'ssam_session';
const LAST_USER   = 'ssam_last_user';

// One-time cleanup: wipe pre-H2 keys that used to hold tokens. Safe
// to run on every import — non-existent keys are no-ops.
try {
  localStorage.removeItem('ssam_token');
  localStorage.removeItem('ssam_supabase_session');
} catch { /* private-browsing throws */ }

// ─── Reads ──────────────────────────────────────────────────────────

/** Returns the cached user metadata, or null if logged out. */
export function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}

/**
 * Deprecated shim. Pre-H2 callers read the JWT directly to attach as
 * an Authorization header. Post-H2 the cookie carries auth and JS
 * doesn't need (or have access to) the token. Kept so legacy call
 * sites that read but ignore the result still compile.
 */
export function getToken() { return ''; }

export function getLastUsername() {
  return localStorage.getItem(LAST_USER) || '';
}

/**
 * True if a session-metadata blob exists locally. Doesn't prove the
 * cookie is still valid — the server returns 401 if not, and
 * api.js's 401 handler clears + bounces to login.
 */
export function isLoggedIn() {
  return !!getSession();
}

/**
 * Pick the right post-login landing page based on access_level.
 *
 *   superadmin / admin → admin.html
 *   head               → head.html
 *   member / volunteer → member.html
 *
 * Heads have their own focused landing since the 16-tab admin SPA is
 * overkill day-to-day. They can still navigate to admin.html — the
 * admin auth guard allows heads in by access level. Defaults to
 * admin.html on missing/unknown access for fail-safe (admin RBAC
 * hides what the user shouldn't see).
 */
export function landingPageForAccess(access) {
  if (access === 'member' || access === 'volunteer') return 'member.html';
  if (access === 'head') return 'head.html';
  return 'admin.html';
}

// ─── Writes ─────────────────────────────────────────────────────────

/**
 * Persist the user metadata locally so the SPA shell can render
 * before the first API call. The auth token is NOT stored here —
 * it lives in the HttpOnly cookie the server set on the login
 * response. The optional second arg is kept for backwards-compat
 * with pre-H2 call sites that passed (user, token); the token is
 * silently discarded.
 */
export function saveSession(user, _ignoredToken) {
  const meta = {
    id:           user.id,
    name:         user.name,
    username:     user.username,
    role:         user.role,
    access:       user.access,
    member_id:    user.member_id,
    committee_id: user.committee_id,
    email:        user.email ?? null,
    loginAt:      new Date().toISOString(),
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(meta));
  if (user.username) localStorage.setItem(LAST_USER, user.username);
}

/**
 * Pre-H2 had a separate `saveSupabaseSession` that stored access_token
 * + refresh_token alongside the user profile. Post-H2 the bridge
 * action (`auth.exchangeSupabaseToken`) sets the cookie server-side
 * and we only persist metadata — same as the legacy path.
 */
export function saveSupabaseSession(_authResponse, userProfile) {
  return saveSession(userProfile);
}

/** Wipe local user metadata. Cookie is cleared separately via signOut(). */
export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    // Defensive: also wipe the pre-H2 keys in case the user re-loaded
    // the page before the import-time cleanup ran.
    localStorage.removeItem('ssam_token');
    localStorage.removeItem('ssam_supabase_session');
  } catch { /* private-browsing */ }
}

/**
 * End the session. Calls our `auth.signOut` action which emits a
 * clear-cookie Set-Cookie. Then wipes local metadata. Network errors
 * are swallowed — the local clear must always happen so the user
 * isn't stranded on a stale UI.
 *
 * Hard 3s timeout (2026-05-20): without it, a hanging request (offline
 * device, captive portal, blocked preflight) would leave the user
 * stuck on the page because the caller `await`s us before redirecting.
 * The cookie still gets cleared server-side on the eventual response;
 * if it doesn't, the next request 401s and the user re-logs.
 */
export async function signOut() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(API_URL, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey':       SUPABASE_ANON_KEY,
        },
        credentials: 'include',
        body:        JSON.stringify({ action: 'auth.signOut' }),
        signal:      controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch { /* network blip / abort — proceed to clear local state */ }
  clearSession();
}

// ─── Supabase Auth REST calls (transitional) ────────────────────────
// The frontend still uses Supabase's /auth/v1/token endpoint to verify
// passwords for migrated accounts — there's no point reimplementing
// that. The difference post-H2: we IMMEDIATELY hand the returned
// access_token to our own `auth.exchangeSupabaseToken` action, which
// sets the cookie and returns the user metadata we cache locally.
// Supabase's session JSON itself isn't persisted in JS anywhere.

/**
 * POST /auth/v1/token?grant_type=password. Returns the raw Supabase
 * response. The caller (login.js) then bridges to our cookie session
 * via `bridgeSupabaseSession`.
 */
export async function supabaseSignIn(email, password) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method:  'POST',
    headers: {
      'apikey':        SUPABASE_ANON_KEY,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = body?.error_description || body?.msg || body?.error || 'Sign-in failed';
    throw new Error(msg);
  }
  return body;
}

/**
 * Hand the Supabase access_token to our Edge Function. The server
 * verifies it, mints our own HS256 JWT for the user, sets the
 * ssam_session cookie, and returns the user metadata which we cache.
 */
export async function bridgeSupabaseSession(access_token) {
  const resp = await fetch(API_URL, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey':       SUPABASE_ANON_KEY,
    },
    credentials: 'include',
    body:        JSON.stringify({ action: 'auth.exchangeSupabaseToken', access_token }),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok || !body?.success) {
    throw new Error(body?.error || 'Session bridge failed');
  }
  return body.data?.user ?? body.user;
}

/**
 * PUT /auth/v1/user — updates the authenticated user's password.
 * Used by reset-password.html after Supabase puts a recovery token
 * in the URL fragment; the page sets it as the access_token and calls
 * this to set the user's new password.
 */
export async function supabaseUpdatePassword(accessToken, newPassword) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method:  'PUT',
    headers: {
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ password: newPassword }),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = body?.error_description || body?.msg || body?.error || 'Update failed';
    throw new Error(msg);
  }
  return body;
}
