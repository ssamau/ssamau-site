// Membership applications (§6).
//
// Status machine:
//   PendingTriage → AssignedToCommittee → InterviewRequested? → Accepted/Rejected
//
// The right-rail action panel shows different controls depending on the
// status — triage (assign to a committee), decide (accept/reject/request
// interview), or final (read-only view). All decisions go through the
// Edge Function which handles "Accepted" → auto-create the member row.
//
// `_activeApplication` is module-scoped so the decision handlers can find
// the open application without re-querying.

import { DB } from '../../lib/state.js';
import { esc, gv, sv, tag, fmtDate } from '../../lib/format.js';
import { api, toast, openModal, closeModal } from '../../lib/ui.js';
import { loadMembers } from './members.js';

// ══════════════════════════════════════════
// MEMBERSHIP APPLICATIONS (§6)
// ══════════════════════════════════════════
export const APP_STATUS_AR = {
  PendingTriage:       'قيد الفرز',
  AssignedToCommittee: 'معيّنة للجنة',
  InterviewRequested:  'مقابلة مطلوبة',
  Accepted:            'مقبولة',
  Rejected:            'مرفوضة',
};

// Canonical-value → Arabic label maps for the expanded apply-form-v2 fields.
// Keep the canonical-value strings in sync with apply.html and migration 0005.
export const SCHOLARSHIP_LABELS = {
  khadem_alharamain:    'برنامج خادم الحرمين الشريفين',
  job_sponsored:        'ابتعاث وظيفي (حكومي/عسكري)',
  private_sector:       'الشركات والقطاع الخاص',
  cultural_tourism:     'الابتعاث الثقافي والسياحي',
  companion_student:    'مرافق دارس',
  self_funded:          'دارس على الحساب الخاص',
  companion_non_student: 'مرافق غير دارس',
};
export const UNIVERSITY_LABELS = {
  melbourne:  'Melbourne University',
  monash:     'Monash University',
  rmit:       'RMIT',
  deakin:     'Deakin University',
  latrobe:    'La Trobe University',
  swinburne:  'Swinburne University',
  victoria:   'Victoria University',
  acu:        'Australian Catholic University',
};
export const STUDY_LEVEL_LABELS = {
  PhD:       'دكتوراه',
  Masters:   'ماجستير',
  Bachelor:  'بكالوريوس',
  Diploma:   'دبلوم',
  Language:  'دراسة لغة',
};
export const STUDY_START_LABELS = {
  '<6mo':   'أقل من 6 أشهر',
  '6mo-1y': '6 أشهر إلى سنة',
  '>1y':    'أكثر من سنة',
};
export const GRADUATION_LABELS = {
  Jul2027: 'يوليو 2027',
  Dec2027: 'ديسمبر 2027',
  '2028+': '2028 أو لاحقاً',
};
export const REFERRAL_LABELS = {
  twitter:   'منصة إكس (تويتر)',
  snapchat:  'سناب شات',
  instagram: 'انستقرام',
  whatsapp:  'واتس اب',
  website:   'الموقع الإلكتروني',
  friend:    'صديق / زميل',
};
export const APP_STATUS_COLOR = {
  PendingTriage:       't-y',
  AssignedToCommittee: 't-b',
  InterviewRequested:  't-o',
  Accepted:            't-g',
  Rejected:            't-r',
};
let _activeApplication = null;

export async function loadApplications() {
  // Ensure committees are loaded — needed for the triage dropdown and
  // for resolving committee_id → name in the row + detail rendering.
  if (!DB.committees.length) {
    const c = await api('getCommittees', {});
    DB.committees = (c && c.success ? c.data : []) || [];
  }
  const params = {};
  const st = gv('applications-status-filter'); if (st) params.status = st;
  const data = await api('applications.list', params);
  if (!data || !data.success) return;
  const items = data.data || [];
  const tbody = document.getElementById('applications-tbody');
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">لا توجد طلبات</td></tr>';
  } else {
    tbody.innerHTML = items.map(a => renderApplicationRow(a)).join('');
  }
  // Sidebar badge: count of items still needing a decision (everything pre-final).
  const pending = items.filter(a => a.status !== 'Accepted' && a.status !== 'Rejected').length;
  const badge = document.getElementById('b-applications');
  if (badge) badge.textContent = pending;
  // Cache for the modal lookups.
  DB._applications = items;
}

export function renderApplicationRow(a) {
  const contact = [a.email, a.phone].filter(Boolean).join(' · ') || '—';
  const uniMajor = [a.university, a.major].filter(Boolean).join(' / ') || '—';
  const interests = (a.interests && a.interests.length)
    ? a.interests.map(id => {
        const c = DB.committees.find(cc => cc.committee_id === id);
        return c ? c.committee_name : id;
      }).join('، ')
    : '<span style="color:var(--tm)">—</span>';
  const assigned = a.assigned_committee_name
    ? esc(a.assigned_committee_name)
    : '<span style="color:var(--tm)">—</span>';
  const statusLabel = APP_STATUS_AR[a.status] || a.status;
  const isFinal = a.status === 'Accepted' || a.status === 'Rejected';
  return `<tr>
    <td>
      <div style="font-weight:700">${esc(a.preferred_name || a.full_name)}</div>
      ${a.preferred_name ? `<div style="font-size:.7rem;color:var(--tm)">${esc(a.full_name)}</div>` : ''}
    </td>
    <td style="font-size:.78rem;direction:ltr;text-align:right">${esc(contact)}</td>
    <td style="font-size:.78rem">${esc(uniMajor)}</td>
    <td style="font-size:.78rem;max-width:160px">${interests}</td>
    <td>${assigned}</td>
    <td>${tag(statusLabel, APP_STATUS_COLOR[a.status] || 't-gr')}</td>
    <td>${fmtDate(a.created_at)}</td>
    <td>
      <button class="btn-icon" title="${isFinal ? 'عرض' : 'مراجعة'}" data-action="openApplicationReview" data-id="${esc(a.application_id)}">${isFinal ? '👁️' : '✏️'}</button>
    </td>
  </tr>`;
}

export function openApplicationReview(applicationId) {
  const a = (DB._applications || []).find(x => x.application_id === applicationId);
  if (!a) return;
  _activeApplication = a;
  sv('app-edit-id', a.application_id);
  sv('app-decision-note', a.decision_reason || '');

  // Detail panel — every field captured by apply.html, grouped the same way
  // the form groups them so reviewers can scan top-down.
  const interests = (a.interests && a.interests.length)
    ? a.interests.map(id => {
        const c = DB.committees.find(cc => cc.committee_id === id);
        return c ? c.committee_name : id;
      }).join('، ')
    : '—';
  const phone = a.phone ? `${a.phone_country_code || ''} ${a.phone}`.trim() : '—';
  const whatsapp = a.whatsapp ? `${a.whatsapp_country_code || ''} ${a.whatsapp}`.trim() : '';
  const scholarship = a.scholarship_entity === 'other'
    ? (a.scholarship_entity_other || 'أخرى')
    : (SCHOLARSHIP_LABELS[a.scholarship_entity] || a.scholarship_entity || '—');
  const university = a.university === 'other'
    ? (a.university_other || 'أخرى')
    : (UNIVERSITY_LABELS[a.university] || a.university || '—');
  const studyLevel = STUDY_LEVEL_LABELS[a.study_level] || a.study_level || '—';
  const studyStarted = STUDY_START_LABELS[a.study_started_window] || a.study_started_window || '—';
  const expectedGrad = GRADUATION_LABELS[a.expected_graduation_window] || a.expected_graduation_window || '—';
  const referral = a.referral_source === 'other'
    ? (a.referral_source_other || 'أخرى')
    : (REFERRAL_LABELS[a.referral_source] || a.referral_source || '—');

  const block = (title, rows) => {
    const visible = rows.filter(([, v]) => v && v !== '—');
    if (!visible.length) return '';
    return `<div style="margin-top:.75rem;padding-top:.6rem;border-top:1px solid #e5e7eb">
      <div style="font-size:.74rem;color:var(--tm);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.4rem">${title}</div>
      ${visible.map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`).join('')}
    </div>`;
  };

  document.getElementById('app-detail').innerHTML = `
    <div style="font-size:.95rem;font-weight:700;color:var(--g)">${esc(a.name_ar || a.full_name)}${a.preferred_name ? ` <span style="color:var(--tm);font-size:.78rem">(${esc(a.preferred_name)})</span>` : ''}</div>
    ${a.name_en ? `<div dir="ltr" style="font-size:.78rem;color:var(--tm);margin-top:.1rem">${esc(a.name_en)}</div>` : ''}

    ${block('الهوية', [
      ['رقم الهوية',   a.national_id ? `<span dir="ltr">${esc(a.national_id)}</span>` : ''],
      ['الجنس',        esc(a.gender)],
      ['تاريخ الميلاد', fmtDate(a.date_of_birth)],
    ])}

    ${block('التواصل', [
      ['البريد',     a.email    ? `<span dir="ltr">${esc(a.email)}</span>` : ''],
      ['الجوال',    a.phone    ? `<span dir="ltr">📱 ${esc(phone)}</span>` : ''],
      ['واتس اب',  a.whatsapp ? `<span dir="ltr">💬 ${esc(whatsapp)}</span>` : ''],
      ['العنوان',   esc(a.address_melbourne)],
    ])}

    ${block('الابتعاث والدراسة', [
      ['جهة الابتعاث',         esc(scholarship)],
      ['المرحلة',              esc(studyLevel)],
      ['التخصص',               esc(a.degree_field || a.major)],
      ['الجامعة',              esc(university)],
      ['بدء الدراسة',          esc(studyStarted)],
      ['التخرج المتوقع',       esc(expectedGrad)],
    ])}

    ${block('عنه', [
      ['اللجان المهتم بها', interests],
      ['المهارات والهوايات', a.skills_hobbies ? esc(a.skills_hobbies).replace(/\n/g, '<br>') : ''],
      ['عن نفسه',           (a.about_self || a.pitch) ? esc(a.about_self || a.pitch).replace(/\n/g, '<br>') : ''],
      ['السيرة الذاتية',    a.cv_url ? `<a href="${esc(a.cv_url)}" target="_blank" rel="noopener" dir="ltr" style="color:var(--g);text-decoration:underline">فتح الرابط ↗</a>` : ''],
    ])}

    ${block('إضافات', [
      ['كيف علم بالنادي', esc(referral)],
      ['اقتراحات',       a.suggestions ? esc(a.suggestions).replace(/\n/g, '<br>') : ''],
    ])}

    <div style="margin-top:.7rem;padding-top:.6rem;border-top:1px solid #e5e7eb;font-size:.74rem;color:var(--tm)">
      رقم الطلب: <span dir="ltr">${esc(a.application_id)}</span> · تاريخ الطلب: ${fmtDate(a.created_at)}
      ${a.decided_at ? ` · قرار في ${fmtDate(a.decided_at)}` : ''}
      ${a.created_member_id ? ` · العضو: <span dir="ltr">${esc(a.created_member_id)}</span>` : ''}
    </div>
  `;

  // Show the right action panel for this status.
  ['triage', 'decide', 'final'].forEach(k =>
    document.getElementById('app-action-' + k).style.display = 'none'
  );
  if (a.status === 'PendingTriage') {
    document.getElementById('app-action-triage').style.display = '';
    // Populate committee dropdown — show full set, suggest the first interest if any.
    const sel = document.getElementById('app-assign-committee');
    sel.innerHTML = '<option value="">— اختر لجنة —</option>' + DB.committees.map(c =>
      `<option value="${c.committee_id}">${esc(c.committee_name)}</option>`
    ).join('');
    if (a.interests && a.interests.length) sel.value = a.interests[0];
  } else if (a.status === 'AssignedToCommittee' || a.status === 'InterviewRequested') {
    document.getElementById('app-action-decide').style.display = '';
  } else {
    document.getElementById('app-action-final').style.display = '';
  }
  openModal('application');
}

export async function appAssignCommittee() {
  if (!_activeApplication) return;
  const committeeId = gv('app-assign-committee');
  if (!committeeId) { toast('اختر لجنة', 'twarn'); return; }
  const res = await api('applications.assignCommittee', {
    id: _activeApplication.application_id, committee_id: committeeId,
  });
  if (res && res.success) {
    toast('📤 تم الإسناد لرئيس اللجنة');
    closeModal('application');
    loadApplications();
  }
}

export async function appAccept() {
  if (!_activeApplication) return;
  const note = gv('app-decision-note');
  const res = await api('applications.accept', { id: _activeApplication.application_id, note });
  if (res && res.success) {
    toast(`✅ تم قبول العضو (${res.data ? res.data.member_id : ''})`);
    closeModal('application');
    loadApplications();
    // Also refresh members so the new row appears immediately if the user navigates there.
    loadMembers();
  }
}

export async function appRequestInterview() {
  if (!_activeApplication) return;
  const note = gv('app-decision-note');
  const res = await api('applications.requestInterview', { id: _activeApplication.application_id, note });
  if (res && res.success) {
    toast('💬 تم طلب مقابلة');
    closeModal('application');
    loadApplications();
  }
}

export async function appReject() {
  if (!_activeApplication) return;
  const reason = prompt('سبب الرفض (اختياري):', gv('app-decision-note') || '');
  if (reason === null) return;
  const res = await api('applications.reject', { id: _activeApplication.application_id, reason });
  if (res && res.success) {
    toast('❌ تم الرفض');
    closeModal('application');
    loadApplications();
  }
}
