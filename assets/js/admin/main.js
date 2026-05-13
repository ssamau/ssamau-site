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

import { getSession, clearSession, isLoggedIn, signOut } from '../lib/auth.js';

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

// ── Per-tab modules ────────────────────────────────────────────────────────
import { loadDashboard } from './tabs/dashboard.js';
import {
  loadMembers, saveMember, editMember,
  filterMembersByRole, filterMembersByStatus,
} from './tabs/members.js';
import { loadAdvisors, saveAdvisor, editAdvisor } from './tabs/advisors.js';
import { loadCommittees, saveCommittee, editCommittee } from './tabs/committees.js';
import {
  loadProjects, saveProject, editProject,
  filterProjectsByStatus, openModalWithPrj,
} from './tabs/projects.js';
import {
  loadParticipants, saveParticipant, toggleParticipantFields,
} from './tabs/participants.js';
import {
  loadOpportunities, saveOpportunity, editOpportunity, confirmDeleteOpportunity,
  populateRolePresets, onOppRolePreset,
  openOpportunityAssignments, addAssignmentMember, addAssignmentVolunteer,
  markAttendance, removeAssignment,
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
import {
  loadAccounts, openAccountModal, openAccountModalForMember, editAccount,
  generateAccountPw, saveAccount, resetAccountPassword, sendPasswordResetEmail,
  copyShownPw, confirmDeleteAccount,
} from './tabs/accounts.js';
import {
  loadApplications, openApplicationReview,
  appAssignCommittee, appAccept, appRequestInterview, appReject,
} from './tabs/applications.js';
import {
  loadProfileSelect, loadMemberProfile, viewProfile,
} from './tabs/profile.js';
import {
  loadInterestAll, loadInterest, saveInterest,
} from './tabs/interest.js';
import {
  loadThanks, saveThanks, saveBulkThanks,
} from './tabs/emails.js';
import {
  loadCerts, switchCertTab, issueCert, saveBulkCerts,
  previewCertCard, verifyCert,
} from './tabs/certificates.js';


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
function _requireAuthOrRedirect() {
  const user = getSession();
  if (!user || !isLoggedIn()) {
    clearSession();
    window.location.replace('login.html');  // replace, not href, so back
                                            // doesn't reopen admin again
    return false;
  }
  window.CURRENT_USER = user;
  return true;
}
_requireAuthOrRedirect();
window.addEventListener('pageshow', _requireAuthOrRedirect);

async function logout() {
  if (!confirm('هل تريد تسجيل الخروج؟')) return;
  // signOut() handles both auth paths: Supabase users get their
  // refresh token revoked server-side; legacy users just have their
  // local state cleared (HS256 tokens can't be revoked). Either way
  // clearSession runs at the end so we always exit to a clean state.
  await signOut();
  window.location.href = 'login.html';
}


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
  participants:     async () => { await ensureProjects(); populateProjectSelects(); loadParticipants(); },
  opportunities:    async () => { await ensureProjects(); populateProjectSelects(); loadOpportunities(); },
  attendance:       async () => { await ensureProjects(); populateProjectSelects(); loadAttendance(); },
  hours:            async () => { await ensureProjects(); loadHours(); },
  profile:          loadProfileSelect,
  'project-detail': () => {},
  interest:         loadInterestAll,
  emails:           () => { loadThanks(''); },
  certificates:     () => { loadCerts(''); },
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
  setApiStatus('pending', 'جاري الاتصال...');
  setTimeout(async () => {
    await loadCommittees();
    await loadMembers();
    await loadProjects();
    await loadDashboard();
    setApiStatus('ok', 'متصل');
    RBAC.applyUIRestrictions();
    // Attach the table-label MutationObserver. Has to wait until
    // the loads above have run so the initial tbodies exist —
    // before that there's nothing for `applyTableLabels` to walk.
    watchTableLabels();
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
// Set sidebar user from session
if (window.CURRENT_USER) {
  const u = window.CURRENT_USER;
  const nm = document.getElementById('sb-name') || document.getElementById('sb-nm');
  const rl = document.getElementById('sb-role') || document.getElementById('sb-rl');
  const av = document.getElementById('sb-av');
  const displayName = u.name || u.username || '—';
  if (nm) nm.textContent = displayName;
  if (rl) rl.textContent = u.role || u.access || '—';
  if (av) av.textContent = (displayName.charAt(0) || '?');
}

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


// ─── Inline-handler re-exports ──────────────────────────────────────────────
// admin.html still uses onclick="foo()" attributes throughout. ES modules are
// module-scoped, so handlers declared in this file aren't visible to inline
// HTML attributes unless we attach them to window. This block does that for
// every name reachable from a current inline handler — sourced by grepping
// admin.html for `on(click|change|submit|input|keydown|load)="<name>("`.
//
// Temporary scaffolding: the strict-CSP commit later in this branch removes
// the inline onclick="..." attributes from the markup and replaces them with
// addEventListener bindings, at which point this Object.assign goes away.
Object.assign(window, {
  // ── Generic / shared ─────────────────────────
  showPage, openModal, closeModal, refreshData, logout, filterTable, copyShownPw,

  // ── Members ──────────────────────────────────
  saveMember, editMember, filterMembersByRole, filterMembersByStatus, viewProfile, loadMemberProfile,

  // ── Advisors ─────────────────────────────────
  saveAdvisor, editAdvisor,

  // ── Committees ───────────────────────────────
  saveCommittee, editCommittee,

  // ── Projects ─────────────────────────────────
  saveProject, editProject, filterProjectsByStatus,

  // ── Participants ─────────────────────────────
  saveParticipant, loadParticipants, toggleParticipantFields,

  // ── Attendance ───────────────────────────────
  saveAttendance, loadAttendance, loadBulkAttGrid, saveBulkAttendance, markAttendance, markAllAtt, cycleAttStatus, toggleAttFields,

  // ── Hours ────────────────────────────────────
  saveHours, loadHours, toggleHrsFields, onHrsAssignmentChange, onHrsOpportunityChange, primaryApproveHours, finalApproveHours, rejectHours,

  // ── Interest ─────────────────────────────────
  saveInterest, loadInterest,

  // ── Thanks ───────────────────────────────────
  saveThanks, saveBulkThanks, loadThanks,

  // ── Certificates ─────────────────────────────
  issueCert, loadCerts, saveBulkCerts, switchCertTab, previewCertCard, verifyCert,

  // ── Applications ─────────────────────────────
  loadApplications, openApplicationReview, appAccept, appReject, appRequestInterview, appAssignCommittee,

  // ── Opportunities ────────────────────────────
  saveOpportunity, editOpportunity, loadOpportunities, confirmDeleteOpportunity, onOppRolePreset, openOpportunityAssignments, addAssignmentMember, addAssignmentVolunteer, removeAssignment,

  // ── Accounts (users) ─────────────────────────
  saveAccount, editAccount, openAccountModal, openAccountModalForMember, resetAccountPassword, sendPasswordResetEmail, confirmDeleteAccount, generateAccountPw,

  // ── Modal helpers ────────────────────────────
  openModalWithPrj, confirmDelete,
});
