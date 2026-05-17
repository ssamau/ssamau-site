// Profile tab — member portal (Phase 5c of Branch 4).
//
// Calls the two self-scoped Edge Function actions from Phase 5a:
//   members.getOwn    — fetch the caller's own row
//   members.updateOwn — write back a whitelisted subset of fields
//
// Renders an edit form, NOT a read-only view — the whole point of this
// tab is letting members maintain their own contact + scholarship +
// about-me data without having to ping a committee head every time
// their phone number changes.
//
// Read-only fields (full_name / national_id / club_role / committee /
// status / total_hours) are shown in a header strip above the form so
// the member can see the canonical record without being able to edit
// it. Those fields are admin-managed; updateOwn ignores them.
//
// Also renders the contact directory (presidency + own committee
// head/vice) carried over from the Phase 4 placeholder member.html.
// The directory is the same fetch pattern (`getMembers` is public).

import { api, callApi, toast } from '../../lib/ui.js';
import { esc, gv, sv, fmtDate } from '../../lib/format.js';
import { getSession } from '../../lib/auth.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

// Enum maps — canonical-value → i18n-key. Same source set the apply
// form uses, kept inline here so the profile editor doesn't have to
// import the admin applications module (which carries other admin-only
// state). Adding a value? Update both this file AND apply.html's
// dropdown so the two paths stay in lockstep.
const SCHOLARSHIP_OPTS = [
  ['khadem_alharamain',     'apply.s3.opt.khadem_alharamain'],
  ['job_sponsored',         'apply.s3.opt.job_sponsored'],
  ['private_sector',        'apply.s3.opt.private_sector'],
  ['cultural_tourism',      'apply.s3.opt.cultural_tourism'],
  ['companion_student',     'apply.s3.opt.companion_student'],
  ['self_funded',           'apply.s3.opt.self_funded'],
  ['companion_non_student', 'apply.s3.opt.companion_non_student'],
];
const UNIVERSITY_OPTS = [
  ['melbourne',  'Melbourne University'],
  ['monash',     'Monash University'],
  ['rmit',       'RMIT'],
  ['deakin',     'Deakin University'],
  ['latrobe',    'La Trobe University'],
  ['swinburne',  'Swinburne University'],
  ['victoria',   'Victoria University'],
  ['acu',        'Australian Catholic University'],
];
const STUDY_LEVEL_OPTS = [
  ['PhD',      'apply.s4.opt.phd'],
  ['Masters',  'apply.s4.opt.masters'],
  ['Bachelor', 'apply.s4.opt.bachelor'],
  ['Diploma',  'apply.s4.opt.diploma'],
  ['Language', 'apply.s4.opt.language'],
];
const STUDY_START_OPTS = [
  ['<6mo',   'apply.s4.opt.started_lt6'],
  ['6mo-1y', 'apply.s4.opt.started_6mo_1y'],
  ['>1y',    'apply.s4.opt.started_gt1y'],
];
const GRADUATION_OPTS = [
  ['Jul2027', 'apply.s4.opt.grad_jul2027'],
  ['Dec2027', 'apply.s4.opt.grad_dec2027'],
  ['2028+',   'apply.s4.opt.grad_2028'],
];
const GENDER_OPTS = [
  // gender values are stored as the Arabic literals themselves
  // (consistent with the apply form's f-gender select), not as
  // English enums. No translation key needed.
  ['ذكر',  'ذكر'],
  ['أنثى', 'أنثى'],
];

// club_role enum → translation key for the read-only strip's role
// pill. Covers every value the database can hold (mirrors the admin
// Members tab's CLUB_ROLE_KEY). Distinct from the ROLE_LABEL_KEY map
// further down in this file, which is scoped to the contact-directory
// list (presidency + heads only) and uses the shorter mp.role.*
// labels — different display context, different translation prefix.
const READONLY_ROLE_KEY = {
  'President':           'ap.role.president',
  'Vice President':      'ap.role.vice_president',
  'Deputy Vice Head':    'ap.role.deputy_vice_head',
  'Committee Head':      'ap.role.committee_head',
  'Committee Vice Head': 'ap.role.committee_vice_head',
  'Project Manager':     'ap.role.project_manager',
  'Event Manager':       'ap.role.event_manager',
  'Member':              'ap.role.member',
  'Volunteer':           'ap.role.volunteer',
};
const READONLY_STATUS_KEY = {
  Active:   'ap.status.active',
  Inactive: 'ap.status.inactive',
};

// Phase-A storage uploaders (CV + profile photo). Both files go to
// private Supabase Storage buckets via `storage.uploadMemberFile`;
// the column stores a relative path (e.g. "MBR_X/123-cv.pdf"), and
// reading requires a 1h signed URL fetched via `storage.getMemberFile`.
// We render the URL into <a href> for CV and <img src> for photo
// after each form load, so a freshly-rendered profile shows the
// latest file without a follow-up refresh.

// In-memory cache of the most recently loaded own-profile row so save
// doesn't need to refetch — we diff form values against this object
// and only send the changed fields. Avoids clobbering a field with its
// own value (which would still hit the COALESCE no-op path, but it's
// noisy in audit logs and clearer to send less over the wire).
let _ownProfile = null;

// Postgres DATE columns travel from postgres.js → JSON as a full
// ISO timestamp ("2000-05-01T00:00:00.000Z"). HTML <input type="date">
// only accepts "YYYY-MM-DD" — anything else and the browser blanks the
// field silently. Normalize on load so both the rendered value AND
// the diff comparison work against the same shape the form emits.
// Bug fix 2026-05-18: the previous code stuffed the raw ISO string
// into the input, the browser blanked it, the diff saw '' vs the ISO,
// flagged a "change", sent date_of_birth: null, and the server's
// COALESCE(null, date_of_birth) silently kept the old value — so
// every save toasted "updated" but the DOB never moved.
function dateInputValue(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  }
  const s = String(v);
  // Fast path for values that already start with YYYY-MM-DD (covers
  // both bare "2000-05-01" and full ISO "2000-05-01T00:00:00.000Z").
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

export async function loadProfile() {
  const wrap = document.getElementById('profile-form-wrap');
  if (!wrap) return;
  wrap.innerHTML = `<div class="loading-spinner"><div class="spinner"></div>${esc(t('common.loading'))}</div>`;

  const data = await api('members.getOwn');
  if (!data || !data.success) {
    wrap.innerHTML = `<p style="padding:1rem;color:var(--dn)">${esc(t('mp.profile.err_load'))}</p>`;
    return;
  }
  _ownProfile = data.data || {};
  // Pre-normalize date columns so the diff path compares like-to-like.
  // members.getOwn returns date_of_birth as a postgres-driver Date that
  // JSON-stringifies to a full ISO string; the form input only speaks
  // YYYY-MM-DD. Both paths now resolve to the same shape.
  if (_ownProfile.date_of_birth) {
    _ownProfile.date_of_birth = dateInputValue(_ownProfile.date_of_birth);
  }
  renderProfileForm(_ownProfile);

  // Contact directory loads in parallel — it only needs getMembers
  // which is public, no own-row dependency.
  loadContactDirectory().catch(err => console.warn('[contacts]', err));
}

function renderProfileForm(m) {
  const wrap = document.getElementById('profile-form-wrap');
  if (!wrap) return;

  // Header strip — admin-managed read-only fields. Showing these makes
  // it obvious what the member can change vs what they have to ask an
  // admin about (e.g. "my role changed to Project Manager, can you
  // update it?"). Role + status values are stored as canonical English
  // enums; we resolve them to Arabic/English via the shared catalog
  // (same maps the admin Members tab uses) so the strip reads as
  // localized labels rather than raw "Member"/"Active" tokens.
  const roleLabel = READONLY_ROLE_KEY[m.club_role] ? t(READONLY_ROLE_KEY[m.club_role]) : (m.club_role || '');
  const statusLabel = READONLY_STATUS_KEY[m.status] ? t(READONLY_STATUS_KEY[m.status]) : (m.status || '');
  const headerStrip = `
    <div class="profile-readonly-strip">
      <div class="prs-row">
        <span class="prs-label">${esc(t('mp.profile.ro_full_name'))}</span>
        <span class="prs-value">${esc(m.full_name) || '—'}</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">${esc(t('mp.profile.ro_nid'))}</span>
        <span class="prs-value" style="direction:ltr">${esc(m.national_id) || '—'}</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">${esc(t('mp.profile.ro_committee'))}</span>
        <span class="prs-value">${esc(m.committee_name) || '—'}</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">${esc(t('mp.profile.ro_role'))}</span>
        <span class="prs-value">${esc(roleLabel) || '—'}</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">${esc(t('mp.profile.ro_status'))}</span>
        <span class="prs-value">${esc(statusLabel) || '—'}</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">${esc(t('mp.profile.ro_total_hours'))}</span>
        <span class="prs-value"><strong>${m.total_hours || 0}</strong> ${esc(t('mp.hours.hours_unit'))}</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">${esc(t('mp.profile.ro_join_date'))}</span>
        <span class="prs-value">${fmtDate(m.join_date) || '—'}</span>
      </div>
    </div>
    <p class="prs-note">${esc(t('mp.profile.ro_note'))}</p>
  `;

  // Editable form — the COALESCE-safe whitelist from members.updateOwn.
  // All fields use `unicode-bidi: plaintext` (inherited from base.css /
  // login.css conventions) so the cursor sits where the user expects
  // when typing LTR data (phones, emails) into RTL layout.
  //
  // Enum fields (gender, study_level, scholarship_entity,
  // study_started_window, expected_graduation_window, university)
  // are <select> dropdowns matching the apply form. Without this the
  // stored canonical values (e.g. "companion_student", "1y<",
  // "Bachelor") leak as raw English/symbol text in the UI — flagged
  // by the president 2026-05-18 ("ensure the translation for the
  // data listed that can be edited").
  //
  // cv_url and profile_photo_url are NO LONGER editable as text — they
  // store Storage paths now (Phase A), populated by the upload widgets
  // rendered at the bottom of the form. The whitelist in saveProfile()
  // still includes them so an admin import path that hands us a URL
  // would survive, but the user can't accidentally clobber the upload
  // path with junk text.
  const formFields = `
    <div class="profile-edit-form">
      <h4 class="pf-section">${esc(t('mp.profile.sec_personal') || 'البيانات الشخصية')}</h4>
      <div class="fg-grid">
        ${field('preferred_name',          t('mp.profile.lbl_preferred_name'), m.preferred_name)}
        ${field('email',                   t('mp.profile.lbl_email'),          m.email,    'email')}
        ${field('phone',                   t('mp.profile.lbl_phone'),          m.phone,    'tel')}
        ${field('whatsapp',                t('mp.profile.lbl_whatsapp'),       m.whatsapp, 'tel')}
        ${selectField('gender',            t('mp.profile.lbl_gender'),         m.gender,            GENDER_OPTS)}
        ${field('date_of_birth',           t('mp.profile.lbl_dob'),            m.date_of_birth, 'date')}
        ${field('address_melbourne',       t('mp.profile.lbl_address'),        m.address_melbourne)}
        ${field('linkedin_url',            t('mp.profile.lbl_linkedin'),       m.linkedin_url, 'url')}
      </div>
      <h4 class="pf-section">${esc(t('mp.profile.sec_study'))}</h4>
      <div class="fg-grid">
        ${selectField('university',                t('mp.profile.lbl_university'),    m.university,                 UNIVERSITY_OPTS,  { rawLabels: true })}
        ${selectField('study_level',               t('mp.profile.lbl_study_level'),   m.study_level,                STUDY_LEVEL_OPTS)}
        ${field('degree_field',                    t('mp.profile.lbl_degree_field'),  m.degree_field)}
        ${selectField('scholarship_entity',        t('mp.profile.lbl_scholarship'),   m.scholarship_entity,         SCHOLARSHIP_OPTS)}
        ${selectField('study_started_window',      t('mp.profile.lbl_study_started'), m.study_started_window,       STUDY_START_OPTS)}
        ${selectField('expected_graduation_window',t('mp.profile.lbl_graduation'),    m.expected_graduation_window, GRADUATION_OPTS)}
      </div>
      <h4 class="pf-section">${esc(t('mp.profile.sec_about'))}</h4>
      ${textarea('skills_hobbies', t('mp.profile.lbl_skills'), m.skills_hobbies)}
      ${textarea('about_self',     t('mp.profile.lbl_about'),  m.about_self)}
      <h4 class="pf-section">${esc(t('mp.profile.sec_files'))}</h4>
      <div class="fg-grid">
        ${uploaderBlock('photo', t('mp.profile.lbl_photo'), m.profile_photo_url)}
        ${uploaderBlock('cv',    t('mp.profile.lbl_cv'),    m.cv_url)}
      </div>
    </div>
  `;

  wrap.innerHTML = headerStrip + formFields;

  // Resolve current file paths to signed URLs (renders previews).
  // Fail-soft: a missing signed URL just leaves the preview slot empty,
  // doesn't block the rest of the form.
  refreshUploaderPreview('photo', m.profile_photo_url).catch(err => console.warn('[photo preview]', err));
  refreshUploaderPreview('cv',    m.cv_url).catch(err           => console.warn('[cv preview]', err));
}

// Per-uploader markup. Three slots: a current-file preview (img for
// photo, link for cv), a file picker, a "rفع" button. Hidden until
// the file picker has a value, then enabled.
function uploaderBlock(kind, label, currentPath) {
  const accept = kind === 'cv' ? 'application/pdf' : 'image/jpeg,image/png,image/webp';
  const emptyKey = kind === 'cv' ? 'mp.profile.upl_no_file' : 'mp.profile.upl_no_photo';
  const placeholder = `<span class="upl-empty">${esc(t(emptyKey))}</span>`;
  const hintKey = kind === 'cv' ? 'mp.profile.upl_cv_hint' : 'mp.profile.upl_photo_hint';
  return `
    <div class="fg upl-fg" id="upl-${kind}-wrap">
      <label>${esc(label)}</label>
      <div class="upl-current" id="upl-${kind}-current">${currentPath ? `<span class="upl-empty">${esc(t('common.loading'))}</span>` : placeholder}</div>
      <div class="upl-controls">
        <input type="file" id="upl-${kind}-file" accept="${accept}" data-action="onUploaderChange" data-kind="${kind}" data-event="change"/>
        <button class="btn btn-g btn-sm" type="button" data-action="submitUploader" data-kind="${kind}" id="upl-${kind}-btn" disabled>${esc(t('mp.profile.upl_btn'))}</button>
        ${currentPath ? `<button class="btn btn-ol btn-sm" type="button" data-action="deleteUploader" data-kind="${kind}">${esc(t('mp.profile.upl_delete'))}</button>` : ''}
      </div>
      <div class="fg-note">${esc(t(hintKey))}</div>
    </div>
  `;
}

// Resolve a stored Storage path → signed URL, then render the preview
// (img for photo, link for cv). Called on form load and after each
// upload/delete.
async function refreshUploaderPreview(kind, path) {
  const slot = document.getElementById(`upl-${kind}-current`);
  if (!slot) return;
  if (!path) {
    const emptyKey = kind === 'cv' ? 'mp.profile.upl_no_file' : 'mp.profile.upl_no_photo';
    slot.innerHTML = `<span class="upl-empty">${esc(t(emptyKey))}</span>`;
    return;
  }
  const res = await api('storage.getMemberFile', { data: { kind } });
  if (!res || !res.success || !res.data?.url) {
    slot.innerHTML = `<span class="upl-empty" style="color:var(--dn)">${esc(t('mp.profile.upl_preview_failed'))}</span>`;
    return;
  }
  if (kind === 'photo') {
    slot.innerHTML = `<img src="${esc(res.data.url)}" alt="" style="width:120px;height:120px;border-radius:12px;object-fit:cover;border:2px solid var(--bd)"/>`;
  } else {
    slot.innerHTML = `<a href="${esc(res.data.url)}" target="_blank" rel="noopener" style="color:var(--g);font-weight:700;text-decoration:none">${esc(t('mp.profile.upl_open_cv'))}</a>`;
  }
}

// Enables the "رفع" button once the file picker has a file selected.
// data-action handler.
export function onUploaderChange(el) {
  const kind = el.dataset.kind;
  const btn  = document.getElementById(`upl-${kind}-btn`);
  if (btn) btn.disabled = !el.files || !el.files[0];
}

// Reads the selected file as base64, posts to storage.uploadMemberFile.
// On success refreshes the form to pick up the new cv_url/photo path.
export async function submitUploader(el) {
  const kind = el.dataset.kind;
  const input = document.getElementById(`upl-${kind}-file`);
  const file  = input?.files?.[0];
  if (!file) {
    toast(t('mp.profile.upl_pick_first'), 'twarn');
    return;
  }
  // Pre-validate size on the client too — saves an upload round-trip
  // for an obviously-oversized file. Server cap is the source of truth.
  const sizeCaps = { cv: 5 * 1024 * 1024, photo: 3 * 1024 * 1024 };
  if (file.size > sizeCaps[kind]) {
    toast(t('mp.profile.upl_too_large', { megs: sizeCaps[kind] / 1024 / 1024 }), 'twarn');
    return;
  }
  const btn = document.getElementById(`upl-${kind}-btn`);
  if (btn) { btn.disabled = true; btn.textContent = t('mp.profile.upl_btn_uploading'); }
  try {
    const base64Data = await fileToBase64(file);
    const res = await api('storage.uploadMemberFile', {
      data: { kind, filename: file.name, contentType: file.type, base64Data },
    });
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t("mp.profile.upl_failed"), 'twarn');
      return;
    }
    toast(t('mp.profile.upl_success'), 'tok');
    // Re-load profile so the column update + signed URL are fresh.
    await loadProfile();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('mp.profile.upl_btn'); }
  }
}

export async function deleteUploader(el) {
  const kind = el.dataset.kind;
  const confirmKey = kind === 'cv' ? 'mp.profile.upl_confirm_cv' : 'mp.profile.upl_confirm_photo';
  if (!confirm(t(confirmKey))) return;
  const res = await api('storage.deleteMemberFile', { data: { kind } });
  if (!res || !res.success) {
    toast(localizeError(res?.error, res?.errorParams) || t("mp.profile.upl_delete_failed"), 'twarn');
    return;
  }
  toast(t('mp.profile.upl_delete_success'), 'tok');
  await loadProfile();
}

// Wrap FileReader in a Promise. result is "data:<mime>;base64,<...>",
// and the Edge Function strips the prefix server-side, so we pass it
// through as-is (cheaper than splitting on the client).
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
}

// Small input helper that produces a labeled .fg block reusing admin.css
// styling. value is HTML-escaped; type defaults to "text".
function field(id, label, value, type = 'text') {
  return `
    <div class="fg">
      <label for="pf-${id}">${esc(label)}</label>
      <input id="pf-${id}" type="${type}" value="${esc(value ?? '')}" autocomplete="off"/>
    </div>
  `;
}

// Select-dropdown variant. `options` is an Array<[value, labelOrI18nKey]>.
// When `rawLabels: true`, the second tuple slot is used verbatim (good
// for proper-noun lists like universities that aren't translatable).
// Otherwise it's resolved via t() at render time.
// The currently-saved value is preselected; an empty leading option
// keeps the form non-destructive (members can clear a field).
function selectField(id, label, value, options, { rawLabels = false } = {}) {
  const current = String(value ?? '');
  const emptyLabel = esc(t('mp.profile.opt_unspecified') || '— غير محدد —');
  const opts = options.map(([v, lbl]) => {
    const labelText = rawLabels ? lbl : esc(t(lbl));
    const selected  = v === current ? ' selected' : '';
    return `<option value="${esc(v)}"${selected}>${labelText}</option>`;
  }).join('');
  // Stash the original value as a data-attr so saveProfile()'s diff
  // path can read it without re-fetching the cached _ownProfile. Not
  // strictly needed (gv() reads the live value) but keeps the helper
  // self-contained.
  return `
    <div class="fg">
      <label for="pf-${id}">${esc(label)}</label>
      <select id="pf-${id}" data-original="${esc(current)}">
        <option value=""${current === '' ? ' selected' : ''}>${emptyLabel}</option>
        ${opts}
      </select>
    </div>
  `;
}

function textarea(id, label, value) {
  return `
    <div class="fg">
      <label for="pf-${id}">${esc(label)}</label>
      <textarea id="pf-${id}" rows="3">${esc(value ?? '')}</textarea>
    </div>
  `;
}

export async function saveProfile() {
  if (!_ownProfile) {
    toast(t('mp.profile.save_not_loaded'), 'twarn');
    return;
  }
  // Build a diff: only send fields that actually changed. This keeps
  // the UPDATE payload small + leaves untouched fields literally
  // untouched (server-side COALESCE handles it either way, but
  // explicit is cheaper to reason about during audits).
  // cv_url + profile_photo_url are managed by the uploader widgets,
  // not the text-field diff path — they're absent from this list on
  // purpose. Including them would null the column on every save
  // (the inputs don't exist so gv() returns '').
  const allFields = [
    'preferred_name', 'email', 'phone', 'whatsapp', 'gender',
    'date_of_birth', 'address_melbourne', 'linkedin_url',
    'skills_hobbies', 'about_self',
    'scholarship_entity', 'study_level', 'degree_field', 'university',
    'study_started_window', 'expected_graduation_window',
  ];
  const diff = {};
  for (const f of allFields) {
    const newVal = gv('pf-' + f);
    const oldVal = (_ownProfile[f] ?? '') + '';
    if (newVal !== oldVal) diff[f] = newVal || null;
  }
  if (!Object.keys(diff).length) {
    toast(t('mp.profile.save_no_changes'), 'tok');
    return;
  }

  const btn = document.getElementById('profile-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('mp.profile.save_btn_saving'); }
  try {
    const res = await api('members.updateOwn', { data: diff });
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t("mp.profile.save_failed"), 'twarn');
      return;
    }
    toast(t('mp.profile.save_success'), 'tok');
    // Refresh cache + form values so subsequent saves diff against the
    // saved state, not the original load. Cheapest way is a re-load.
    await loadProfile();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('mp.profile.save_btn'); }
  }
}


// ─── Contact directory ──────────────────────────────────────────────
// Carried over from the Phase 4 placeholder member.html. Renders a list
// of presidency members + the user's committee head/vice into the
// #contact-cards container under the profile tab.

// Presidency is exactly 3 roles (President + 2 Vice Presidents).
// Deputy-Vice-Head moved to HEAD_ROLES below — it's a committee-level
// position, not presidency, despite the prior "Deputy Vice President"
// label leaking that distinction.
const LEADERSHIP_ROLES = new Set([
  'President', 'Vice President',
]);
const HEAD_ROLES = new Set([
  'Committee Head', 'Committee Vice Head', 'Deputy Vice Head',
]);
// Map enum value → translation key. t() resolves at render time so the
// directory localizes correctly on language switch (main.js's
// onLangChange re-fires loadProfile which re-renders this list).
const ROLE_LABEL_KEY = {
  'President':              'mp.role.president',
  'Vice President':         'mp.role.vice_president',
  'Committee Head':         'mp.role.committee_head',
  'Committee Vice Head':    'mp.role.committee_vice_head',
  'Deputy Vice Head':       'mp.role.deputy_vice_head',
};

async function loadContactDirectory() {
  const res = await callApi('getMembers');
  if (!res || !res.success) return;
  const members = res.data || [];
  const session = getSession();

  const presidency = members.filter(m => LEADERSHIP_ROLES.has(m.club_role));
  const myCom = session?.committee_id || _ownProfile?.committee_id || null;
  const myHeads = myCom
    ? members.filter(m => m.committee_id === myCom && HEAD_ROLES.has(m.club_role))
    : [];

  const cards = [...presidency, ...myHeads];
  if (!cards.length) return;

  const wrap  = document.getElementById('contact-cards');
  const block = document.getElementById('contact-card');
  if (!wrap || !block) return;

  wrap.innerHTML = cards.map(m => {
    const role = ROLE_LABEL_KEY[m.club_role] ? t(ROLE_LABEL_KEY[m.club_role]) : (m.club_role || '');
    const name = m.preferred_name || m.full_name || '—';
    const sub  = m.full_name && m.preferred_name && m.preferred_name !== m.full_name
      ? `<div style="font-size:.68rem;color:var(--tm,#9ca3af)">${esc(m.full_name)}</div>`
      : '';

    const links = [];
    if (m.phone) {
      links.push(
        `<a href="tel:${esc(m.phone)}" style="font-size:.74rem;color:var(--g,#1A5C2E);text-decoration:none;font-weight:700;direction:ltr;display:flex;align-items:center;gap:.3rem">
          <span>📱</span><span>${esc(m.phone)}</span>
        </a>`
      );
    }
    if (m.whatsapp) {
      const waDigits = String(m.whatsapp).replace(/[^\d]/g, '');
      links.push(
        `<a href="https://wa.me/${esc(waDigits)}" target="_blank" rel="noopener" style="font-size:.74rem;color:var(--g,#1A5C2E);text-decoration:none;font-weight:700;direction:ltr;display:flex;align-items:center;gap:.3rem">
          <span>💬</span><span>${esc(m.whatsapp)}</span>
        </a>`
      );
    }
    const contactBlock = links.length
      ? `<div style="display:flex;flex-direction:column;gap:.35rem">${links.join('')}</div>`
      : `<span style="font-size:.7rem;color:var(--tm,#9ca3af)">${esc(t('mp.profile.contact_no_phone'))}</span>`;

    return `
      <div style="background:var(--bg,#fff);border:1px solid var(--bd,#e5e7eb);border-radius:10px;padding:.75rem .85rem">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;margin-bottom:.4rem">
          <div>
            <div style="font-size:.86rem;font-weight:700">${esc(name)}</div>
            ${sub}
          </div>
          <span style="font-size:.65rem;background:var(--gl,#e8f5e9);color:var(--g,#1A5C2E);padding:.15rem .45rem;border-radius:50px;font-weight:700;white-space:nowrap">${esc(role)}</span>
        </div>
        ${contactBlock}
      </div>`;
  }).join('');
  block.style.display = '';
}
