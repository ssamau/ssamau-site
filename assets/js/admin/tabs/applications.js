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
import { t } from '../../lib/i18n.js';

// ══════════════════════════════════════════
// MEMBERSHIP APPLICATIONS (§6)
// ══════════════════════════════════════════
// Status enum (canonical English from DB) → translation key. Reused by
// the row tag + the modal status badge.
export const APP_STATUS_KEY = {
  PendingTriage:       'ap.apps.status_pending_triage',
  AssignedToCommittee: 'ap.apps.status_assigned',
  InterviewRequested:  'ap.apps.status_interview_requested',
  Accepted:            'ap.apps.status_accepted',
  Rejected:            'ap.apps.status_rejected',
};

// Canonical-value → i18n-key maps for the expanded apply-form-v2 fields.
// Reuse the apply.* catalog where the wording lines up (study level,
// start window, graduation, referral, gender); admin review surfaces the
// same labels the applicant saw on the form.
export const SCHOLARSHIP_KEY = {
  khadem_alharamain:     'apply.s3.opt.khadem_alharamain',
  job_sponsored:         'apply.s3.opt.job_sponsored',
  private_sector:        'apply.s3.opt.private_sector',
  cultural_tourism:      'apply.s3.opt.cultural_tourism',
  companion_student:     'apply.s3.opt.companion_student',
  self_funded:           'apply.s3.opt.self_funded',
  companion_non_student: 'apply.s3.opt.companion_non_student',
};
// University display strings are proper nouns — kept as raw English on
// both sides of the catalog, so a literal map is fine here. apply.html's
// dropdown also leaves them in English.
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
export const STUDY_LEVEL_KEY = {
  PhD:       'apply.s4.opt.phd',
  Masters:   'apply.s4.opt.masters',
  Bachelor:  'apply.s4.opt.bachelor',
  Diploma:   'apply.s4.opt.diploma',
  Language:  'apply.s4.opt.language',
};
export const STUDY_START_KEY = {
  '<6mo':   'apply.s4.opt.started_lt6',
  '6mo-1y': 'apply.s4.opt.started_6mo_1y',
  '>1y':    'apply.s4.opt.started_gt1y',
};
export const GRADUATION_KEY = {
  Jul2027: 'apply.s4.opt.grad_jul2027',
  Dec2027: 'apply.s4.opt.grad_dec2027',
  '2028+': 'apply.s4.opt.grad_2028',
};
export const REFERRAL_KEY = {
  twitter:   'apply.s6.opt.twitter',
  snapchat:  'apply.s6.opt.snapchat',
  instagram: 'apply.s6.opt.instagram',
  whatsapp:  'apply.s6.opt.whatsapp',
  website:   'apply.s6.opt.website',
  friend:    'apply.s6.opt.friend',
};
export const APP_STATUS_COLOR = {
  PendingTriage:       't-y',
  AssignedToCommittee: 't-b',
  InterviewRequested:  't-o',
  Accepted:            't-g',
  Rejected:            't-r',
};

function _resolveKeyMap(map, v, fallback) {
  return map[v] ? t(map[v]) : (v || fallback || '—');
}
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
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${esc(t('ap.apps.empty'))}</td></tr>`;
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
  const statusLabel = APP_STATUS_KEY[a.status] ? t(APP_STATUS_KEY[a.status]) : a.status;
  const isFinal = a.status === 'Accepted' || a.status === 'Rejected';
  const actionTitle = isFinal ? t('ap.apps.row_view_title') : t('ap.apps.row_review_title');
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
      <button class="btn-icon" title="${esc(actionTitle)}" data-action="openApplicationReview" data-id="${esc(a.application_id)}">${isFinal ? '👁️' : '✏️'}</button>
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
  const otherLabel = t('ap.apps.other_label');
  const scholarship = a.scholarship_entity === 'other'
    ? (a.scholarship_entity_other || otherLabel)
    : _resolveKeyMap(SCHOLARSHIP_KEY, a.scholarship_entity);
  const university = a.university === 'other'
    ? (a.university_other || otherLabel)
    : (UNIVERSITY_LABELS[a.university] || a.university || '—');
  const studyLevel   = _resolveKeyMap(STUDY_LEVEL_KEY, a.study_level);
  const studyStarted = _resolveKeyMap(STUDY_START_KEY, a.study_started_window);
  const expectedGrad = _resolveKeyMap(GRADUATION_KEY, a.expected_graduation_window);
  const referral = a.referral_source === 'other'
    ? (a.referral_source_other || otherLabel)
    : _resolveKeyMap(REFERRAL_KEY, a.referral_source);

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

    ${block(t('ap.apps.section_identity'), [
      [t('ap.apps.lbl_nid'),    a.national_id ? `<span dir="ltr">${esc(a.national_id)}</span>` : ''],
      [t('ap.apps.lbl_gender'), esc(a.gender)],
      [t('ap.apps.lbl_dob'),    fmtDate(a.date_of_birth)],
    ])}

    ${block(t('ap.apps.section_contact'), [
      [t('ap.apps.lbl_email'),    a.email    ? `<span dir="ltr">${esc(a.email)}</span>` : ''],
      [t('ap.apps.lbl_phone'),    a.phone    ? `<span dir="ltr">📱 ${esc(phone)}</span>` : ''],
      [t('ap.apps.lbl_whatsapp'), a.whatsapp ? `<span dir="ltr">💬 ${esc(whatsapp)}</span>` : ''],
      [t('ap.apps.lbl_address'),  esc(a.address_melbourne)],
    ])}

    ${block(t('ap.apps.section_study'), [
      [t('ap.apps.lbl_scholar'),       esc(scholarship)],
      [t('ap.apps.lbl_level'),         esc(studyLevel)],
      [t('ap.apps.lbl_major'),         esc(a.degree_field || a.major)],
      [t('ap.apps.lbl_uni'),           esc(university)],
      [t('ap.apps.lbl_study_started'), esc(studyStarted)],
      [t('ap.apps.lbl_grad_expected'), esc(expectedGrad)],
    ])}

    ${block(t('ap.apps.section_about'), [
      [t('ap.apps.lbl_committees'), interests],
      [t('ap.apps.lbl_skills'),     a.skills_hobbies ? esc(a.skills_hobbies).replace(/\n/g, '<br>') : ''],
      [t('ap.apps.lbl_about_self'), (a.about_self || a.pitch) ? esc(a.about_self || a.pitch).replace(/\n/g, '<br>') : ''],
      [t('ap.apps.lbl_cv'),         a.cv_url ? `<a href="${esc(a.cv_url)}" target="_blank" rel="noopener" dir="ltr" style="color:var(--g);text-decoration:underline">${esc(t('ap.apps.cv_open_link'))}</a>` : ''],
    ])}

    ${block(t('ap.apps.section_extras'), [
      [t('ap.apps.lbl_referral'),    esc(referral)],
      [t('ap.apps.lbl_suggestions'), a.suggestions ? esc(a.suggestions).replace(/\n/g, '<br>') : ''],
    ])}

    <div style="margin-top:.7rem;padding-top:.6rem;border-top:1px solid #e5e7eb;font-size:.74rem;color:var(--tm)">
      ${esc(t('ap.apps.detail_app_id'))}: <span dir="ltr">${esc(a.application_id)}</span> · ${esc(t('ap.apps.detail_date'))}: ${fmtDate(a.created_at)}
      ${a.decided_at ? ` · ${esc(t('ap.apps.detail_decided'))} ${fmtDate(a.decided_at)}` : ''}
      ${a.created_member_id ? ` · ${esc(t('ap.apps.detail_member'))}: <span dir="ltr">${esc(a.created_member_id)}</span>` : ''}
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
    sel.innerHTML = `<option value="">${esc(t('ap.apps.triage_choose'))}</option>` + DB.committees.map(c =>
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
  if (!committeeId) { toast(t('ap.apps.err_pick_committee'), 'twarn'); return; }
  const res = await api('applications.assignCommittee', {
    id: _activeApplication.application_id, committee_id: committeeId,
  });
  if (res && res.success) {
    toast(t('ap.apps.success_triage'));
    closeModal('application');
    loadApplications();
  }
}

export async function appAccept() {
  if (!_activeApplication) return;
  const note = gv('app-decision-note');
  const res = await api('applications.accept', { id: _activeApplication.application_id, note });
  if (res && res.success) {
    toast(t('ap.apps.success_accept', { id: (res.data ? res.data.member_id : '') }));
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
    toast(t('ap.apps.success_interview'));
    closeModal('application');
    loadApplications();
  }
}

export async function appReject() {
  if (!_activeApplication) return;
  const reason = prompt(t('ap.apps.prompt_reject'), gv('app-decision-note') || '');
  if (reason === null) return;
  const res = await api('applications.reject', { id: _activeApplication.application_id, reason });
  if (res && res.success) {
    toast(t('ap.apps.success_reject'));
    closeModal('application');
    loadApplications();
  }
}
