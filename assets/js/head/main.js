// Heads' portal — entry module.
//
// Five tabs now (dashboard + members/opps/hours/applications), all
// scoped to the head's committee server-side. Mirrors member/main.js
// structure: tiny auth guard, router-driven page switching, slim
// delegated-event router for data-action buttons.

import { applyStoredTheme, getTheme, setTheme } from '../lib/theme.js';
applyStoredTheme();

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
  loadHeadApplications, acceptApplication, rejectApplication,
} from './tabs/applications.js';


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
  if (!confirm('هل تريد تسجيل الخروج؟')) return;
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
  applications:  loadHeadApplications,
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
    case 'hd.apps.reject':           rejectApplication(el.dataset.id); break;
    case 'hd.opps.toggleCreate':     toggleOpportunityCreateForm(); break;
    case 'hd.opps.create':           createOpportunity(); break;
  }
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-action="filterTable"][data-event="input"]');
  if (!el) return;
  filterTable(el.dataset.target, el.value);
});


// ════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════
function _initHead() {
  setApiStatus('ok', 'متصل');
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
