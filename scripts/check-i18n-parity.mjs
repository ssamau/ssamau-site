// i18n key-parity check.
//
// Both catalogs (assets/js/lib/strings/ar.js, en.js) export a flat
// { 'key': 'value' } map by default. Missing keys fall back to the
// raw key string at runtime, which makes them visible in the UI but
// not catastrophic. This script is the cheap pre-commit gate so the
// next deploy doesn't ship a key that's only in one language.
//
// Exits non-zero with a diff when keys diverge; silent + zero when
// they match. Empty / whitespace-only values are flagged too — those
// usually mean the translator forgot the value but pasted the key.
//
// Run manually:  node scripts/check-i18n-parity.mjs
// Wired into:    scripts/git-hooks/pre-commit (via `git config
//                core.hooksPath scripts/git-hooks` once).

import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const arPath = join(root, 'assets/js/lib/strings/ar.js');
const enPath = join(root, 'assets/js/lib/strings/en.js');

const [ar, en] = await Promise.all([
  import(pathToFileURL(arPath).href).then(m => m.default),
  import(pathToFileURL(enPath).href).then(m => m.default),
]);

const arKeys = new Set(Object.keys(ar));
const enKeys = new Set(Object.keys(en));

const missingInEn = [...arKeys].filter(k => !enKeys.has(k)).sort();
const missingInAr = [...enKeys].filter(k => !arKeys.has(k)).sort();

// Empty-value check — only flag keys that are empty in ONE catalog
// but not the other. A key intentionally empty in BOTH (e.g. an
// icon-only column header) is fine: it's parity-symmetric. Asymmetric
// empties almost always mean the translator forgot to fill that side.
const isEmpty = (v) => typeof v !== 'string' || v.trim() === '';
const emptyAr = Object.entries(ar)
  .filter(([k, v]) => isEmpty(v) && !isEmpty(en[k]))
  .map(([k]) => k);
const emptyEn = Object.entries(en)
  .filter(([k, v]) => isEmpty(v) && !isEmpty(ar[k]))
  .map(([k]) => k);

const problems = [];
if (missingInEn.length) {
  problems.push(`Keys present in ar.js but missing in en.js (${missingInEn.length}):\n  ${missingInEn.join('\n  ')}`);
}
if (missingInAr.length) {
  problems.push(`Keys present in en.js but missing in ar.js (${missingInAr.length}):\n  ${missingInAr.join('\n  ')}`);
}
if (emptyAr.length) {
  problems.push(`Empty values in ar.js (${emptyAr.length}):\n  ${emptyAr.join('\n  ')}`);
}
if (emptyEn.length) {
  problems.push(`Empty values in en.js (${emptyEn.length}):\n  ${emptyEn.join('\n  ')}`);
}

if (problems.length) {
  console.error('✖ i18n parity check FAILED\n');
  for (const p of problems) console.error(p + '\n');
  console.error(`Total keys — ar: ${arKeys.size}, en: ${enKeys.size}`);
  process.exit(1);
}

console.log(`✔ i18n parity OK — ${arKeys.size} keys in both catalogs`);
