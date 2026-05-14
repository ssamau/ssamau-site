// Session/token storage helpers.
//
// Two auth paths coexist after the Supabase Auth migration:
//
//   1. Supabase Auth — most accounts.
//      Session shape: `{ access_token, refresh_token, expires_at, user }`
//      from POST /auth/v1/token. Stored under `ssam_supabase_session`.
//      access_token is a short-lived (1h) Supabase-issued JWT.
//
//   2. Legacy HS256 — the four leadership accounts without an email
//      (president, lead_mbr_enftku, lead_mbr_r82ypy, lead_mbr_22wj7q).
//      Session shape: { id, name, ..., token } where `token` is the
//      HS256 JWT minted by the Edge Function's `auth` action.
//      Stored under `ssam_session` + `ssam_token` (existing keys).
//
// Both paths feed the same `getToken()` / `getSession()` / `isLoggedIn()`
// / `clearSession()` helpers below, so call sites in admin/main.js
// don't need to know which path is active.
//
// localStorage is the storage layer for both, switched from
// sessionStorage in the spa-and-pwa branch. The reason: mobile
// WebView (which Capacitor uses for the iOS + Android wrap) suspends
// the renderer process when the app backgrounds, and on resume the
// sessionStorage namespace is empty — users get force-logged-out
// every time they switch apps. With localStorage the session
// survives suspends + cold launches, which is what users expect from
// a "real" native app.
//
// The XSS risk that originally justified sessionStorage is mitigated
// by the CSP we landed on Branch 1 (script-src 'self' + GTM only,
// no `unsafe-inline` for <script> elements) and tightened further
// later in this branch by dropping 'unsafe-inline' from
// script-src-attr too.
//
// `ssam_last_user` was already in localStorage from earlier; nothing
// changes for it.
//
// Migration of existing in-flight sessions: the very first time a
// user loads the new code, they'll see no session (it's still in
// sessionStorage from before). They'll have to log in once. That's
// fine — for the 22 leadership users this is a one-time blip.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './api.js';

const SUP_SESSION_KEY    = 'ssam_supabase_session';
const LEGACY_SESSION_KEY = 'ssam_session';
const LEGACY_TOKEN_KEY   = 'ssam_token';
const LAST_USER          = 'ssam_last_user';

// ─── Reads ──────────────────────────────────────────────────────────

function readSupabaseSession() {
  try { return JSON.parse(localStorage.getItem(SUP_SESSION_KEY) || 'null'); }
  catch { return null; }
}

function readLegacySession() {
  try { return JSON.parse(localStorage.getItem(LEGACY_SESSION_KEY) || 'null'); }
  catch { return null; }
}

// Returns the current user profile (access_level, member_id, etc.) from
// whichever session is active. The shape is the SAME for both providers
// — that's what `auth.whoami` is for on the Supabase path: it returns
// fields matching the legacy `auth` action's response.
export function getSession() {
  const sup = readSupabaseSession();
  if (sup?.user) return sup.user;
  return readLegacySession();
}

// Returns the bearer token to attach to API calls. Supabase token if a
// valid session is present (checks expiry — Supabase tokens expire
// after 1h and we'll refresh in a later commit; for now if expired,
// the api client gets 401 and clears the session). Falls back to the
// legacy HS256 token.
export function getToken() {
  const sup = readSupabaseSession();
  if (sup?.access_token) {
    const expiresAtSec = sup.expires_at || 0;
    const nowSec       = Math.floor(Date.now() / 1000);
    if (expiresAtSec > nowSec + 5) {
      return sup.access_token;
    }
    // Expired — fall through. The api client will get 401 and call
    // clearSession() which removes this key.
  }
  return localStorage.getItem(LEGACY_TOKEN_KEY) || '';
}

// Pre-fill helper for the login form. Stores whatever the user last
// typed (could be email/NID/username) so they don't retype it.
export function getLastUsername() {
  return localStorage.getItem(LAST_USER) || '';
}

// True if any session is present. Doesn't validate the token — server
// returns 401 if expired/invalid and the api client clears+redirects.
export function isLoggedIn() {
  return !!getToken();
}

// Pick the right post-login landing page based on the access_level
// stamped on the session profile. The 19 leadership users
// (superadmin + head) land on admin.html where they can see the
// full operational dashboard (members, committees, hours, etc).
// The 98 regular members + future volunteers land on member.html
// — their own simpler portal with their hours / opportunities /
// profile.
//
// Used in three places:
//  1. login.js — immediately after a successful sign-in
//  2. login.js — on page load if the user already has a session
//     (prevents them from sitting on the login form after they
//     hit Back from inside their portal)
//  3. admin/main.js and member.html — as a "wrong-portal guard"
//     so a member who manually types /admin.html in the URL bar
//     gets bounced to member.html, and vice versa
//
// Defaults to admin.html when the access value is missing or
// unrecognised — fail safe, the admin portal has its own RBAC
// layer that hides what the user shouldn't see.
export function landingPageForAccess(access) {
  if (access === 'member' || access === 'volunteer') return 'member.html';
  return 'admin.html';
}

// ─── Writes ─────────────────────────────────────────────────────────

// Save a Supabase session. authResponse comes from POST /auth/v1/token,
// userProfile from a follow-up `auth.whoami` call.
export function saveSupabaseSession(authResponse, userProfile) {
  // Compute absolute expiry timestamp from Supabase's `expires_at` if
  // present (epoch seconds), else `expires_in` (seconds-from-now).
  const expires_at = authResponse.expires_at
    || Math.floor(Date.now() / 1000) + (authResponse.expires_in || 3600);
  const stored = {
    access_token:  authResponse.access_token,
    refresh_token: authResponse.refresh_token,
    expires_at,
    user: {
      ...userProfile, // id, username, name, access, member_id, committee_id
      email:          authResponse.user?.email ?? userProfile?.email ?? null,
      auth_user_id:   authResponse.user?.id    ?? userProfile?.auth_user_id ?? null,
      loginAt:        new Date().toISOString(),
    },
  };
  localStorage.setItem(SUP_SESSION_KEY, JSON.stringify(stored));
  // Persist the identifier the user successfully signed in with — could
  // be email, NID, or username (login.js passes whichever they typed).
  if (stored.user.username) localStorage.setItem(LAST_USER, stored.user.username);
}

// Save a legacy session. Unchanged from before the auth migration.
export function saveSession(user, token) {
  const session = {
    id:           user.id,
    name:         user.name,
    username:     user.username,
    role:         user.role,
    access:       user.access,
    member_id:    user.member_id,
    committee_id: user.committee_id,
    token,
    loginAt:      new Date().toISOString(),
  };
  localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(session));
  localStorage.setItem(LEGACY_TOKEN_KEY, token);
  if (user.username) localStorage.setItem(LAST_USER, user.username);
}

// Clears every auth artefact. Called by signOut + api.js on 401.
export function clearSession() {
  localStorage.removeItem(SUP_SESSION_KEY);
  localStorage.removeItem(LEGACY_SESSION_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

// Sign out. For Supabase sessions, fire the /auth/v1/logout endpoint to
// invalidate the refresh token server-side. For legacy, just clear
// local state (HS256 tokens can't be revoked, they just expire).
export async function signOut() {
  const sup = readSupabaseSession();
  if (sup?.access_token) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method:  'POST',
        headers: {
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + sup.access_token,
        },
      });
    } catch { /* network blip is fine — we clear local state anyway */ }
  }
  clearSession();
}

// ─── Supabase Auth REST calls ───────────────────────────────────────
// Direct fetch instead of the @supabase/supabase-js client — the
// frontend only needs three endpoints (sign-in, password-reset,
// recovery callback), and skipping the ~80KB JS bundle is a big win on
// mobile. If the surface area grows past these three we'll vendor the
// real SDK.

// POST /auth/v1/token?grant_type=password — returns the session.
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
    // Supabase error envelopes vary across endpoints. error_description
    // is the most common, `msg` is the older shape.
    const msg = body?.error_description || body?.msg || body?.error || 'Sign-in failed';
    throw new Error(msg);
  }
  return body; // { access_token, refresh_token, expires_in, expires_at, user }
}

// PUT /auth/v1/user — updates the authenticated user's password.
// Used by the reset-password page after Supabase puts a recovery token
// in the URL fragment; the page sets it as the access_token and calls
// this to set the user's new password.
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
