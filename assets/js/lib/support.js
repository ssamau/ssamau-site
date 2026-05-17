// Shared support-ticket module — used by admin / head / member portals.
//
// One modal (#ov-support) lives in each portal's HTML with the same
// element ids. openSupportModal() resets the form + snapshots window
// state (URL, viewport, user agent) so the dev gets repro hints
// without the reporter having to type them. submitSupportTicket()
// reads the form + the optional file picker, posts to support.submit,
// and toasts success/failure.

import { api, toast, openModal, closeModal } from './ui.js';
import { t } from './i18n.js';
import { localizeError } from './api.js';
import { gv, sv } from './format.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIMES  = ['image/jpeg', 'image/png', 'image/webp'];

// Module-level: stash the auto-collected diagnostics so submit() doesn't
// have to re-read window state after the user has potentially navigated
// or resized while filling the form.
let _pageCtx = null;

export function openSupportModal() {
  // Reset all form fields. Category defaults to Bug since that's the
  // most common drop-in reason; user can change it before submitting.
  sv('sup-category',    'Bug');
  sv('sup-title',       '');
  sv('sup-description', '');
  sv('sup-repro',       '');
  const fileEl = document.getElementById('sup-attachment-file');
  if (fileEl) fileEl.value = '';
  const fileMeta = document.getElementById('sup-attachment-meta');
  if (fileMeta) fileMeta.textContent = '';
  const submitBtn = document.getElementById('sup-submit-btn');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = t('support.submit_btn');
  }

  // Snapshot diagnostics now — if the user navigates inside the SPA
  // while typing, location.href may change before submit fires; we want
  // the URL where they opened the report.
  _pageCtx = {
    page_url:   String(window.location.href || '').slice(0, 1024),
    user_agent: String(navigator.userAgent || '').slice(0, 512),
    viewport:   `${window.innerWidth}x${window.innerHeight}`,
  };

  openModal('support');
}

// File picker handler — wires the "max 4MB JPG/PNG/WebP" UX. Sets the
// `sup-attachment-meta` line to either "<filename> (NN KB)" on success
// or a localized error on rejection, and tracks acceptance via a
// data-ok attr the submit path reads.
export function onSupportFileChange(el) {
  const meta = document.getElementById('sup-attachment-meta');
  const f = el?.files?.[0];
  if (!f) {
    if (meta) meta.textContent = '';
    el.dataset.ok = '';
    return;
  }
  if (!ALLOWED_MIMES.includes(f.type)) {
    if (meta) meta.textContent = t('support.err_file_type');
    el.value = '';
    el.dataset.ok = '';
    return;
  }
  if (f.size > MAX_FILE_BYTES) {
    if (meta) meta.textContent = t('support.err_file_too_large');
    el.value = '';
    el.dataset.ok = '';
    return;
  }
  if (meta) meta.textContent = `${f.name} (${Math.round(f.size / 1024)} KB)`;
  el.dataset.ok = '1';
}

// Reads a File as data: URL (base64). Wrapped so the submit flow can
// await it. Strips the data URL prefix server-side (see b64ToBytes in
// support.ts) — we send the whole "data:image/png;base64,…" string so
// the server can sanity-check the MIME against the prefix too.
function _readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
}

export async function submitSupportTicket() {
  const category    = gv('sup-category');
  const title       = gv('sup-title').trim();
  const description = gv('sup-description').trim();
  const repro_steps = gv('sup-repro').trim();
  if (!category)    { toast(t('support.err_category'),    'twarn'); return; }
  if (!title)       { toast(t('support.err_title'),       'twarn'); return; }
  if (!description) { toast(t('support.err_description'), 'twarn'); return; }

  const fileEl = document.getElementById('sup-attachment-file');
  const file   = fileEl?.files?.[0];
  if (file && fileEl?.dataset?.ok !== '1') {
    // onSupportFileChange already toasted the meta error; bounce here
    // so we don't ship an invalid file payload.
    toast(t('support.err_file_invalid'), 'twarn');
    return;
  }

  const submitBtn = document.getElementById('sup-submit-btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = t('support.submitting');
  }

  let attachment = null;
  if (file) {
    try {
      const base64Data = await _readFileAsBase64(file);
      attachment = {
        filename:    file.name,
        contentType: file.type,
        base64Data,
      };
    } catch (err) {
      console.warn('[support] file read failed:', err);
      toast(t('support.err_file_read'), 'twarn');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = t('support.submit_btn'); }
      return;
    }
  }

  const res = await api('support.submit', {
    data: {
      category,
      title,
      description,
      repro_steps: repro_steps || null,
      page_url:    _pageCtx?.page_url   || null,
      user_agent:  _pageCtx?.user_agent || null,
      viewport:    _pageCtx?.viewport   || null,
      attachment,
    },
  });

  if (res && res.success) {
    toast(t('support.success', { id: (res.data?.ticket_id || '') }), 'tok');
    closeModal('support');
  } else {
    const msg = localizeError(res?.error, res?.errorParams) || t('support.err_submit');
    toast(msg, 'twarn');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = t('support.submit_btn'); }
  }
}
