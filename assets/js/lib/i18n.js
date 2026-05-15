// SSAM i18n — tiny key-based translation helper.
//
// Why this exists: the homepage's data-ar / data-en element-swap pattern
// duplicates every string in the DOM, doesn't cover JS-generated content,
// and gets unmaintained quickly. The admin / head / member portals are
// growing too large for that to scale. This module gives every page a
// single way to:
//
//   - Look up a string by key:  t('login.submit') → 'تسجيل الدخول' / 'Sign In'
//   - Pick up the current lang: getLang() → 'ar' | 'en'
//   - Switch language:          setLang('en') — persists + flips <html dir/lang>
//                                              + broadcasts a 'ssam-lang-changed'
//                                              event for listeners that re-render.
//   - Auto-translate DOM marked-up with data-i18n / data-i18n-* attributes via
//     applyI18n(root). Idempotent — safe to call repeatedly.
//
// HTML pattern:
//   <button data-i18n="login.submit">تسجيل الدخول</button>
//   <input  data-i18n-placeholder="login.identifier_placeholder" placeholder="..."/>
//   <a      data-i18n-title="logout.title" title="...">🚪</a>
//
// The initial HTML keeps the Arabic copy so the page is readable before
// JS runs (and survives a CSP/JS failure). applyI18n() overwrites with
// the catalog value matching the chosen language.
//
// Catalogs live in assets/js/lib/strings/{ar,en}.js. Each exports `default`
// as a flat object — `{ 'login.submit': '...', 'login.identifier': '...' }`.
// Flat keys keep the lookup branchless and grep-able; the dotted segments
// are pure naming convention.

import AR from './strings/ar.js';
import EN from './strings/en.js';

const STORAGE_KEY = 'ssam_lang';
const CATALOGS = { ar: AR, en: EN };
const DEFAULT_LANG = 'ar';
const EVENT_NAME = 'ssam-lang-changed';

// ─── State ──────────────────────────────────────────────────────────
function _readSaved() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function _writeSaved(lang) {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* private mode */ }
}

let _lang = _detectInitial();

function _detectInitial() {
  const saved = _readSaved();
  if (saved === 'ar' || saved === 'en') return saved;
  // No saved preference — honour browser language hint for first-timers.
  // navigator.language can be 'ar', 'ar-SA', 'en', 'en-AU' etc.
  const nav = (navigator.language || '').toLowerCase();
  if (nav.startsWith('en')) return 'en';
  return DEFAULT_LANG;
}

// ─── Read API ───────────────────────────────────────────────────────

// `params` interpolates {placeholder} segments in the resolved string.
// `t('greeting', { name: 'Faisal' })` against 'مرحباً، {name}' returns
// 'مرحباً، فيصل'. Missing keys fall back to the key itself so a typo
// is visible in the rendered UI rather than silently blank.
export function t(key, params) {
  const value = CATALOGS[_lang]?.[key]
             ?? CATALOGS[DEFAULT_LANG]?.[key]
             ?? key;
  if (!params) return value;
  return String(value).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '');
}

export function getLang() { return _lang; }

// ─── Write API ──────────────────────────────────────────────────────

export function setLang(lang) {
  if (lang !== 'ar' && lang !== 'en') return;
  if (lang === _lang) return;
  _lang = lang;
  _writeSaved(lang);
  _applyDocAttrs();
  applyI18n();
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { lang } }));
}

export function toggleLang() { setLang(_lang === 'ar' ? 'en' : 'ar'); }

// ─── DOM application ────────────────────────────────────────────────
// Three attribute conventions:
//   data-i18n               → element.textContent  = t(value)
//   data-i18n-placeholder   → element.placeholder = t(value)
//   data-i18n-title         → element.title       = t(value)
//   data-i18n-aria-label    → element.setAttribute('aria-label', t(value))
//
// Add more attribute hooks here only if the page actually needs them —
// don't preemptively cover the universe. Keeps the function small.

const ATTR_HOOKS = [
  ['data-i18n',              (el, v) => { el.textContent = v; }],
  ['data-i18n-placeholder',  (el, v) => { el.setAttribute('placeholder', v); }],
  ['data-i18n-title',        (el, v) => { el.setAttribute('title', v); }],
  ['data-i18n-aria-label',   (el, v) => { el.setAttribute('aria-label', v); }],
];

export function applyI18n(root = document) {
  for (const [attr, apply] of ATTR_HOOKS) {
    root.querySelectorAll('[' + attr + ']').forEach(el => {
      const key = el.getAttribute(attr);
      apply(el, t(key));
    });
  }
}

// `<html dir>` and `<html lang>` drive native form behaviour, font
// fallback selection, and browser-built dropdowns. Keeping them in sync
// with the current language is non-negotiable.
function _applyDocAttrs() {
  document.documentElement.setAttribute('lang', _lang);
  document.documentElement.setAttribute('dir', _lang === 'en' ? 'ltr' : 'rtl');
}

// ─── Init ───────────────────────────────────────────────────────────
// Apply doc attrs immediately on import so the first paint has the
// right direction. applyI18n() needs the DOM, so defer until DOMContent
// is ready.
_applyDocAttrs();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => applyI18n());
} else {
  applyI18n();
}

// ─── Listener helper ────────────────────────────────────────────────
// Pages with JS-generated content (sidebars, tab modules) hook this so
// they can re-render their dynamic strings when the user toggles lang.
export function onLangChange(fn) {
  window.addEventListener(EVENT_NAME, () => fn(_lang));
}
