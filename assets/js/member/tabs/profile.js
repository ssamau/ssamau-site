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
        ${field('cv_url',                  'رابط السيرة الذاتية',   m.cv_url, 'url')}
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
    </div>
  `;

  wrap.innerHTML = headerStrip + formFields;
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
  const allFields = [
    'preferred_name', 'email', 'phone', 'whatsapp', 'gender',
    'date_of_birth', 'address_melbourne', 'linkedin_url', 'cv_url',
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
