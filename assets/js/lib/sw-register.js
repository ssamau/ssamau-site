// Service worker registration.
//
// Imported as a module by every page's <script type="module">.
// Registers /sw.js once per origin and never blocks page rendering.
// If the browser doesn't support service workers (Safari pre-2018 or
// Firefox in private mode), the registration silently no-ops.
//
// We deliberately do NOT prompt the user to "Add to Home Screen" —
// Chrome shows its own install prompt when the manifest + SW criteria
// are met (basically: PWA installable). Forcing a banner ourselves
// would be more annoying than helpful.

if ('serviceWorker' in navigator) {
  // Defer until the page is fully loaded so registration doesn't
  // contend with critical path resources.
  window.addEventListener('load', () => {
    // `updateViaCache: 'none'` tells the browser to bypass the HTTP
    // cache when fetching sw.js itself. Without this, the SW script
    // could be served from a stale browser cache for up to 24h, which
    // is what caused the 2026-05-17 "support button doesn't work"
    // report: a v57 deploy didn't propagate to clients whose browser
    // had cached the v56 sw.js. Forcing a fresh fetch means each page
    // load picks up SW changes within a single roundtrip.
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(reg => {
        // Also actively poll for updates on every visibility change.
        // Helps users who keep a tab open for hours — without this,
        // the SW only re-checks on navigation. A `visibilitychange`
        // hook means coming back to the tab triggers a fresh update
        // check immediately.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            reg.update().catch(() => { /* network blip is fine */ });
          }
        });
      })
      .catch(err => {
        // Surface to console for debugging but don't break the page.
        // Common failure modes: file:// origin (sw needs http/https),
        // privacy mode, broken sw.js syntax.
        console.warn('[sw] registration failed:', err);
      });
  });
}
