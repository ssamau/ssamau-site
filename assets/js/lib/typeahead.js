// Typeahead wrapper for `<select>` elements.
//
// Usage:
//   import { attachTypeahead } from './lib/typeahead.js';
//   attachTypeahead(document.getElementById('int-mbr-sel'));
//
// What it does:
//   - Hides the existing <select> (keeps it in the DOM with its name +
//     id intact so existing code reading `selectEl.value` or `gv()`
//     still works — the typeahead just writes the select's value).
//   - Inserts a <input type="text"> + popover <div role="listbox">
//     immediately above the select.
//   - As the user types, filters selectEl.options by substring match
//     (case-insensitive, normalised Arabic + Latin). Up/Down navigates,
//     Enter picks, Esc closes.
//   - Reads options fresh on every input — works even when the select
//     is populated AFTER attach (the common admin pattern, where
//     populateMemberSelects fills the dropdown after the page loads).
//
// Why not replace the <select> entirely:
//   - Every consumer (interest.js / certs.js / thanks.js / etc.) reads
//     `gv('xxx-sel')` which assumes a select element with a .value.
//     Hiding-and-piloting keeps zero-change compat at the consumer.
//   - Form-submit also picks up the hidden select's value if anyone
//     ever wraps these in a real <form>.

import { esc } from './format.js';

// Normalise Arabic for fuzzy substring match. Strips diacritics (tashkeel),
// folds alef variants to plain ا, ya/alef-maksura to ي, ta-marbuta to ه,
// and lowercases Latin. Common practical normalisation for Arabic name
// search; not a full TR-39 implementation but enough for "type أحمد,
// match أَحْمَد and احمد both".
function normaliseAr(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[ً-ْٰ]/g, '') // tashkeel + dagger alef
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build the typeahead UI once per select. Idempotent: calling twice on
// the same select is a no-op (we tag the select with data-typeahead-on).
export function attachTypeahead(selectEl, opts = {}) {
  if (!selectEl || selectEl.dataset.typeaheadOn === '1') return;
  selectEl.dataset.typeaheadOn = '1';

  const placeholder = opts.placeholder || 'ابحث بالاسم...';

  // Wrapper container. Becomes the new positioning context for the
  // popover (position:relative).
  const wrap = document.createElement('div');
  wrap.className = 'typeahead';
  // Splice into the DOM in place of the select.
  selectEl.parentNode.insertBefore(wrap, selectEl);

  // Visible input that the user types into.
  const input = document.createElement('input');
  input.type        = 'text';
  input.className   = 'typeahead-input';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck  = false;
  input.dir         = 'auto';

  // Popover with the filtered option list. Hidden by default; shows
  // on focus and on input.
  const list = document.createElement('div');
  list.className = 'typeahead-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  wrap.appendChild(input);
  wrap.appendChild(list);
  wrap.appendChild(selectEl);
  selectEl.style.display = 'none';

  // Mirror the select's current value back into the input's display
  // text. Called on attach AND whenever someone sets selectEl.value
  // programmatically (rare — populateMemberSelects writes innerHTML,
  // not .value).
  function syncInputFromSelect() {
    const opt = selectEl.options[selectEl.selectedIndex];
    input.value = (opt && opt.value) ? opt.textContent.trim() : '';
  }
  syncInputFromSelect();

  // Render the filtered option list. Reads selectEl.options every
  // time so a dynamic re-populate is automatically reflected.
  let activeIdx = -1;
  function renderList(query) {
    const q = normaliseAr(query);
    const items = [];
    // Skip the first empty/blank option since it's just the placeholder.
    for (let i = 0; i < selectEl.options.length; i++) {
      const opt = selectEl.options[i];
      if (!opt.value) continue;                 // blank placeholder
      const label = opt.textContent.trim();
      if (!q || normaliseAr(label).includes(q)) {
        items.push({ idx: i, value: opt.value, label });
      }
    }
    if (!items.length) {
      list.innerHTML = '<div class="typeahead-empty">لا توجد نتائج</div>';
      list.hidden = false;
      activeIdx = -1;
      return;
    }
    list.innerHTML = items.map((it, n) =>
      `<div class="typeahead-item" role="option" data-value="${esc(it.value)}" data-n="${n}" tabindex="-1">${esc(it.label)}</div>`
    ).join('');
    activeIdx = -1;
    list.hidden = false;
  }

  // Apply a pick — set selectEl.value, fire change event, close the
  // popover. The change event is what existing tab handlers listen
  // to (via onchange="loadInterest" etc.); without it the
  // typeahead would silently break their data wiring.
  function pick(value, label) {
    selectEl.value = value;
    input.value    = label;
    list.hidden    = true;
    activeIdx      = -1;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setActive(n) {
    const items = list.querySelectorAll('.typeahead-item');
    if (!items.length) { activeIdx = -1; return; }
    activeIdx = Math.max(0, Math.min(items.length - 1, n));
    items.forEach((el, i) => el.classList.toggle('tk-active', i === activeIdx));
    items[activeIdx].scrollIntoView({ block: 'nearest' });
  }

  // ── Wire events ────────────────────────────────────────────────
  input.addEventListener('focus', () => { renderList(input.value); });
  input.addEventListener('input', () => { renderList(input.value); });
  input.addEventListener('blur',  () => {
    // Delay so an in-flight click on a list item still registers
    // before the popover closes.
    setTimeout(() => { list.hidden = true; }, 150);
  });
  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('.typeahead-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === 'Enter') {
      // If a list item is highlighted, pick it. Otherwise pick the
      // single matching item if there is exactly one.
      if (activeIdx >= 0 && items[activeIdx]) {
        e.preventDefault();
        const el = items[activeIdx];
        pick(el.dataset.value, el.textContent.trim());
      } else if (items.length === 1) {
        e.preventDefault();
        const el = items[0];
        pick(el.dataset.value, el.textContent.trim());
      }
    }
    else if (e.key === 'Escape') {
      list.hidden = true;
      activeIdx = -1;
    }
  });
  list.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.typeahead-item');
    if (!el) return;
    e.preventDefault();  // keep focus on input so blur doesn't fire mid-pick
    pick(el.dataset.value, el.textContent.trim());
  });

  // Watch for options being added/replaced so the visible input stays
  // in sync if some other code path sets selectEl.value programmatically.
  const obs = new MutationObserver(() => syncInputFromSelect());
  obs.observe(selectEl, { childList: true });
}

// Convenience: attach by a list of ids. Skips ids that aren't in the DOM
// yet (admin.html ships all the relevant selects, but for safety).
export function attachTypeaheadByIds(...ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) attachTypeahead(el);
  }
}
