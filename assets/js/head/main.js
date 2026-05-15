// Heads' portal — entry module.
//
// Single-tab MVP: lands on the dashboard, renders KPIs + pending queue.
// Management actions deep-link out to admin.html (which heads can use
// freely — see admin/main.js auth guard).
//
// Mirrors member/main.js structure where it makes sense, but skips the
// router/dispatch modules — only one page, only a handful of
// data-action handlers, all wired inline below.

import { applyStoredTheme, getTheme, setTheme } from '../lib/theme.js';
applyStoredTheme();

import {
  getSession, clearSession, isLoggedIn, signOut, landingPageForAccess,
} from '../lib/auth.js';
import { setApiStatus } from '../lib/ui.js';
import { loadDashboard } from './tabs/dashboard.js';


// ════════════════════════════════════════════════════════════════════
// AUTH GUARD
// ════════════════════════════════════════════════════════════════════
// Heads (and superadmin for preview) only. Member/volunteer go to
// member.html; admin tier goes to admin.html. Same `pageshow` listener
// as member/main.js so bfcache restore after logout doesn't show a
// ghost of the portal.

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
    // Admin tier → bounce to admin.html. Superadmin allowed for testing
    // (their landingPageForAccess is 'admin.html', but we let them
    // preview head.html if they navigate here manually).
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
// SIDEBAR + TOPBAR
// ════════════════════════════════════════════════════════════════════

function openSidebar() {
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('sb-backdrop')?.classList.add('open');
  document.getElementById('sb-toggle')?.setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sb-backdrop')?.classList.remove('open');
  document.getElementById('sb-toggle')?.setAttribute('aria-expanded', 'false');
}
function toggleSidebar() {
  const open = document.getElementById('sidebar')?.classList.contains('open');
  if (open) closeSidebar(); else openSidebar();
}

document.getElementById('sb-toggle')   ?.addEventListener('click', toggleSidebar);
document.getElementById('sb-backdrop') ?.addEventListener('click', closeSidebar);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSidebar();
});

// Theme button active-state sync (mirrors admin + member portal).
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
// One small delegated click listener instead of the full dispatch
// module — the head portal only has a handful of data-action targets
// (logout, theme buttons, the placeholder showPage). If this grows,
// graduate to a proper dispatch module like member/dispatch.js.

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    case 'logout':   logout(); break;
    case 'setTheme': setTheme(el.dataset.value); break;
    case 'showPage':
      // Single-tab MVP — only 'dashboard' exists, so just refresh it
      // and close the mobile drawer.
      loadDashboard();
      closeSidebar();
      break;
  }
});


// ════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════
function _initHead() {
  setApiStatus('ok', 'متصل');
  loadDashboard();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initHead);
} else {
  _initHead();
}
