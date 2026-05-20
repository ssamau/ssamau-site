// Heads' portal — entry module.
//
// Five tabs now (dashboard + members/opps/hours/applications), all
// scoped to the head's committee server-side. Mirrors member/main.js
// structure: tiny auth guard, router-driven page switching, slim
// delegated-event router for data-action buttons.

import { applyStoredTheme, getTheme, setTheme } from '../lib/theme.js';
applyStoredTheme();

// i18n: side-effect import sets <html dir/lang> + applies data-i18n
// to sidebar + topbar markup on first load. We also re-fire the active
// tab's loader on language change so JS-generated rows pick up new copy.
import { t, getLang, setLang, onLangChange } from '../lib/i18n.js';

import {
  getSession, clearSession, isLoggedIn, signOut,
} from '../lib/auth.js';
// Permission revalidation — same module the admin/member portals use.
// Detects server-side access_level or status changes without a re-login.
import { startPermissionWatcher } from '../lib/permission-watcher.js';
import { setApiStatus, filterTable, closeModal, openModal } from '../lib/ui.js';
import { showPage, closeSidebar, toggleSidebar, setLoaders, routeFromHash } from './router.js';

import { loadDashboard }       from './tabs/dashboard.js';
import {
  loadHeadMembers,
  openHeadMemberFile, openHeadMemberProfile,
  openHeadInviteModal, headSendInviteByEmail, headSendInviteByPin,
  headCopyShownPin, headConfirmRevokeInvite,
  filterHeadMembersByRole, filterHeadMembersByStatus, filterHeadMembersBySearch,
} from './tabs/members.js';
import {
  loadHeadOpportunities,
  toggleOpportunityCreateForm, createOpportunity,
  openOpportunityEdit, markOpportunityDone,
  openHeadOpportunityAssignments,
  addHeadAssignmentMember, addHeadAssignmentVolunteer,
  markHeadAssignmentAttendance, removeHeadAssignment,
} from './tabs/opportunities.js';
import {
  loadHeadProjects, openHeadProjectCreate, editHeadProject,
  saveHeadProject, confirmDeleteHeadProject,
} from './tabs/projects.js';
import {
  loadHeadOtherOpportunities,
  openHeadOtherPickRole, closeHeadOtherPickRole, submitHeadOtherPickRole,
  withdrawOtherInterest,
} from './tabs/other-opportunities.js';
// Shared support-ticket module — available across every portal so a
// member, head, or admin can fire a bug report from anywhere.
import {
  openSupportModal, submitSupportTicket, onSupportFileChange,
} from '../lib/support.js';
import {
  loadHeadHours, primaryApproveHours, finalApproveHours, rejectHours,
} from './tabs/hours.js';
import {
  loadHeadApplications, acceptApplication, rejectApplication, requestInterview,
} from './tabs/applications.js';
import {
  loadHeadAttendance, openHeadAttendanceModal, closeHeadAttendanceModal,
  saveHeadAttendance, onHeadAttModeChange, onHeadAttAttendeeChange,
  editHeadAttendance, deleteHeadAttendance,
} from './tabs/attendance.js';
import {
  loadHeadEmails, sendHeadThanks, bulkSendHeadThanks, filterHeadThanks,
  onHeadEmailsModalOpen,
} from './tabs/emails.js';
import {
  loadHeadCertificates, switchHeadCertTab, filterHeadCerts,
  issueHeadCert, bulkIssueHeadCerts, verifyHeadCert, previewHeadCertCard,
} from './tabs/certificates.js';
// Reuse the member-portal self-edit profile module — same form, same
// uploaders, same backend endpoints. The "my-profile" tab on head.html
// has matching element ids so this module works as-is.
import {
  loadProfile, saveProfile,
  onUploaderChange, submitUploader, deleteUploader,
} from '../member/tabs/profile.js';


// ════════════════════════════════════════════════════════════════════
// AUTH GUARD — head + superadmin allowed; others bounced to their portal.
// ════════════════════════════════════════════════════════════════════
function _requireHeadAuthOrRedirect() {
  const user = getSession();
  if (!user || !isLoggedIn()) {
    clearSession();
    window.location.replace('login.html');
    return false;
  }
  if (user.access === 'member' || user.access === 'volunteer') {
    window.location.replace('member.html');
    return false;
  }
  if (user.access === 'admin') {
    window.location.replace('admin.html');
    return false;
  }
  window.CURRENT_USER = user;
  return true;
}
_requireHeadAuthOrRedirect();
window.addEventListener('pageshow', _requireHeadAuthOrRedirect);
// Start the permission watcher — same hooks as admin/member.
startPermissionWatcher();

async function logout() {
  if (!confirm(t('common.confirm_logout'))) return;
  try { await signOut(); } catch (err) {
    console.warn('[head] signOut error (ignored):', err);
  }
  window.location.href = 'login.html';
}

// Direct binding so signout works the moment the button exists,
// independent of when the data-action dispatcher comes up. See the
// admin/main.js note for the regression this prevents.
document.getElementById('topbar-logout')?.addEventListener('click', logout);


// ════════════════════════════════════════════════════════════════════
// ROUTER WIRING
// ════════════════════════════════════════════════════════════════════
const loaderMap = {
  dashboard:           loadDashboard,
  members:             loadHeadMembers,
  projects:            loadHeadProjects,
  opportunities:       loadHeadOpportunities,
  'other-opportunities': loadHeadOtherOpportunities,
  hours:               loadHeadHours,
  attendance:          loadHeadAttendance,
  applications:        loadHeadApplications,
  emails:              loadHeadEmails,
  certificates:        loadHeadCertificates,
  'my-profile':        loadProfile,
};
setLoaders(loaderMap);


// ════════════════════════════════════════════════════════════════════
// SIDEBAR + TOPBAR
// ════════════════════════════════════════════════════════════════════
document.getElementById('sb-toggle')   ?.addEventListener('click', toggleSidebar);
document.getElementById('sb-backdrop') ?.addEventListener('click', closeSidebar);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSidebar();
});

function _syncThemeButtons() {
  const current = getTheme();
  document.querySelectorAll('.sb-theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === current);
  });
}
window.addEventListener('ssam-theme-changed', _syncThemeButtons);
_syncThemeButtons();

// ── Language toggle wiring ──────────────────────────────────────────
// Same pattern as member/main.js: clicking a pill flips the lang and
// re-fires the active loader so dynamic rows re-render in the new
// language. Static markup is handled automatically by applyI18n()
// inside lib/i18n.js on the ssam-lang-changed event.
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
  const active = document.querySelector('.page.active');
  if (!active) return;
  const page = active.id.replace('page-', '');
  const loader = loaderMap[page];
  if (loader) loader();
});
_syncLangButtons();


// ════════════════════════════════════════════════════════════════════
// SIDEBAR USER STAMP
// ════════════════════════════════════════════════════════════════════
if (window.CURRENT_USER) {
  const u = window.CURRENT_USER;
  const nm = document.getElementById('sb-name');
  const av = document.getElementById('sb-av');
  const displayName = u.name || u.username || '—';
  if (nm) nm.textContent = displayName;
  if (av) av.textContent = (displayName.charAt(0) || '?');
}


// ════════════════════════════════════════════════════════════════════
// DELEGATED EVENT HANDLERS
// ════════════════════════════════════════════════════════════════════
// One delegated listener per event type — covers click for action
// buttons and input for the live-filter on the members search box.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    // 'logout' moved to a direct addEventListener on #topbar-logout;
    // see the head/main.js top-of-file binding for the rationale.
    case 'setTheme':                 setTheme(el.dataset.value); break;
    case 'showPage':                 showPage(el.dataset.page); break;
    case 'hd.hours.primaryApprove':  primaryApproveHours(el.dataset.id); break;
    case 'hd.hours.finalApprove':    finalApproveHours(el.dataset.id); break;
    case 'hd.hours.reject':          rejectHours(el.dataset.id); break;
    case 'hd.apps.accept':           acceptApplication(el.dataset.id); break;
    case 'hd.apps.requestInterview': requestInterview(el.dataset.id); break;
    case 'hd.apps.reject':           rejectApplication(el.dataset.id); break;
    case 'hd.opps.toggleCreate':     toggleOpportunityCreateForm(); break;
    case 'hd.opps.create':           createOpportunity(); break;
    // Edit a head's own opportunity (✏️ row button) — pre-fills the
    // inline form. Mark Done (✅ row button) flips status='Done' via
    // opportunities.update. Both gated by requireAdminScope server-side.
    case 'hd.opps.edit.open':        openOpportunityEdit(el.dataset.id); break;
    case 'hd.opps.markDone':         markOpportunityDone(el.dataset.id); break;
    // Opportunity assign modal — open from the 👥 row button, then
    // add member / add volunteer / remove. markAttendance is dispatched
    // from the change-event handler below (it's on a <select>).
    case 'hd.opps.assign.open':         openHeadOpportunityAssignments(el.dataset.id); break;
    case 'hd.opps.assign.addMember':    addHeadAssignmentMember(); break;
    case 'hd.opps.assign.addVolunteer': addHeadAssignmentVolunteer(); break;
    case 'hd.opps.assign.remove':       removeHeadAssignment(el.dataset.id); break;
    // Other-committee opportunities tab — head behaves as a volunteer
    // for events outside their own committee. Express/withdraw maps to
    // the same interest.submit endpoint members use; the server now
    // takes user.member_id from auth context so no spoofing path.
    // Multi-role (2026-05-18): "express" now opens a role-picker modal.
    // The submit branch fires interest.submit with the chosen role_id.
    case 'hd.other.openPick':           openHeadOtherPickRole(el); break;
    case 'hd.other.closePick':          closeHeadOtherPickRole(); break;
    case 'hd.other.submitPick':         submitHeadOtherPickRole(); break;
    case 'hd.other.withdraw':           withdrawOtherInterest(el); break;
    // Projects tab (2026-05-18). Heads add/edit projects scoped to
    // their committee. requireAdminScope on the server enforces the
    // committee match — admins can still edit head-created rows.
    case 'hd.projects.openCreate':      openHeadProjectCreate(); break;
    case 'hd.projects.edit':            editHeadProject(el.dataset.id); break;
    case 'hd.projects.save':            saveHeadProject(); break;
    case 'hd.projects.confirmDelete':   confirmDeleteHeadProject(el.dataset.id, el.dataset.name); break;
    // Support / bug-report — sidebar entry + modal submit.
    case 'openSupportModal':            openSupportModal(); break;
    case 'submitSupportTicket':         submitSupportTicket(); break;
    // Attendance tab (added 2026-05-16). open/close/save are click
    // handlers; modeChange + attendeeChange are change-event handlers
    // on the radio inputs, handled in the change-listener below.
    case 'hd.attendance.open':       openHeadAttendanceModal(); break;
    case 'hd.attendance.close':      closeHeadAttendanceModal(); break;
    case 'hd.attendance.save':       saveHeadAttendance(); break;
    case 'hd.attendance.edit':       editHeadAttendance(el.dataset.id); break;
    case 'hd.attendance.delete':     deleteHeadAttendance(el.dataset.id); break;
    // Members tab — view profile, view uploaded file, invite portal
    // account, revoke pending invite. Mirrors admin's affordances.
    case 'hd.members.viewProfile':   openHeadMemberProfile(el.dataset.id); break;
    case 'hd.members.openFile':      openHeadMemberFile(el.dataset.id, el.dataset.kind); break;
    case 'hd.members.invite.open':   openHeadInviteModal(el.dataset.id); break;
    case 'hd.members.invite.revoke': headConfirmRevokeInvite(el.dataset.id, el.dataset.name); break;
    // President's QOL filters 2026-05-18.
    case 'hd.members.filterRole':    filterHeadMembersByRole(el.value); break;
    case 'hd.members.filterStatus':  filterHeadMembersByStatus(el.value); break;
    case 'hd.members.filterSearch':  filterHeadMembersBySearch(el.value); break;
    // Invite modal — three buttons inside the modal body. Use direct
    // ids on the shared admin-style markup so we don't need to fork it.
    case 'sendInviteByEmail':        headSendInviteByEmail(); break;
    case 'sendInviteByPin':          headSendInviteByPin(); break;
    case 'copyShownPin':             headCopyShownPin(); break;
    // Generic close-modal — the invite + profile modals dispatch this.
    case 'closeModal':               closeModal(el.dataset.modal); break;
    // Emails / thanks tab — single + bulk.
    case 'hd.thanks.send':           sendHeadThanks(); break;
    case 'hd.thanks.bulkSend':       bulkSendHeadThanks(); break;
    // Certificates tab — sub-tab switch, issue, bulk, verify, preview.
    case 'hd.certs.switchTab':       switchHeadCertTab(el.dataset.tab); break;
    case 'hd.certs.issue':           issueHeadCert(); break;
    case 'hd.certs.bulkIssue':       bulkIssueHeadCerts(); break;
    case 'hd.certs.verify':          verifyHeadCert(); break;
    case 'hd.certs.preview': {
      // The cert row payload is serialized into data-card as JSON so we
      // don't have to re-fetch by id. Decode + hand to the popup builder.
      let card; try { card = JSON.parse(el.dataset.card.replace(/&quot;/g, '"')); } catch { return; }
      previewHeadCertCard(card);
      break;
    }
    // Generic openModal — reuses lib/ui.js so the head bundle doesn't
    // need its own ov-* dictionary. The pre-populator hook for the
    // emails modal fires onHeadEmailsModalOpen below.
    case 'openModal':
      openModal(el.dataset.modal);
      if (el.dataset.modal === 'hd-thanks' || el.dataset.modal === 'hd-bulk-thanks') {
        onHeadEmailsModalOpen();
      }
      break;
    case 'profile.save':             saveProfile(); break;
    // onUploaderChange is a CHANGE event on a file <input>, handled in
    // the separate change listener below — not here.
    case 'submitUploader':           submitUploader(el); break;
    case 'deleteUploader':           deleteUploader(el); break;
  }
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-action="filterTable"][data-event="input"]');
  if (!el) return;
  filterTable(el.dataset.target, el.value);
});

// File-input change events for the profile uploader widgets.
// The input declares `data-event="change"` so the click-only path
// above wouldn't pick it up.
document.addEventListener('change', (e) => {
  const upl = e.target.closest('[data-action="onUploaderChange"][data-event="change"]');
  if (upl) { onUploaderChange(upl); return; }
  // Support modal file picker — same change-event pattern.
  const sup = e.target.closest('[data-action="onSupportFileChange"][data-event="change"]');
  if (sup) { onSupportFileChange(sup); return; }
  // Filter-select change events for the emails + certs project filters.
  // Change-driven so we don't refetch on every keystroke; the search
  // boxes use the `input` handler above.
  const thxFlt = e.target.closest('[data-action="hd.thanks.filter"]');
  if (thxFlt) { filterHeadThanks(); return; }
  const certFlt = e.target.closest('[data-action="hd.certs.filter"]');
  if (certFlt) { filterHeadCerts(); return; }
  // Attendance-status dropdown inside the assign modal — change-event
  // because <select> doesn't bubble click for value-changes.
  const attMark = e.target.closest('[data-action="hd.opps.assign.markAttendance"]');
  if (attMark) { markHeadAssignmentAttendance(attMark.dataset.id, attMark.value); return; }
  // Attendance tab radios — mode (project vs meeting) + attendee type
  // (member vs volunteer) flip which sub-section of the form is visible.
  const att = e.target.closest('[data-action="hd.attendance.modeChange"], [data-action="hd.attendance.attendeeChange"]');
  if (att) {
    const a = att.dataset.action;
    if (a === 'hd.attendance.modeChange')     onHeadAttModeChange();
    else if (a === 'hd.attendance.attendeeChange') onHeadAttAttendeeChange();
  }
});


// ════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════
function _initHead() {
  setApiStatus('ok', t('common.connected'));
  // Respect the URL hash so refresh / shared link lands on the
  // intended tab. Default to dashboard otherwise.
  const m = location.hash.match(/^#\/head\/([a-z-]+)$/);
  const initial = m && loaderMap[m[1]] ? m[1] : 'dashboard';
  showPage(initial);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initHead);
} else {
  _initHead();
}
