// Member portal router. Mirrors the admin router (assets/js/admin/router.js)
// but with a different page set and the `#/member/...` URL prefix instead
// of `#/admin/...`. Two reasons for a separate module instead of importing
// the admin one:
//   1. The page titles + valid page names are different.
//   2. The hash-prefix pattern is a wholly different regex.
// Keeping them as parallel files is cheaper than threading parameters
// through every export.
//
// Loaders are injected by main.js via setLoaders() — see comment in the
// admin router for why (cycle avoidance).

export const PAGE_TITLES = {
  profile:       'ملفي الشخصي',
  hours:         'ساعاتي التطوعية',
  opportunities: 'الفرص التطوعية',
  assignments:   'مهامي',
};

// Loader dispatch — filled in by main.js after every tab module has been
// imported. Until then showPage() falls back to a no-op for unknown pages.
let _loaders = {};
export function setLoaders(loaders) { _loaders = loaders; }

// ── Hash router ─────────────────────────────────────────────────────
// URL → page mapping:
//   #/member/profile        → profile tab
//   #/member/hours          → hours tab
//   #/member/opportunities  → opportunities tab
//   #/member/assignments    → assignments tab
//
// Two-way sync:
//   - clicking a sidebar item (data-action="showPage" data-page="x")
//     dispatches showPage('x') via the delegated handler; showPage
//     then pushes the matching hash so back/forward + bookmarks work.
//   - changing the URL hash fires `hashchange`, which calls
//     routeFromHash() → showPage().
//
// The `_routerNavigating` flag prevents an infinite loop when
// hashchange-triggered navigation runs (we don't push a second
// history entry on the same nav).
let _routerNavigating = false;
export function routeFromHash() {
  if (!location.hash.startsWith('#/member/')) return;
  const m = location.hash.match(/^#\/member\/([a-z-]+)$/);
  if (!m) return;
  _routerNavigating = true;
  try { showPage(m[1]); }
  finally { _routerNavigating = false; }
}
window.addEventListener('hashchange', routeFromHash);

export function showPage(page) {
  // Sync URL hash so refresh/back/forward/bookmarks land on the right tab.
  // pushState updates the URL bar WITHOUT firing hashchange — we already
  // rendered, no need to re-render. The hashchange listener above still
  // picks up user-initiated URL changes (typing, bookmarks, Back).
  if (!_routerNavigating) {
    const target = `#/member/${page}`;
    if (location.hash !== target) {
      // replaceState on the very first navigation (no back-button trap to
      // an empty initial state); pushState afterwards so each tab switch
      // is a back-able step.
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
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = PAGE_TITLES[page] || page;

  if (_loaders[page]) _loaders[page]();

  // Mobile: auto-close the sidebar after a navigation so the user isn't
  // looking at the menu they just tapped. No-op on desktop.
  closeSidebar();
}

// ── Mobile sidebar toggle ──────────────────────────────────────────────────
// Desktop (>900px) keeps the sidebar permanently visible via CSS — these
// helpers only do anything on small screens.
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
