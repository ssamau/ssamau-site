// Tiny formatting + form-value helpers used throughout the admin UI.
//
// These mirror — character for character — the locally-declared helpers that
// used to live at the bottom of admin/main.js. They're duplicated here (rather
// than re-imported from lib/dom.js) because admin/main.js historically had
// these as identically-named local consts; the structural split keeps the
// exact same implementations to guarantee zero behavioural drift, and the
// lib/dom.js versions are left untouched (other pages import from there).

export const gv = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
export const sv = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
export const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Safe JSON for inlining inside an HTML attribute. `JSON.stringify(name)`
// gives `"name"` — the literal double-quotes break onclick="..." parsing and
// silently kill the handler. Replace them with the HTML entity so the
// browser reconstructs the original JSON value when invoking the handler.
export const attrJson = v => JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Format any ISO/date string to a short local date. Returns '' for falsy/invalid.
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
  const s = d.toLocaleString('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `<span dir="ltr" style="display:inline-block">${s}</span>`;
}
export const tag = (text, cls) => `<span class="tag ${cls}">${esc(text)}</span>`;

// Set element textContent by id. No-op if absent. Used by every "stats card"
// renderer (interest/thanks counts, etc.).
export function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
