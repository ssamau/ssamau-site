// member.html logic — Phase 4 of Branch 4 (placeholder portal).
//
// Three responsibilities, all tiny:
//   1. Wrong-portal guard. If no session → /login.html. If session is
//      admin-tier (superadmin/head) → /admin.html. Only member /
//      volunteer-tier sessions are allowed to stay on this page.
//   2. Greeting. Pull the user's name from the session and personalise
//      the welcome.
//   3. Logout wiring. The button calls signOut() from lib/auth.js
//      which clears the localStorage session and redirects to /login.html.
//
// Once Phase 5 lands and this page grows into a real portal with
// tabs + data fetches, the guard logic stays the same — wrong-tier
// users still get bounced. Everything else gets layered on top.

import { applyStoredTheme } from './lib/theme.js';
applyStoredTheme();

import {
  isLoggedIn, getSession, signOut, landingPageForAccess,
} from './lib/auth.js';
import { $ } from './lib/dom.js';

// ── Guards (run synchronously before paint to avoid a flash of the
//    placeholder content for someone who's about to be redirected) ──
if (!isLoggedIn()) {
  window.location.href = 'login.html';
}

const session = getSession();
const access  = session?.access || '';

if (access !== 'member' && access !== 'volunteer') {
  // Admin-tier (superadmin/head) ended up here somehow — manual URL
  // typing, stale bookmark, etc. Send them to their actual portal.
  // landingPageForAccess returns 'admin.html' for any non-member
  // access value, so we route by re-using the same helper login.js
  // uses for new sign-ins. If access happens to be empty (corrupt
  // session) we default to admin.html and let admin's own RBAC do
  // the right thing.
  window.location.href = landingPageForAccess(access);
}

// ── Personalise the greeting once we know it's a legit member ──────
const greetingEl = $('#greeting');
if (greetingEl && session?.name) {
  greetingEl.textContent = `أهلًا ${session.name} 👋`;
}

// ── Logout button ──────────────────────────────────────────────────
// signOut() handles both auth providers (Supabase + legacy) and
// clears localStorage. It does NOT redirect on its own — that's the
// caller's job (admin/main.js's logout() function does the same
// explicit redirect after await). Without the redirect below,
// signOut returns cleanly, this handler ends, and the user is left
// sitting on member.html with no session — the wrong-portal guards
// only run on page load, so the user has to refresh manually before
// the redirect kicks in. Bug reported during PR #19 testing.
//
// The redirect lives outside the try/catch so it fires on both the
// success and the network-blip paths.
$('#logout-btn')?.addEventListener('click', async () => {
  try {
    await signOut();
  } catch (err) {
    // Even if Supabase's revoke call fails (offline, server blip),
    // signOut clears localStorage first so the session is effectively
    // gone. Surface the error to console for debugging but proceed
    // to the redirect anyway.
    console.warn('[member] signOut error (ignored):', err);
  }
  window.location.href = 'login.html';
});
