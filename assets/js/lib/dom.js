// Small DOM helpers shared across pages. Kept names short because they're
// used inside template literals dozens of times per render — `${esc(x)}`
// reads better than `${escapeHtml(x)}`.

// Escape text for safe insertion into HTML. Use for ANY user-supplied string
// going into innerHTML, attribute values, or template-literal HTML strings.
export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Safe JSON literal for inlining inside an HTML attribute. `JSON.stringify(s)`
// yields `"s"` whose literal double-quotes break `onclick="..."` parsing and
// silently kill the handler. Replace them with HTML entities so the browser
// reconstructs the original JSON when invoking the handler.
//
// Note: after the CSP step in this branch we'll prefer addEventListener over
// inline onclick everywhere, and this helper becomes mostly unnecessary. It
// stays for now so the migration is a pure structural move.
export const attrJson = (v) =>
  JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Format any ISO/date string to a short local date. Returns '' for falsy.
// Wrapped in <span dir="ltr"> so the page's RTL direction doesn't reorder
// "30 May 2026" into "May 2026 30".
export function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const s = d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: '2-digit' });
  return `<span dir="ltr" style="display:inline-block">${s}</span>`;
}

export function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const s = d.toLocaleString('en-GB', {
    year:  'numeric', month: 'short', day: '2-digit',
    hour:  '2-digit', minute: '2-digit',
  });
  return `<span dir="ltr" style="display:inline-block">${s}</span>`;
}

// Tag pill — used for status badges throughout admin tables.
export const tag = (text, cls) => `<span class="tag ${cls}">${esc(text)}</span>`;

// Set an input element's value by id. No-op if the element doesn't exist
// (defensive — callers iterate over field lists that may not all be present).
export const sv = (id, val) => {
  const el = document.getElementById(id);
  if (el) el.value = val ?? '';
};

// Query helpers — shorter than document.querySelector everywhere.
export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
