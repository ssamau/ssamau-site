// Tab router. Owns the title map, the page → loader dispatch table, the
// hash-based SPA routing, and the sidebar-state hygiene that runs on every
// navigation. admin.html still uses inline onclick="showPage('x')" calls
// (until commit 5 in this branch replaces them with data-action
// delegation) — those work alongside hash routing because showPage()
// itself updates the URL via history.pushState.
//
// Loaders are injected by main.js via setLoaders() rather than imported here
// directly — otherwise this module would have to import every tab, and every
// tab already imports `showPage` from here. That's a textbook cycle. The
// indirection keeps router.js a leaf.

import { toast } from '../lib/ui.js';
import { RBAC } from '../lib/rbac.js';
import { t } from '../lib/i18n.js';

// PAGE_TITLES stores i18n keys (not literal strings). showPage()
// resolves the current language at navigation time, and onLangChange
// in main.js re-fires the active loader so the title flips with the
// rest of the chrome.
export const PAGE_TITLES = {
  dashboard:       'ap.title.dashboard',
  members:         'ap.title.members',
  advisors:        'ap.title.advisors',
  committees:      'ap.title.committees',
  projects:        'ap.title.projects',
  participants:    'ap.title.participants',
  attendance:      'ap.title.attendance',
  hours:           'ap.title.hours',
  profile:         'ap.title.profile',
  'project-detail':'ap.title.project_detail',
  interest:        'ap.title.interest',
  emails:          'ap.title.emails',
  certificates:    'ap.title.certificates',
  opportunities:   'ap.title.opportunities',
  applications:    'ap.title.applications',
  accounts:        'ap.title.accounts',
  'my-profile':    'ap.title.my_profile',
};

// Loader dispatch — filled in by main.js after every tab module has been
// imported. Until then showPage() falls back to a no-op for unknown pages,
// which matches the old behaviour for 'project-detail' (it had `() => {}`
// in the original loaders map).
let _loaders = {};
export function setLoaders(loaders) { _loaders = loaders; }

// ── Hash router ─────────────────────────────────────────────────────
// URL → page mapping for the admin panel:
//   #/admin/dashboard   → dashboard tab
//   #/admin/members     → members tab
//   ...one per tab in PAGE_TITLES.
//
// Two-way sync:
//   - clicking a sidebar item calls showPage('<tab>') (existing
//     onclick="showPage(...)"), which then pushes the corresponding
//     hash via history.pushState so back/forward works and the URL is
//     bookmarkable / shareable.
//   - changing the URL hash (typed, bookmark, browser back/forward)
//     fires `hashchange`, which calls routeFromHash() → showPage().
//
// The `_routerNavigating` flag prevents an infinite loop: when a
// hashchange-triggered showPage runs, we don't want it to push
// another history entry.
//
// project-detail is special-cased — it's a sub-route reached only by
// clicking a project row, has no top-level URL fragment, and we
// don't want to overwrite the parent (projects) hash when it opens.
let _routerNavigating = false;
export function routeFromHash() {
  if (!location.hash.startsWith('#/admin/')) return;
  const m = location.hash.match(/^#\/admin\/([a-z-]+)$/);
  if (!m) return;
  _routerNavigating = true;
  try { showPage(m[1]); }
  finally { _routerNavigating = false; }
}
window.addEventListener('hashchange', routeFromHash);

export function showPage(page) {
  // Sync the URL hash with the active page so refreshes land on the
  // right tab and Back/Forward navigates between tabs naturally.
  // pushState updates the URL bar WITHOUT firing hashchange (which
  // is what we want — we already rendered, no need to re-render).
  // The hashchange listener above still picks up user-initiated URL
  // changes (typing, bookmarks, browser Back).
  if (!_routerNavigating && page !== 'project-detail') {
    const target = `#/admin/${page}`;
    if (location.hash !== target) {
      // replaceState on the very first navigation (so we don't
      // create a back-button entry to the empty initial state);
      // pushState afterwards so each tab switch is a back-able step.
      const method = (location.hash === '' || location.hash === '#') ? 'replaceState' : 'pushState';
      try { history[method](null, '', target); } catch { /* sandboxed iframe etc. */ }
    }
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
  const si = document.querySelector(`[data-page="${page}"]`);
  if (si) si.classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[page] ? t(PAGE_TITLES[page]) : page;

  // Load data on navigation
  // تحقق من صلاحية الصفحة
  if (!RBAC.canSeePage(page)) {
    toast(t('ap.access_denied'), 'twarn');
    return;
  }

  if (_loaders[page]) _loaders[page]();

  // Mobile: auto-close the sidebar after a navigation so the user isn't
  // looking at the menu they just tapped. No-op on desktop (toggle hidden).
  closeSidebar();
}

// ── Mobile sidebar toggle ──────────────────────────────────────────────────
// Desktop (>900px width) keeps the sidebar permanently visible via CSS — these
// helpers only do anything on small screens, where .sidebar.open + .sb-backdrop.open
// slide it in over a dim backdrop.
export function openSidebar() {
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('sb-backdrop')?.classList.add('open');
  document.getElementById('sb-toggle')?.setAttribute('aria-expanded', 'true');
}
export function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sb-backdrop')?.classList.remove('open');
  document.getElementById('sb-toggle')?.setAttribute('aria-expanded', 'false');
}
export function toggleSidebar() {
  const open = document.getElementById('sidebar')?.classList.contains('open');
  if (open) closeSidebar(); else openSidebar();
}
