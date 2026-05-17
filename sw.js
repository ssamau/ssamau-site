// SSAM service worker.
//
// Two caching strategies coexist:
//
//   Static assets (HTML / CSS / JS / images / fonts):
//     stale-while-revalidate — serve from cache instantly, fetch a
//     fresh copy in the background and update the cache. Makes the
//     UI feel native: tabs open without a flash, but stale CSS gets
//     refreshed by the next reload.
//
//   API requests (POST to /functions/v1/api or any GET to Supabase
//   subdomains other than the function endpoint):
//     network-only. Admin writes must never read from a cache, and
//     reads (getMembers, etc.) need to reflect what's actually in
//     the DB. The 30–200 ms penalty over a fast connection is
//     invisible.
//
//   /auth/v1/* (Supabase Auth):
//     bypass entirely — don't touch tokens, never cache anything
//     auth-related. Let the network handle it.
//
// Cache versioning: bumping `CACHE_VERSION` invalidates everything.
// Use this when ship-breaking changes go out and you want to flush
// the install base's cached assets. New service worker versions are
// picked up at the next navigation (the browser updates SW silently
// in the background).
//
// Install + activate handlers handle the rollover:
// - install: pre-cache the app shell so the first offline open works
// - activate: delete old cache versions so we don't leak storage
//
// This is intentionally a single-file SW — no Workbox, no build
// step. ~150 lines of plain JS, easier to audit than 50KB of bundled
// library code, and we control every cache hit.

// Final bump (v9) bundles Phase A storage + Phase B events display +
// Phase C typeahead + Phase D advisor-hours into one cache marker.
// Every install rolling forward to this version drops everything
// cached under v6/v7/v8 in one sweep.
const CACHE_VERSION = 'v55-2026-05-17-inactive-login-gate';
const SHELL_CACHE   = `ssam-shell-${CACHE_VERSION}`;
const ASSET_CACHE   = `ssam-assets-${CACHE_VERSION}`;

// ─── App shell — pre-cached at install time ─────────────────────────
// Every HTML page + its required CSS/JS. The shell is what makes the
// app feel instant: an offline open still loads the UI chrome even
// if the network is dead.
const SHELL_URLS = [
  '/',
  '/index.html',
  '/admin.html',
  '/member.html',
  '/head.html',
  '/login.html',
  '/apply.html',
  '/reset-password.html',
  '/signup.html',
  '/verify-cert.html',
  '/manifest.json',
  // CSS
  '/assets/css/base.css',
  '/assets/css/index.css',
  '/assets/css/admin.css',
  '/assets/css/member.css',
  '/assets/css/head.css',
  '/assets/css/login.css',
  '/assets/css/apply.css',
  // JS modules
  '/assets/js/lib/api.js',
  '/assets/js/lib/auth.js',
  '/assets/js/lib/dom.js',
  '/assets/js/lib/i18n.js',
  '/assets/js/lib/strings/ar.js',
  '/assets/js/lib/strings/en.js',
  '/assets/js/login.js',
  '/assets/js/reset-password.js',
  '/assets/js/signup.js',
  '/assets/js/verify-cert.js',
  '/assets/js/admin/main.js',
  '/assets/js/member/main.js',
  '/assets/js/member/router.js',
  '/assets/js/member/dispatch.js',
  '/assets/js/member/tabs/profile.js',
  '/assets/js/member/tabs/hours.js',
  '/assets/js/member/tabs/opportunities.js',
  '/assets/js/member/tabs/assignments.js',
  '/assets/js/head/main.js',
  '/assets/js/head/router.js',
  '/assets/js/head/tabs/dashboard.js',
  '/assets/js/head/tabs/members.js',
  '/assets/js/head/tabs/opportunities.js',
  '/assets/js/head/tabs/hours.js',
  '/assets/js/head/tabs/attendance.js',
  '/assets/js/head/tabs/applications.js',
  '/assets/js/head/tabs/emails.js',
  '/assets/js/head/tabs/certificates.js',
  '/assets/js/head/tabs/other-opportunities.js',
  // Icons
  '/assets/img/logo-200.png',
  '/assets/img/icon-192.png',
  '/assets/img/icon-512.png',
  '/assets/img/apple-touch-icon.png',
];

// ─── Install: pre-fetch the shell ───────────────────────────────────
self.addEventListener('install', (event) => {
  // skipWaiting so the new SW activates immediately on next navigation
  // — without it, the user has to close every tab open to the site
  // before updates take effect.
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_URLS))
      // Don't fail the install if one shell asset is missing — log
      // and continue. A 404 on /index.html shouldn't brick the SW.
      .catch(err => console.warn('[sw] shell pre-cache partial:', err))
  );
});

// ─── Activate: claim clients + drop old caches ──────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k !== SHELL_CACHE && k !== ASSET_CACHE && k.startsWith('ssam-'))
        .map(k => caches.delete(k))
    );
    // clients.claim() makes the SW the controller of every open
    // page immediately, not just newly-opened ones. Pairs with
    // skipWaiting above for instant rollouts.
    await self.clients.claim();
  })());
});

// ─── Fetch routing ───────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Non-GET requests are never cached. POST/PUT/DELETE always hit the
  // network — the addAll cache trick only works for GETs anyway.
  if (req.method !== 'GET') return;

  // Bypass for Supabase Auth — never touch tokens/refresh/sign-in.
  if (url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/auth/')) return;

  // Network-only for the Edge Function (action dispatcher). The
  // frontend POSTs there, so this branch is mostly defensive — but
  // covers cases like opening the URL directly in DevTools to debug.
  if (url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/functions/')) return;

  // Network-only for Google Tag Manager beacon — analytics shouldn't
  // be cached and replayed on the next page load.
  if (url.hostname === 'www.googletagmanager.com' || url.hostname === 'www.google-analytics.com') return;

  // Everything else (HTML, CSS, JS, images, fonts) — stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(req));
});

// ─── Stale-while-revalidate implementation ──────────────────────────
async function staleWhileRevalidate(req) {
  const cache  = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);

  // Kick off the revalidation regardless of cache hit/miss.
  const networkPromise = fetch(req)
    .then(resp => {
      // Only cache valid responses; opaque + redirect responses are
      // intentionally not cached (they have no body we can inspect).
      if (resp && resp.ok && resp.type === 'basic') {
        cache.put(req, resp.clone()).catch(() => {});
      }
      return resp;
    })
    .catch(() => null);

  // If we have a cached copy, return it immediately + let the network
  // promise update the cache in the background. If no cache, await
  // the network (which is the user's first-ever load of this URL).
  return cached || (await networkPromise) || new Response('offline', {
    status: 503,
    statusText: 'Offline and not cached',
  });
}
