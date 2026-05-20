// SSAM Member portal — entry module (Phase 5 of Branch 4).
//
// Glue layer mirroring admin/main.js's responsibilities, but scoped to
// the 4-tab member portal:
//   1. Auth guard + wrong-portal bounce (admin-tier → admin.html)
//   2. Setup the loader map (page → loader function) and wire it into
//      the router
//   3. Wire the dispatcher (event delegation for data-action attributes)
//   4. Top-level DOM listeners — sidebar toggle, Escape-to-close,
//      backdrop-click-to-close, theme buttons
//   5. Initial render based on the URL hash (so refresh / bookmark
//      lands on the right tab)
//
// One simplification vs admin/main.js: there's no big "warm shared DB"
// preload step because the member portal only ever shows one member's
// data + a list of opportunities. Each tab's loader does its own fetch.

import { applyStoredTheme, getTheme, setTheme } from '../lib/theme.js';
applyStoredTheme();

// i18n: side-effect import sets <html dir/lang> + applies data-i18n
// to the sidebar + topbar markup. On language change we re-fire the
// active page's loader so JS-generated rows in the tabs re-render with
// the new language's labels (status badges, empty-state copy, etc.).
import { t, getLang, setLang, onLangChange } from '../lib/i18n.js';

import {
  getSession, clearSession, isLoggedIn, signOut, landingPageForAccess,
} from '../lib/auth.js';
// Permission revalidation — same module as admin/head. Bounces the
// user to login if marked inactive and reloads on access-level change.
import { startPermissionWatcher } from '../lib/permission-watcher.js';
import { setApiStatus } from '../lib/ui.js';
import {
  showPage, closeSidebar, toggleSidebar, setLoaders,
} from './router.js';
import { setHandlers, setupDispatch } from './dispatch.js';

// ── Per-tab modules ────────────────────────────────────────────────────────
import {
  loadProfile, saveProfile,
  onUploaderChange, submitUploader, deleteUploader,
} from './tabs/profile.js';
import { loadHours } from './tabs/hours.js';
// Shared support module — available from the member sidebar so members
// can fire a bug report from anywhere. The inbox view is admin-only.
import {
  openSupportModal, submitSupportTicket, onSupportFileChange,
} from '../lib/support.js';
import {
  loadOpportunities, withdrawInterest,
  openPickRoleModal, closePickRoleModal, submitPickRole,
  filterMemberOppsByDate, filterMemberOppsByCommittee, filterMemberOppsBySearch,
} from './tabs/opportunities.js';
import {
  loadAssignments,
  openLogHoursModal, closeLogHoursModal, submitLogHours,
} from './tabs/assignments.js';


// ════════════════════════════════════════════════════════════════════════════
// AUTH GUARD — wrong-portal bounce + logged-out → login.html
// ════════════════════════════════════════════════════════════════════════════
// Same shape as admin/main.js's _requireAuthOrRedirect() but inverted:
// admin bounces non-admin tiers to member.html; we bounce admin tiers
// to admin.html. The pageshow listener catches bfcache restore (back
// button after logout) so a logged-out user can't see a stale ghost
// of the portal.

function _requireMemberAuthOrRedirect() {
  const user = getSession();
  if (!user || !isLoggedIn()) {
    clearSession();
    window.location.replace('login.html');
    return false;
  }
  const landing = landingPageForAccess(user.access);
  if (landing !== 'member.html') {
    // superadmin / admin / head ended up here — manual URL, stale
    // bookmark, freshly-promoted account. Send them to admin.html.
    window.location.replace(landing);
    return false;
  }
  window.CURRENT_USER = user;
  return true;
}
_requireMemberAuthOrRedirect();
window.addEventListener('pageshow', _requireMemberAuthOrRedirect);
// Start permission watcher — same hooks as admin + head.
startPermissionWatcher();

async function logout() {
  if (!confirm(t('common.confirm_logout'))) return;
  // signOut() handles both auth paths: Supabase users get their refresh
  // token revoked; legacy users have their local state cleared. clearSession
  // runs at the end either way. signOut has its own 3s timeout, so the
  // redirect below always fires even on a hung network.
  try { await signOut(); } catch (err) {
    console.warn('[member] signOut error (ignored):', err);
  }
  window.location.href = 'login.html';
}

// Direct binding so signout works the moment the button exists,
// independent of when the data-action dispatcher comes up. See the
// admin/main.js note for the regression this prevents.
document.getElementById('topbar-logout')?.addEventListener('click', logout);


// ════════════════════════════════════════════════════════════════════════════
// CROSS-MODULE WIRING
// ════════════════════════════════════════════════════════════════════════════
// Map page name → loader function, then hand it to the router so showPage
// can dispatch on navigation. Loaders are responsible for their own fetch
// + render — main.js doesn't preload anything.
const loaderMap = {
  profile:       loadProfile,
  hours:         loadHours,
  opportunities: loadOpportunities,
  assignments:   loadAssignments,
};
setLoaders(loaderMap);


// ════════════════════════════════════════════════════════════════════════════
// TOP-LEVEL DOM LISTENERS
// ════════════════════════════════════════════════════════════════════════════

document.getElementById('sb-toggle')   ?.addEventListener('click', toggleSidebar);
document.getElementById('sb-backdrop') ?.addEventListener('click', closeSidebar);

// Theme button active-state sync. Same pattern as admin/main.js — the
// CSS .sb-theme-btn.active highlight shows which of {auto, light, dark}
// is currently selected. Re-applied on init + on every change broadcast
// by lib/theme.js.
function _syncThemeButtons() {
  const current = getTheme();
  document.querySelectorAll('.sb-theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === current);
  });
}
window.addEventListener('ssam-theme-changed', _syncThemeButtons);
_syncThemeButtons();

// ── Language toggle wiring ──────────────────────────────────────────
// Pills sit in the sidebar between the nav and the theme row. Active
// state mirrors the theme-button pattern; flip the lang AND re-fire
// the current tab's loader so JS-generated content re-renders.
function _syncLangButtons() {
  const cur = getLang();
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === cur);
  });
}
document.querySelectorAll('[data-action="setLang"]').forEach(btn => {
  btn.addEventListener('click', () => setLang(btn.dataset.value));
});
onLangChange(() => {
  _syncLangButtons();
  // Re-fire the active tab's loader so dynamic rows (status badges,
  // empty-state copy, action buttons) re-render in the new language.
  const active = document.querySelector('.page.active');
  if (!active) return;
  const page = active.id.replace('page-', '');
  const loader = loaderMap[page];
  if (loader) loader();
});
_syncLangButtons();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSidebar();
});


// ════════════════════════════════════════════════════════════════════════════
// SIDEBAR USER STAMP
// ════════════════════════════════════════════════════════════════════════════
// Mirror admin's "set sidebar user from session" block. The user's display
// name + role + first-letter avatar render from the cached session, so we
// don't have to wait for the profile fetch to populate the chrome.
//
// ACCESS_LABEL_AR is declared above the use-site (rather than below, as a
// reader might expect from co-location) because `const` is in the temporal
// dead zone until its declaration line executes — referencing it earlier
// silently throws and the role/avatar updates never run.
const ACCESS_LABEL_AR = {
  member:    'عضو',
  volunteer: 'متطوع',
};
if (window.CURRENT_USER) {
  const u = window.CURRENT_USER;
  const nm = document.getElementById('sb-name');
  const rl = document.getElementById('sb-role');
  const av = document.getElementById('sb-av');
  const displayName = u.name || u.username || '—';
  if (nm) nm.textContent = displayName;
  // Show "عضو" / "متطوع" instead of the raw enum value — friendlier
  // than displaying "member" in an Arabic UI.
  if (rl) rl.textContent = ACCESS_LABEL_AR[u.access] || u.role || u.access || '—';
  if (av) av.textContent = (displayName.charAt(0) || '?');
}


// ════════════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════════════
// <script type="module"> is deferred, so by the time this runs the DOM is
// parsed and DOMContentLoaded already fired. Trigger init immediately,
// fall back to a DOMContentLoaded listener if we're somehow still loading.
function _initMember() {
  setApiStatus('ok', 'متصل');
  // Respect the URL hash if valid — refresh / bookmark / shared link
  // lands on the intended tab instead of always bouncing to profile.
  const m = location.hash.match(/^#\/member\/([a-z-]+)$/);
  const initial = m && loaderMap[m[1]] ? m[1] : 'profile';
  showPage(initial);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initMember);
} else {
  _initMember();
}


// ════════════════════════════════════════════════════════════════════════════
// DELEGATED HANDLERS
// ════════════════════════════════════════════════════════════════════════════
// Every clickable / changeable element with data-action="..." routes
// through the dispatcher. Tab modules export their handlers; we extract
// args from data-* / .value here so the underlying functions keep clean
// signatures (still callable directly from JS).
setHandlers({
  // ── No-arg ────────────────────────────────────────────────────────
  // `logout` is bound directly above — see the addEventListener note.
  'profile.save':    saveProfile,

  // ── Hardcoded-string args ─────────────────────────────────────────
  showPage:          (el) => showPage(el.dataset.page),
  setTheme:          (el) => setTheme(el.dataset.value),

  // ── Live filter on tables (input event, value-driven) ─────────────
  // Reuses lib/ui.js's filterTable via dynamic import below — kept
  // local to avoid bringing the whole admin filter logic into the
  // member bundle. filterTable's signature: (tbodyId, queryString).
  filterTable:       async (el) => {
    const { filterTable } = await import('../lib/ui.js');
    filterTable(el.dataset.target, el.value);
  },

  // ── Per-row "express interest" button on opportunities tab ─────────
  // Multi-role (2026-05-18): clicking "اهتمام" opens the pick-role modal
  // which lists every role + a sticky "any role" fallback. Submitting
  // fires interest.submit with opportunity_id + role_id.
  openPickRoleModal:  (el) => openPickRoleModal(el),
  closePickRoleModal: closePickRoleModal,
  submitPickRole:     submitPickRole,
  // Withdraw stays a direct button on already-expressed rows. Server
  // updates the same row's `interested = false` so the audit trail
  // (which role they picked) is preserved.
  withdrawInterest:  (el) => withdrawInterest(el.dataset.opportunity, null, el),
  // QOL filters (president's ask 2026-05-18). Each just kicks an
  // in-memory re-render via _applyMemberOppFilters() in the tab module.
  filterMemberOppsByDate:      (el) => filterMemberOppsByDate(el.value),
  filterMemberOppsByCommittee: (el) => filterMemberOppsByCommittee(el.value),
  filterMemberOppsBySearch:    (el) => filterMemberOppsBySearch(el.value),

  // ── Hours self-submission (assignments tab → log-hours modal) ──────
  openLogHours:        (el) => openLogHoursModal(
    el.dataset.assignment, el.dataset.role, el.dataset.project, el.dataset.estimated,
  ),
  closeLogHoursModal:  closeLogHoursModal,
  submitLogHours:      submitLogHours,

  // ── Phase A storage uploaders (profile tab → CV + photo) ───────────
  onUploaderChange:    onUploaderChange,
  submitUploader:      submitUploader,
  deleteUploader:      deleteUploader,

  // ── Support / bug-report ──────────────────────────────────────────
  // sidebar entry opens modal; modal submit + file picker share the
  // dispatcher. lib/support.js is shared with admin + head.
  openSupportModal:    () => openSupportModal(),
  submitSupportTicket: () => submitSupportTicket(),
  onSupportFileChange: (el) => onSupportFileChange(el),
});
setupDispatch();
