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

export async function loadProfile() {
  const wrap = document.getElementById('profile-form-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>جاري التحميل...</div>';

  const data = await api('members.getOwn');
  if (!data || !data.success) {
    wrap.innerHTML = '<p style="padding:1rem;color:var(--dn)">تعذّر تحميل ملفك الشخصي.</p>';
    return;
  }
  _ownProfile = data.data || {};
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
  // update it?").
  const headerStrip = `
    <div class="profile-readonly-strip">
      <div class="prs-row">
        <span class="prs-label">الاسم الكامل:</span>
        <span class="prs-value">${esc(m.full_name) || '—'}</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">رقم الهوية:</span>
        <span class="prs-value" style="direction:ltr">${esc(m.national_id) || '—'}</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">اللجنة:</span>
        <span class="prs-value">${esc(m.committee_name) || '—'}</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">الدور:</span>
        <span class="prs-value">${esc(m.club_role) || '—'}</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">الحالة:</span>
        <span class="prs-value">${esc(m.status) || '—'}</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">إجمالي الساعات المعتمدة:</span>
        <span class="prs-value"><strong>${m.total_hours || 0}</strong> ساعة</span>
      </div>
      <div class="prs-row">
        <span class="prs-label">تاريخ الانضمام:</span>
        <span class="prs-value">${fmtDate(m.join_date) || '—'}</span>
      </div>
    </div>
    <p class="prs-note">
      الحقول أعلاه مُدارة من قِبل الإدارة. إذا كان أحدها يحتاج إلى تحديث،
      تواصل مع رئيس لجنتك أو الإدارة.
    </p>
  `;

  // Editable form — the COALESCE-safe whitelist from members.updateOwn.
  // All fields use `unicode-bidi: plaintext` (inherited from base.css /
  // login.css conventions) so the cursor sits where the user expects
  // when typing LTR data (phones, emails) into RTL layout.
  //
  // cv_url and profile_photo_url are NO LONGER editable as text — they
  // store Storage paths now (Phase A), populated by the upload widgets
  // rendered at the bottom of the form. The whitelist in saveProfile()
  // still includes them so an admin import path that hands us a URL
  // would survive, but the user can't accidentally clobber the upload
  // path with junk text.
  const formFields = `
    <div class="profile-edit-form">
      <div class="fg-grid">
        ${field('preferred_name',          'الاسم المختصر',         m.preferred_name)}
        ${field('email',                   'البريد الإلكتروني',     m.email,    'email')}
        ${field('phone',                   'الجوال (أستراليا)',     m.phone,    'tel')}
        ${field('whatsapp',                'الواتساب (السعودية)',   m.whatsapp, 'tel')}
        ${field('gender',                  'الجنس',                 m.gender)}
        ${field('date_of_birth',           'تاريخ الميلاد',         m.date_of_birth, 'date')}
        ${field('address_melbourne',       'العنوان في ملبورن',     m.address_melbourne)}
        ${field('linkedin_url',            'رابط LinkedIn',         m.linkedin_url, 'url')}
      </div>
      <h4 class="pf-section">الدراسة والابتعاث</h4>
      <div class="fg-grid">
        ${field('university',              'الجامعة',               m.university)}
        ${field('study_level',             'المرحلة الدراسية',      m.study_level)}
        ${field('degree_field',            'التخصص',                m.degree_field)}
        ${field('scholarship_entity',      'الجهة المبتعِثة',       m.scholarship_entity)}
        ${field('study_started_window',    'بداية الدراسة',         m.study_started_window)}
        ${field('expected_graduation_window','التخرج المتوقع',      m.expected_graduation_window)}
      </div>
      <h4 class="pf-section">عن نفسك</h4>
      ${textarea('skills_hobbies', 'المهارات والاهتمامات', m.skills_hobbies)}
      ${textarea('about_self',     'نبذة عنك',             m.about_self)}
      <h4 class="pf-section">الملفات</h4>
      <div class="fg-grid">
        ${uploaderBlock('photo', 'الصورة الشخصية', m.profile_photo_url)}
        ${uploaderBlock('cv',    'السيرة الذاتية (PDF)', m.cv_url)}
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
  const placeholder = kind === 'cv'
    ? '<span class="upl-empty">لا يوجد ملف بعد</span>'
    : '<span class="upl-empty">لا توجد صورة بعد</span>';
  return `
    <div class="fg upl-fg" id="upl-${kind}-wrap">
      <label>${esc(label)}</label>
      <div class="upl-current" id="upl-${kind}-current">${currentPath ? '<span class="upl-empty">جاري التحميل...</span>' : placeholder}</div>
      <div class="upl-controls">
        <input type="file" id="upl-${kind}-file" accept="${accept}" data-action="onUploaderChange" data-kind="${kind}" data-event="change"/>
        <button class="btn btn-g btn-sm" type="button" data-action="submitUploader" data-kind="${kind}" id="upl-${kind}-btn" disabled>⬆ رفع</button>
        ${currentPath ? `<button class="btn btn-ol btn-sm" type="button" data-action="deleteUploader" data-kind="${kind}">🗑 حذف</button>` : ''}
      </div>
      <div class="fg-note">${kind === 'cv' ? 'PDF فقط، 5 ميجابايت كحد أقصى' : 'JPG / PNG / WebP، 3 ميجابايت كحد أقصى'}</div>
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
    slot.innerHTML = kind === 'cv'
      ? '<span class="upl-empty">لا يوجد ملف بعد</span>'
      : '<span class="upl-empty">لا توجد صورة بعد</span>';
    return;
  }
  const res = await api('storage.getMemberFile', { data: { kind } });
  if (!res || !res.success || !res.data?.url) {
    slot.innerHTML = '<span class="upl-empty" style="color:var(--dn)">تعذّر تحميل المعاينة</span>';
    return;
  }
  if (kind === 'photo') {
    slot.innerHTML = `<img src="${esc(res.data.url)}" alt="" style="width:120px;height:120px;border-radius:12px;object-fit:cover;border:2px solid var(--bd)"/>`;
  } else {
    slot.innerHTML = `<a href="${esc(res.data.url)}" target="_blank" rel="noopener" style="color:var(--g);font-weight:700;text-decoration:none">📄 عرض الملف الحالي</a>`;
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
    toast('اختر ملفاً أولاً.', 'twarn');
    return;
  }
  // Pre-validate size on the client too — saves an upload round-trip
  // for an obviously-oversized file. Server cap is the source of truth.
  const sizeCaps = { cv: 5 * 1024 * 1024, photo: 3 * 1024 * 1024 };
  if (file.size > sizeCaps[kind]) {
    toast(`الملف أكبر من الحد المسموح (${sizeCaps[kind] / 1024 / 1024} ميجا).`, 'twarn');
    return;
  }
  const btn = document.getElementById(`upl-${kind}-btn`);
  if (btn) { btn.disabled = true; btn.textContent = 'جاري الرفع...'; }
  try {
    const base64Data = await fileToBase64(file);
    const res = await api('storage.uploadMemberFile', {
      data: { kind, filename: file.name, contentType: file.type, base64Data },
    });
    if (!res || !res.success) {
      toast(res?.error || 'فشل الرفع.', 'twarn');
      return;
    }
    toast('تم الرفع.', 'tok');
    // Re-load profile so the column update + signed URL are fresh.
    await loadProfile();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬆ رفع'; }
  }
}

export async function deleteUploader(el) {
  const kind = el.dataset.kind;
  if (!confirm(kind === 'cv' ? 'حذف السيرة الذاتية الحالية؟' : 'حذف الصورة الحالية؟')) return;
  const res = await api('storage.deleteMemberFile', { data: { kind } });
  if (!res || !res.success) {
    toast(res?.error || 'فشل الحذف.', 'twarn');
    return;
  }
  toast('تم الحذف.', 'tok');
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
    toast('لم يتم تحميل ملفك بعد، حاول مرة أخرى.', 'twarn');
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
    toast('لا توجد تغييرات لحفظها.', 'tok');
    return;
  }

  const btn = document.getElementById('profile-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'جاري الحفظ...'; }
  try {
    const res = await api('members.updateOwn', { data: diff });
    if (!res || !res.success) {
      toast(res?.error || 'فشل الحفظ.', 'twarn');
      return;
    }
    toast('تم حفظ التعديلات.', 'tok');
    // Refresh cache + form values so subsequent saves diff against the
    // saved state, not the original load. Cheapest way is a re-load.
    await loadProfile();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 حفظ التعديلات'; }
  }
}


// ─── Contact directory ──────────────────────────────────────────────
// Carried over from the Phase 4 placeholder member.html. Renders a list
// of presidency members + the user's committee head/vice into the
// #contact-cards container under the profile tab.

const LEADERSHIP_ROLES = new Set([
  'President', 'Vice President', 'Deputy Vice President',
]);
const HEAD_ROLES = new Set([
  'Committee Head', 'Committee Vice Head',
]);
const ROLE_LABEL_AR = {
  'President':              'الرئيس',
  'Vice President':         'نائب الرئيس',
  'Deputy Vice President':  'مساعد نائب الرئيس',
  'Committee Head':         'رئيس اللجنة',
  'Committee Vice Head':    'نائب رئيس اللجنة',
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
    const role = ROLE_LABEL_AR[m.club_role] || m.club_role || '';
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
      : '<span style="font-size:.7rem;color:var(--tm,#9ca3af)">— لا يوجد رقم تواصل —</span>';

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
