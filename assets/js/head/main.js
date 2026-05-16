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
import { setApiStatus, filterTable } from '../lib/ui.js';
import { showPage, closeSidebar, toggleSidebar, setLoaders, routeFromHash } from './router.js';

import { loadDashboard }       from './tabs/dashboard.js';
import { loadHeadMembers }     from './tabs/members.js';
import {
  loadHeadOpportunities,
  toggleOpportunityCreateForm, createOpportunity,
} from './tabs/opportunities.js';
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

async function logout() {
  if (!confirm(t('common.confirm_logout'))) return;
  try { await signOut(); } catch (err) {
    console.warn('[head] signOut error (ignored):', err);
  }
  window.location.href = 'login.html';
}


// ════════════════════════════════════════════════════════════════════
// ROUTER WIRING
// ════════════════════════════════════════════════════════════════════
const loaderMap = {
  dashboard:     loadDashboard,
  members:       loadHeadMembers,
  opportunities: loadHeadOpportunities,
  hours:         loadHeadHours,
  attendance:    loadHeadAttendance,
  applications:  loadHeadApplications,
  'my-profile':  loadProfile,
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
    case 'logout':                   logout(); break;
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
    // Attendance tab (added 2026-05-16). open/close/save are click
    // handlers; modeChange + attendeeChange are change-event handlers
    // on the radio inputs, handled in the change-listener below.
    case 'hd.attendance.open':       openHeadAttendanceModal(); break;
    case 'hd.attendance.close':      closeHeadAttendanceModal(); break;
    case 'hd.attendance.save':       saveHeadAttendance(); break;
    case 'hd.attendance.edit':       editHeadAttendance(el.dataset.id); break;
    case 'hd.attendance.delete':     deleteHeadAttendance(el.dataset.id); break;
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
