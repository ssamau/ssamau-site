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
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch(err => {
        // Surface to console for debugging but don't break the page.
        // Common failure modes: file:// origin (sw needs http/https),
        // privacy mode, broken sw.js syntax.
        console.warn('[sw] registration failed:', err);
      });
  });
}
