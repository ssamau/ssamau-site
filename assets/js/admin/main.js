// SSAM Admin — entry module.
//
// After the per-tab split this file is just glue:
//   1. Auth guard + logout (was at the top of the old monolith).
//   2. The init function that primes the four "shared lookup" tables
//      (committees, members, projects, dashboard stats) before any tab
//      renders. Tabs assume DB.members/.committees/.projects are warm.
//   3. Wiring of the cross-module indirection: lib/ui.js needs to know
//      about showPage (for refreshData) and per-tab modal pre-populators
//      (populateRolePresets, populateHrsOpportunitySelect); router.js
//      needs the loader-by-page-name dispatch table.
//   4. Top-level DOM listeners that don't belong to any one tab — the
//      sidebar toggle, Escape-to-close, overlay-click-to-close, and the
//      sidebar user pill.
//   5. The window.* re-export shim at the bottom — admin.html still uses
//      inline onclick="..." everywhere; this hands every handler name
//      those attributes reference to the window object so they resolve.
//      The strict-CSP commit later replaces inline handlers with
//      addEventListener bindings, at which point the shim is gone.

import { getSession, clearSession, isLoggedIn, signOut, landingPageForAccess } from '../lib/auth.js';
// Re-validates the user's access level + status against the server at
// strategic moments (load, every 5min, visibilitychange) so an admin
// demoting / deactivating someone propagates without a re-login.
import { startPermissionWatcher } from '../lib/permission-watcher.js';
// Shared support module — modal + submit; the admin support inbox
// (list + detail + status change) lives in its own tab module below.
import {
  openSupportModal as openSupport, submitSupportTicket as submitSupport,
  onSupportFileChange,
} from '../lib/support.js';
import { applyStoredTheme, getTheme, setTheme } from '../lib/theme.js';

// i18n: side-effect import sets <html dir/lang> + applies data-i18n
// across the sidebar + topbar on first load. We also re-fire the
// active tab's loader on language change so JS-generated rows pick
// up the new copy.
import { t, getLang, setLang, onLangChange } from '../lib/i18n.js';

import { DB } from '../lib/state.js';
import { RBAC } from '../lib/rbac.js';
import {
  setApiStatus, setModalHooks, setRouter, setRefreshLoaders,
  openModal, closeModal,
  refreshData, confirmDelete, filterTable, populateNewSelects,
  populateProjectSelects, watchTableLabels,
} from '../lib/ui.js';

import {
  showPage, closeSidebar, toggleSidebar, setLoaders,
} from './router.js';
import { setHandlers, setupDispatch } from './dispatch.js';

// ── Per-tab modules ────────────────────────────────────────────────────────
import { loadDashboard } from './tabs/dashboard.js';
import {
  loadMembers, saveMember, editMember,
  filterMembersByRole, filterMembersByStatus,
  openInviteModal, sendInviteByEmail, sendInviteByPin,
  copyShownPin, confirmRevokeInvite,
  openMemberFile,
} from './tabs/members.js';
import {
  loadAdvisors, saveAdvisor, editAdvisor,
  filterAdvisorsByStatus, filterAdvisorsByRole, filterAdvisorsBySearch,
} from './tabs/advisors.js';
import { loadCommittees, saveCommittee, editCommittee } from './tabs/committees.js';
import {
  loadProjects, saveProject, editProject,
  filterProjectsByStatus, openModalWithPrj,
  onProjectPhotoChange, uploadProjectPhotoFromForm, deleteProjectPhotoFromForm,
} from './tabs/projects.js';
import {
  loadParticipants, saveParticipant, toggleParticipantFields,
} from './tabs/participants.js';
import {
  loadOpportunities, saveOpportunity, editOpportunity, confirmDeleteOpportunity,
  populateRolePresets, onOppRolePreset,
  addOppRoleRow, removeOppRoleRow, onOppRoleRowPreset,
  openOpportunityAssignments, addAssignmentMember, addAssignmentVolunteer,
  markAttendance, removeAssignment,
  openOpportunityNotify, toggleNotifyMode, sendOpportunityNotify,
} from './tabs/opportunities.js';
import {
  loadAttendance, saveAttendance, toggleAttFields,
  loadBulkAttGrid, cycleAttStatus, markAllAtt, saveBulkAttendance,
} from './tabs/attendance.js';
import {
  loadHours, saveHours, toggleHrsFields,
  populateHrsOpportunitySelect, onHrsOpportunityChange, onHrsAssignmentChange,
  primaryApproveHours, finalApproveHours, rejectHours,
} from './tabs/hours.js';
import { exportSacmReport } from './tabs/reports.js';
import {
  loadAccounts, openAccountModal, openAccountModalForMember, editAccount,
  generateAccountPw, saveAccount, resetAccountPassword, sendPasswordResetEmail,
  copyShownPw, confirmDeleteAccount,
  filterAccountsByAccess, filterAccountsByLogin, filterAccountsBySearch,
} from './tabs/accounts.js';
import {
  loadApplications, openApplicationReview,
  appAssignCommittee, appAccept, appRequestInterview, appReject,
  openInviteAsMember, submitInviteAsMember,
} from './tabs/applications.js';
import {
  loadProfileSelect, loadMemberProfile, viewProfile,
} from './tabs/profile.js';
import {
  loadInterestAll, loadInterest, saveInterest,
  toggleReviewedVisibility, openInterestAssign,
  confirmInterestAssign, interestMarkReviewed,
} from './tabs/interest.js';
import {
  loadThanks, saveThanks, saveBulkThanks,
} from './tabs/emails.js';
import {
  loadCerts, switchCertTab, issueCert, saveBulkCerts,
  previewCertCard, verifyCert,
} from './tabs/certificates.js';
import { attachTypeaheadByIds } from '../lib/typeahead.js';


// ================================================================
//  AUTH GUARD — checks login session before loading dashboard
// ================================================================
// Goes through lib/auth.js so both halves of "is this user logged in" stay
// in lockstep. Earlier this guard only looked at `ssam_session` and the
// logout helper only cleared `ssam_session`, leaving `ssam_token` behind —
// login.html's isLoggedIn() reads the token, so logout caused a redirect
// loop (login.html sees token → bounce to admin → admin sees no session →
// bounce to login → …). Mobile users couldn't escape it without closing
// the tab. clearSession() now wipes both keys atomically.
//
// We also re-run this on `pageshow` to catch the browser's back/forward
// cache: after logout the user is on /login.html, but pressing Back
// restores the admin page from bfcache WITHOUT re-executing this script,
// so the page renders even though the session is cleared. The pageshow
// handler fires on bfcache restore (event.persisted === true), kicks the
// user back to login, and stops the "ghost admin" state where a logged-
// out user sees stale data until they touch something that 401s.
// Apply the user's saved theme preference BEFORE anything renders.
// admin/main.js is a deferred module so DOM is already parsed by
// the time we run, but no paint has happened yet — setting the
// data-theme attribute on <html> here avoids a flash of light when
// the user prefers dark (or vice versa).
applyStoredTheme();

function _requireAuthOrRedirect() {
  const user = getSession();
  if (!user || !isLoggedIn()) {
    clearSession();
    window.location.replace('login.html');  // replace, not href, so back
                                            // doesn't reopen admin again
    return false;
  }
  // Wrong-portal guard. Member-tier users (member / volunteer) who land
  // here get bounced to /member.html. Heads are intentionally allowed —
  // their default landing is head.html, but they still need admin.html
  // for the full management toolset (creating events, opportunities,
  // assignments, etc.) that head.html doesn't replicate.
  if (user.access === 'member' || user.access === 'volunteer') {
    window.location.replace('member.html');
    return false;
  }
  window.CURRENT_USER = user;
  return true;
}
_requireAuthOrRedirect();
window.addEventListener('pageshow', _requireAuthOrRedirect);
// Start polling for server-side permission changes once we've passed
// the initial auth guard. Whoami throws err.access.member_inactive
// → watcher signs out + bounces. Access-level flip → save fresh
// profile + reload.
startPermissionWatcher();

async function logout() {
  if (!confirm(t('common.confirm_logout'))) return;
  // signOut() handles both auth paths: Supabase users get their
  // refresh token revoked server-side; legacy users just have their
  // local state cleared (HS256 tokens can't be revoked). Either way
  // clearSession runs at the end so we always exit to a clean state.
  // signOut has its own try/catch + 3s abort timeout, so the redirect
  // below always fires.
  await signOut();
  window.location.href = 'login.html';
}

// Direct binding (2026-05-20). The previous data-action wiring routed
// through dispatch.js, which only takes effect after setupDispatch()
// runs at the bottom of this file — hundreds of lines of imports +
// init later. Clicking signout before that point did literally nothing
// (the symptom Faisal hit: first click ignored, second click worked
// because by then the dispatcher was up). Direct addEventListener
// here works the instant the button exists in the DOM and main.js
// has executed past this line, with no dependence on any other
// module's initialization order.
document.getElementById('topbar-logout')?.addEventListener('click', logout);


'use strict';


// ════════════════════════════════════════════════════════════════════════════
// CROSS-MODULE WIRING
// ════════════════════════════════════════════════════════════════════════════
// lib/ui.js doesn't know about the router or the per-tab modal hooks at
// import time (would be a cycle). Inject them here, once, before any
// user-driven event could fire.
setRouter({ showPage });
setModalHooks({ populateHrsOpportunitySelect, populateRolePresets });

// router.js's showPage() dispatches a page-name to a loader; the loaders
// live across the tab modules. Build the map once. This mirrors the
// `loaders` object literal that used to sit inside the monolithic
// showPage().
//
// ensureProjects = lazy-load DB.projects if a tab needs it for its
// dropdowns but the user navigated straight there without visiting
// the Projects tab first. Originally surfaced as the "group
// attendance modal shows no projects" bug — DB.projects was empty so
// the populate step had nothing to fill the dropdowns with.
const ensureProjects = async () => {
  if (!DB.projects.length) await loadProjects();
};
const loaderMap = {
  dashboard:        loadDashboard,
  members:          loadMembers,
  applications:     loadApplications,
  accounts:         loadAccounts,
  advisors:         loadAdvisors,
  committees:       loadCommittees,
  projects:         loadProjects,
  // The four below all chain ensureProjects → optional populate →
  // actual loader. Each inner loader is `async` and returns a promise
  // that previously wasn't awaited — so the wrapper resolved instantly
  // after firing the load but before the data fetch finished, and
  // refreshData stripped the .refreshing class while the spinner was
  // mid-animation (visible only as a sub-frame flash on these tabs).
  // Awaiting the inner load means the spinner runs for the full fetch
  // lifetime, matching the dashboard/members/projects tabs above.
  participants:     async () => { await ensureProjects(); populateProjectSelects(); await loadParticipants(); },
  opportunities:    async () => { await ensureProjects(); populateProjectSelects(); await loadOpportunities(); },
  attendance:       async () => { await ensureProjects(); populateProjectSelects(); await loadAttendance(); },
  hours:            async () => { await ensureProjects(); await loadHours(); },
  profile:          loadProfileSelect,
  'my-profile':     async () => {
    // Lazy import — the self-edit profile module lives under member/
    // since member.html owns it primarily. Loading it on demand keeps
    // the admin bundle smaller for the (common) case where the admin
    // never opens their own profile tab.
    const m = await import('../member/tabs/profile.js');
    return m.loadProfile();
  },
  'project-detail': () => {},
  interest:         loadInterestAll,
  emails:           () => { loadThanks(''); },
  certificates:     () => { loadCerts(''); },
  // Support inbox — superadmin only. Lazy-import the tab module so
  // non-superadmins (who never see the sidebar entry) don't pay the
  // download cost.
  support:          async () => {
    const m = await import('./tabs/support.js');
    return m.loadSupportTickets();
  },
};
setLoaders(loaderMap);
// refreshData (in lib/ui.js) awaits the loader's promise so the
// spinner stays on until the fetch completes. Same map.
setRefreshLoaders(loaderMap);


// ════════════════════════════════════════════════════════════════════════════
// TOP-LEVEL DOM LISTENERS (independent of any one tab)
// ════════════════════════════════════════════════════════════════════════════

// Click-outside-modal-to-close. Wires every .overlay; the inline X buttons
// continue to call closeModal('<type>') directly.
document.querySelectorAll('.overlay').forEach(o =>
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); })
);

// Sidebar hamburger + backdrop wiring. Run on next tick so the DOM has the
// elements (init() above defers loaders behind setTimeout — these are
// instant).
document.getElementById('sb-toggle')   ?.addEventListener('click', toggleSidebar);
document.getElementById('sb-backdrop') ?.addEventListener('click', closeSidebar);

// Theme-toggle active-button sync. The CSS .sb-theme-btn.active highlight
// shows the user which of {auto, light, dark} is currently selected.
// Re-applied on init + on every change broadcast by lib/theme.js.
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


// ══════════════════════════════════════════
// INIT
// ══════════════════════════════════════════
//
// `<script type="module">` is deferred, so by the time this file executes
// the DOM is already parsed and `DOMContentLoaded` has already fired —
// attaching a listener to it now would silently never run. Trigger the init
// immediately when the DOM is ready, otherwise wait for it (`readyState`
// covers the cold-cache vs. cached-execution race cleanly).
function _initAdmin() {
  setApiStatus('pending', t('ap.topbar.api_connecting'));
  setTimeout(async () => {
    await loadCommittees();
    await loadMembers();
    await loadProjects();
    // Phase D — preload advisors so the hours modal's advisor picker
    // is populated whenever someone opens it, even if they haven't
    // visited the advisors tab yet in this session.
    await loadAdvisors();
    await loadDashboard();
    setApiStatus('ok', t('common.connected'));
    RBAC.applyUIRestrictions();
    // Attach the table-label MutationObserver. Has to wait until
    // the loads above have run so the initial tbodies exist —
    // before that there's nothing for `applyTableLabels` to walk.
    watchTableLabels();

    // Phase C — wire typeahead onto every member-picker <select> so
    // admins can search-as-they-type instead of scrolling a 100-item
    // dropdown. The typeahead reads .options dynamically so even if
    // populateNewSelects fills them later, the suggestions stay live.
    attachTypeaheadByIds(
      'profile-member-select',
      'cert-mbr-sel',
      'int-mbr-sel',
      'thx-mbr',
      'acc-member',
      'opp-assign-member',
      'par-member',
      'att-member',
      'hrs-member',
    );

    // Respect the URL hash if it's a valid admin route — lets a
    // refresh / bookmark / shared link land on the intended tab
    // instead of always bouncing to dashboard.
    const initialMatch = location.hash.match(/^#\/admin\/([a-z-]+)$/);
    showPage(initialMatch ? initialMatch[1] : 'dashboard');
  }, 300);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initAdmin);
} else {
  _initAdmin();
}


// ── INIT ─────────────────────────────────────────────────────
// Set sidebar user from session. Role is displayed via t() so the
// access enum ('superadmin' / 'admin' / 'head') gets a friendly
// localized label; falls back to the raw role / access string if a
// new access tier is introduced and the catalog hasn't caught up.
const ACCESS_KEY = {
  superadmin: 'ap.role.superadmin',
  admin:      'ap.role.admin',
  head:       'ap.role.head',
};
function _stampSidebarUser() {
  if (!window.CURRENT_USER) return;
  const u = window.CURRENT_USER;
  const nm = document.getElementById('sb-name') || document.getElementById('sb-nm');
  const rl = document.getElementById('sb-role') || document.getElementById('sb-rl');
  const av = document.getElementById('sb-av');
  const displayName = u.name || u.username || '—';
  if (nm) nm.textContent = displayName;
  if (rl) {
    const key = ACCESS_KEY[u.access];
    rl.textContent = key ? t(key) : (u.role || u.access || '—');
  }
  if (av) av.textContent = (displayName.charAt(0) || '?');
}
_stampSidebarUser();
// Refresh the role label on language change so it follows the toggle.
onLangChange(_stampSidebarUser);

// Reveal superadmin-only sidebar entries (.superadmin-only) for the
// presidency user. Other admins keep them display:none so they don't
// see the support inbox link — server enforces the same gate, this
// is just a UX nicety. Run after sidebar stamp so CURRENT_USER is
// guaranteed populated.
(function _revealSuperadminEntries() {
  const u = window.CURRENT_USER;
  if (!u || u.access !== 'superadmin') return;
  document.querySelectorAll('.superadmin-only').forEach(el => {
    el.style.display = '';
  });
})();

// Apps-Script-era "Seed members → Google Sheets" banner removed in the
// Netlify migration — the data lives in Postgres now and the import flow
// is `npm run import:members` (see SETUP.md). Keeping a no-op stub here
// so the existing init code doesn't break.
function injectSeedBanner() { /* removed — see commit history */ }

window.addEventListener('load', () => {
  setTimeout(() => {
    populateNewSelects();
    injectSeedBanner();
  }, 800);
});


// ─── Delegated event-handler dispatch ──────────────────────────────────────
// Replaces the previous Object.assign(window, {...}) shim. admin.html and
// every tab module's renderXxxRow function now emit `data-action="..."` +
// associated `data-*` attributes instead of inline `onclick="foo()"`. The
// dispatcher in assets/js/admin/dispatch.js owns delegated listeners on
// document; the map below tells it how to translate each data-action key
// into a call to the underlying handler function.
//
// Each wrapper takes `(el, event)` where `el` is the dispatched element
// (with the data-action). Wrappers exist purely to extract args from
// `el.dataset` / `el.value` — the underlying handlers (editMember,
// confirmDelete, etc.) keep their existing signatures so they're still
// callable directly from JS code paths (e.g. one tab calling another's
// load function).
setHandlers({
  // ── No-arg ──────────────────────────────────────────────────────
  // `logout` is bound directly (above) so it works even if dispatch
  // initialization is delayed — see the addEventListener comment.
  refreshData, copyShownPw, copyShownPin, generateAccountPw,
  saveAccount, saveAdvisor, saveAttendance, saveBulkAttendance,
  saveBulkCerts, saveBulkThanks, saveCommittee, saveHours, saveInterest,
  saveMember, saveOpportunity, saveParticipant, saveProject, saveThanks,
  addAssignmentMember, addAssignmentVolunteer,
  appAccept, appAssignCommittee, appReject, appRequestInterview,
  submitInviteAsMember,
  issueCert, verifyCert,
  onHrsAssignmentChange, onHrsOpportunityChange, onOppRolePreset,
  // Multi-role opportunity row management — bare references because each
  // takes (el, event) directly from the dispatcher.
  addOppRoleRow, removeOppRoleRow, onOppRoleRowPreset,
  toggleAttFields, toggleHrsFields, toggleParticipantFields,
  loadApplications, loadOpportunities,
  sendInviteByEmail, sendInviteByPin,

  // openAccountModal takes an optional `forEditId`. Bare-reference
  // dispatch (`openAccountModal,`) would pass the button element as
  // that arg — the element is truthy, so the modal opened in EDIT
  // mode and stamped "[object HTMLButtonElement]" into the hidden id
  // field. On save, parseInt(that, 10) = NaN → JSON null → server
  // 'id is required' error. Wrapping discards the dispatcher args.
  openAccountModal: () => openAccountModal(),

  // Self-edit profile (admin's own #/admin/my-profile tab). Lazy-load
  // the module so the admin bundle doesn't pull profile.js eagerly —
  // handlers are dispatched only when the user opens the tab.
  'profile.save': async ()    => { const m = await import('../member/tabs/profile.js'); return m.saveProfile(); },
  onUploaderChange: async (el) => { const m = await import('../member/tabs/profile.js'); return m.onUploaderChange(el); },
  submitUploader:   async (el) => { const m = await import('../member/tabs/profile.js'); return m.submitUploader(el); },
  deleteUploader:   async (el) => { const m = await import('../member/tabs/profile.js'); return m.deleteUploader(el); },

  // ── Hardcoded-string args via data-attribute ────────────────────
  closeModal:       (el) => closeModal(el.dataset.modal),
  openModal:        (el) => openModal(el.dataset.modal),
  showPage:         (el) => showPage(el.dataset.page),
  // Support / bug-report — sidebar opens modal; modal submit fires
  // the shared submitSupportTicket flow. The file picker is handled
  // through onSupportFileChange below (change-event branch).
  openSupportModal:    () => openSupport(),
  submitSupportTicket: () => submitSupport(),
  onSupportFileChange: (el) => onSupportFileChange(el),
  // Support inbox — superadmin only, lazy-loaded.
  loadSupportTickets:  async () => {
    const m = await import('./tabs/support.js');
    return m.loadSupportTickets();
  },
  openSupportTicket:   async (el) => {
    const m = await import('./tabs/support.js');
    return m.openSupportTicket(el.dataset.id);
  },
  setSupportStatus:    async (el) => {
    const m = await import('./tabs/support.js');
    return m.setSupportStatus(el.dataset.status);
  },
  switchCertTab:    (el) => switchCertTab(el.dataset.tab),
  markAllAtt:       (el) => markAllAtt(el.dataset.status),

  // ── this.value (on inputs / selects) ────────────────────────────
  filterMembersByRole:    (el) => filterMembersByRole(el.value),
  filterMembersByStatus:  (el) => filterMembersByStatus(el.value),
  // President's QOL 2026-05-18 — accounts tab filters.
  filterAccountsByAccess: (el) => filterAccountsByAccess(el.value),
  filterAccountsByLogin:  (el) => filterAccountsByLogin(el.value),
  filterAccountsBySearch: (el) => filterAccountsBySearch(el.value),
  // Advisors tab filters (2026-05-18).
  filterAdvisorsByStatus: (el) => filterAdvisorsByStatus(el.value),
  filterAdvisorsByRole:   (el) => filterAdvisorsByRole(el.value),
  filterAdvisorsBySearch: (el) => filterAdvisorsBySearch(el.value),
  filterProjectsByStatus: (el) => filterProjectsByStatus(el.value),
  loadAttendance:         (el) => loadAttendance(el.value),
  loadBulkAttGrid:        (el) => loadBulkAttGrid(el.value),
  loadCerts:              (el) => loadCerts(el.value),
  loadHours:              (el) => loadHours(el.value),
  // SACM monthly report — XLSX download. Bare reference so `el` is
  // passed through to withBusyButton inside the handler.
  exportSacmReport,
  loadInterest:           (el) => loadInterest(el.value),

  // ── Interest triage workflow (per-row buttons + header toggle) ──
  toggleReviewedVisibility:  (el) => toggleReviewedVisibility(el),
  openInterestAssign:        (el) => openInterestAssign(el),
  confirmInterestAssign:     confirmInterestAssign,
  interestMarkReviewed:      (el) => interestMarkReviewed(el),
  loadMemberProfile:      (el) => loadMemberProfile(el.value),
  loadParticipants:       (el) => loadParticipants(el.value),
  loadThanks:             (el) => loadThanks(el.value),

  // ── Search inputs (target tbody id + live value) ────────────────
  filterTable:      (el) => filterTable(el.dataset.target, el.value),

  // ── Single dynamic ID (string) ──────────────────────────────────
  editAdvisor:                 (el) => editAdvisor(el.dataset.id),
  editCommittee:               (el) => editCommittee(el.dataset.id),
  editMember:                  (el) => editMember(el.dataset.id),
  editOpportunity:             (el) => editOpportunity(el.dataset.id),
  editProject:                 (el) => editProject(el.dataset.id),
  // Phase B — project cover photo uploader (inside project edit modal)
  onProjectPhotoChange:        (el) => onProjectPhotoChange(el),
  uploadProjectPhoto:          uploadProjectPhotoFromForm,
  deleteProjectPhoto:          deleteProjectPhotoFromForm,
  openApplicationReview:       (el) => openApplicationReview(el.dataset.id),
  // Volunteer → member conversion. 🎫 button on volunteer rows opens
  // the committee-picker modal; submitInviteAsMember fires the server
  // action that creates the member + auto-invite.
  openInviteAsMember:          (el) => openInviteAsMember(el.dataset.id),
  openOpportunityAssignments:  (el) => openOpportunityAssignments(el.dataset.id),
  // Phase 2 of post-beta — opportunity notification flow
  openOpportunityNotify:       (el) => openOpportunityNotify(el),
  toggleNotifyMode:            (el) => toggleNotifyMode(el),
  sendOpportunityNotify:       sendOpportunityNotify,
  viewProfile:                 (el) => viewProfile(el.dataset.id),
  openAccountModalForMember:   (el) => openAccountModalForMember(el.dataset.id),
  openInviteModal:             (el) => openInviteModal(el.dataset.id),
  // Phase-A storage — admin per-row CV / photo viewers
  openMemberFile:              (el) => openMemberFile(el.dataset.id, el.dataset.kind),
  confirmRevokeInvite:         (el) => confirmRevokeInvite(el.dataset.id, el.dataset.name),

  // ── Single dynamic ID (numeric) ─────────────────────────────────
  editAccount:           (el) => editAccount(Number(el.dataset.id)),
  finalApproveHours:     (el) => finalApproveHours(Number(el.dataset.id)),
  primaryApproveHours:   (el) => primaryApproveHours(Number(el.dataset.id)),
  rejectHours:           (el) => rejectHours(Number(el.dataset.id)),
  removeAssignment:      (el) => removeAssignment(Number(el.dataset.id)),

  // ── Multi-arg ────────────────────────────────────────────────────
  confirmDelete:           (el) => confirmDelete(el.dataset.type, el.dataset.id, el.dataset.name),
  confirmDeleteAccount:    (el) => confirmDeleteAccount(Number(el.dataset.id), el.dataset.username),
  confirmDeleteOpportunity:(el) => confirmDeleteOpportunity(el.dataset.id, el.dataset.role),
  resetAccountPassword:    (el) => resetAccountPassword(Number(el.dataset.id), el.dataset.username),
  sendPasswordResetEmail:  (el) => sendPasswordResetEmail(Number(el.dataset.id), el.dataset.username, el.dataset.email),
  openModalWithPrj:        (el) => openModalWithPrj(el.dataset.modal, el.dataset.selector, el.dataset.projectId),

  // ── Pass the element itself ─────────────────────────────────────
  cycleAttStatus:   (el) => cycleAttStatus(el),

  // ── Theme toggle ────────────────────────────────────────────────
  // Sidebar's three-way switch. data-value is "auto" | "light" | "dark".
  // setTheme writes to localStorage + applies the data-theme attribute,
  // and broadcasts an ssam-theme-changed event the listener below uses
  // to sync the active-button class.
  setTheme:         (el) => setTheme(el.dataset.value),

  // ── Element + value combo ───────────────────────────────────────
  markAttendance:   (el) => markAttendance(Number(el.dataset.id), el.value),

  // ── JSON-encoded payload ────────────────────────────────────────
  // previewCertCard takes a whole certificate row — we stash the full
  // record as JSON in data-card so the handler unpacks it on click.
  previewCertCard:  (el) => previewCertCard(JSON.parse(el.dataset.card)),
});
setupDispatch();
