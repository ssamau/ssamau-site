// Three-way theme toggle: auto / light / dark.
//
// Storage: localStorage key `ssam_theme` holds the user's choice.
// Missing key (or "auto") falls back to OS preference via the CSS
// `@media (prefers-color-scheme: dark)` rule in base.css. Explicit
// "light" or "dark" override OS preference unconditionally.
//
// The mechanism is just: set `<html data-theme="X">`. CSS rules in
// base.css use selectors like `:root[data-theme="dark"]` and
// `:root:not([data-theme="light"]):not([data-theme="dark"])` to
// pick the right token set for each case.
//
// Why a tiny module and not just inline JS in main.js: every HTML
// entry point (admin / login / apply / reset-password / index)
// needs to apply the saved theme on first paint to avoid a flash
// of wrong colors. Importing one module from each keeps the
// behaviour consistent.

const KEY = 'ssam_theme';
const VALID = new Set(['auto', 'light', 'dark']);

export function getTheme() {
  const v = localStorage.getItem(KEY);
  return VALID.has(v) ? v : 'auto';
}

export function setTheme(value) {
  if (!VALID.has(value)) value = 'auto';
  // For "auto" we REMOVE the data-theme attribute — CSS rules use
  // `:not([data-theme="light"]):not([data-theme="dark"])` to detect
  // the auto case, so an explicit `data-theme="auto"` would silently
  // do the right thing too but the absence is cleaner.
  if (value === 'auto') {
    localStorage.removeItem(KEY);
    document.documentElement.removeAttribute('data-theme');
  } else {
    localStorage.setItem(KEY, value);
    document.documentElement.setAttribute('data-theme', value);
  }
  // Re-broadcast so listeners (UI controls displaying the current
  // selection) can update without polling.
  window.dispatchEvent(new CustomEvent('ssam-theme-changed', { detail: { value } }));
}

// Call this synchronously at the very top of every page's main script
// (before the first paint) to avoid a flash of wrong colors when the
// user prefers light but the OS is dark or vice-versa.
export function applyStoredTheme() {
  const v = getTheme();
  if (v === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', v);
  }
}

// Convenience: get the EFFECTIVE theme (light or dark) right now,
// resolving "auto" to whatever the OS currently says. Useful for
// JS that needs to know the actual rendered theme (e.g. choosing
// chart colors at runtime).
export function getEffectiveTheme() {
  const v = getTheme();
  if (v !== 'auto') return v;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
