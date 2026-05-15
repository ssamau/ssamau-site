// Head portal router. Mirrors member/router.js — separate module so the
// page set and hash prefix can diverge as the head portal grows.

export const PAGE_TITLES = {
  dashboard:     'لوحتي',
  members:       'أعضاء اللجنة',
  opportunities: 'الفرص التطوعية',
  hours:         'الساعات',
  applications:  'طلبات الانضمام',
};

let _loaders = {};
export function setLoaders(loaders) { _loaders = loaders; }

let _routerNavigating = false;
export function routeFromHash() {
  if (!location.hash.startsWith('#/head/')) return;
  const m = location.hash.match(/^#\/head\/([a-z-]+)$/);
  if (!m) return;
  _routerNavigating = true;
  try { showPage(m[1]); }
  finally { _routerNavigating = false; }
}
window.addEventListener('hashchange', routeFromHash);

export function showPage(page) {
  if (!_routerNavigating) {
    const target = `#/head/${page}`;
    if (location.hash !== target) {
      const method = (location.hash === '' || location.hash === '#') ? 'replaceState' : 'pushState';
      try { history[method](null, '', target); } catch { /* sandboxed iframe etc. */ }
    }
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
  const si = document.querySelector(`.sb-item[data-page="${page}"]`);
  if (si) si.classList.add('active');
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = PAGE_TITLES[page] || page;

  if (_loaders[page]) _loaders[page]();

  closeSidebar();
}

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
