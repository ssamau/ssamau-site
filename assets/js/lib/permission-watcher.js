// Permission watcher — re-validates the user's access level against
// auth.whoami at strategic moments so a server-side permission change
// propagates without requiring the user to log out and back in.
//
// Triggers:
//   1. On portal page load (the explicit init() call).
//   2. Every 5 minutes while the tab is open.
//   3. When the tab regains visibility after being backgrounded.
//
// Actions on detected change:
//   - If access_level changed → save the new profile + reload the
//     current page so the sidebar / tab visibility / RBAC checks
//     pick up the new role. The user keeps their session.
//   - If the server returns err.access.member_inactive → sign out
//     entirely and bounce to login with the localized "you are
//     currently inactive…" message.
//
// Why a separate module: the existing isLoggedIn() / clearSession()
// flow only fires on 401 or on logout — it doesn't catch "you're
// still authenticated but your role changed". This adds that signal
// without touching every admin/head/member main.js individually.

import { callApi } from './api.js';
import {
  getSession, saveSession, saveSupabaseSession, clearSession,
  signOut, landingPageForAccess,
} from './auth.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let _started = false;
let _pollTimer = null;

export function startPermissionWatcher() {
  if (_started) return;  // Idempotent — admin/head/member main.js can all call this safely.
  _started = true;

  // Fire once immediately (catches the case where access changed
  // between login and this page load).
  _check();

  // Repeat at the poll interval.
  _pollTimer = setInterval(_check, POLL_INTERVAL_MS);

  // Re-check when the tab comes back to the foreground. Common case:
  // admin demotes a user in another tab, then the demoted user
  // switches to their already-open tab — visibilitychange catches it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _check();
  });
}

async function _check() {
  // Skip when not logged in — nothing to validate.
  const current = getSession();
  if (!current) return;

  let res;
  try {
    res = await callApi('auth.whoami');
  } catch {
    // Network blip — try again on the next interval. No action needed.
    return;
  }

  // Server explicitly told us the member is now Inactive (the gate
  // added with the inactive-login feature). Tear down the session
  // and bounce to login with a localized message.
  if (res && res.error === 'err.access.member_inactive') {
    try { await signOut(); } catch { /* ignore */ }
    clearSession();
    // Use replace() so the back button doesn't return them to the
    // protected page after sign-out.
    window.location.replace('login.html?inactive=1');
    return;
  }

  // Other failure (e.g. transient 500) — leave the session alone.
  if (!res || !res.success) return;

  const fresh = res.data || {};

  // Detect a meaningful change in role/access. Only access flips
  // require a reload (sidebar visibility + portal routing depend on
  // it). Committee changes are tracked too but coerced through `||
  // null` so `undefined` from a legacy session shape compares equal
  // to `null` from a fresh whoami — without that, the watcher used to
  // reload the page on every cold load when the stored session
  // happened to omit committee_id, silently nuking whatever the user
  // had just clicked. (2026-05-17 bug fix; root cause of the
  // president's "no buttons work on projects/events" report.)
  const norm = v => (v == null ? null : v);
  const changedAccess    = norm(fresh.access)       !== norm(current.access)       && fresh.access != null;
  const changedRole      = norm(fresh.role)         !== norm(current.role)         && fresh.role   != null;
  const changedCommittee = norm(fresh.committee_id) !== norm(current.committee_id);

  if (!changedAccess && !changedRole && !changedCommittee) return;

  // For a committee-only change with no access flip, skip the
  // reload. Sidebar / RBAC is keyed off access, not committee, so
  // a committee-id-changed page reload buys nothing and can only
  // surprise the user mid-action.
  if (!changedAccess && !changedRole) {
    // Silently update the stored session so the next API call
    // sees the new committee, but don't reload.
    _persistFreshSession(fresh);
    return;
  }

  // Persist the new profile then route. Reload only on access change
  // (sidebar/RBAC keyed off access); committee-only changes already
  // returned early above.
  _persistFreshSession(fresh);

  const wantedLanding = landingPageForAccess(fresh.access);
  const currentPath   = window.location.pathname;
  if (currentPath.endsWith(wantedLanding) || currentPath === '/' + wantedLanding) {
    // Same portal — reload so RBAC re-runs against fresh access.
    window.location.reload();
  } else {
    window.location.href = wantedLanding;
  }
}

// Persist the latest profile into whichever storage key the active
// session uses. Two paths because saveSession vs saveSupabaseSession
// write to different keys depending on the auth provider the user
// logged in through. We mirror whatever shape the existing session
// has so the watcher doesn't accidentally promote a legacy session
// to a Supabase one or vice versa.
function _persistFreshSession(fresh) {
  if (localStorage.getItem('ssam_supabase_session')) {
    try {
      const wrapper = JSON.parse(localStorage.getItem('ssam_supabase_session') || '{}');
      saveSupabaseSession(wrapper, fresh);
    } catch {
      saveSession(fresh, localStorage.getItem('ssam_token') || '');
    }
  } else {
    saveSession(fresh, localStorage.getItem('ssam_token') || '');
  }
}

export function stopPermissionWatcher() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
  _started = false;
}
