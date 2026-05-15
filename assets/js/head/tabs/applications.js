// Head's "طلبات الانضمام" tab — applications routed to the head's
// committee (plus untriaged ones, per applications.list head-scoping).
// Inline accept / reject so the head closes the loop without leaving
// the page.

import { esc, fmtDate, tag } from '../../lib/format.js';
import { api, toast } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';

// Application status enum (canonical English) → translation key.
// InterviewRequested vs AwaitingInterview: dashboard summary uses the
// latter; the applications endpoint emits the former. Both surface as
// the same user-facing label here.
const STATUS_KEY = {
  PendingTriage:       'hp.apps.status_pending_triage',
  AssignedToCommittee: 'hp.apps.status_assigned',
  InterviewRequested:  'hp.apps.status_interview',
  AwaitingInterview:   'hp.apps.status_interview',
  Accepted:            'hp.apps.status_accepted',
  Rejected:            'hp.apps.status_rejected',
};
const STATUS_CLS = {
  PendingTriage:       't-y',
  AssignedToCommittee: 't-b',
  InterviewRequested:  't-y',
  AwaitingInterview:   't-y',
  Accepted:            'tok',
  Rejected:            't-r',
};

export async function loadHeadApplications() {
  const tbody = document.getElementById('hd-apps-tbody');
  if (!tbody) return;
  const res = await api('applications.list');
  if (!res || !res.success) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${esc(t('hp.apps.err_load'))}</td></tr>`;
    return;
  }
  // The server lets heads see "PendingTriage" applications too — that's
  // intentional for presidency triage, but for the head's own queue we
  // only care about applications actually routed to THEIR committee.
  // Pending-triage stays in presidency's queue (admin.html).
  const myCommittee = window.CURRENT_USER?.committee_id;
  const apps = (res.data || []).filter(a =>
    a.assigned_committee_id && (!myCommittee || a.assigned_committee_id === myCommittee),
  );
  if (!apps.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${esc(t('hp.apps.empty'))}</td></tr>`;
    return;
  }
  // Pending first.
  apps.sort((a, b) => {
    const rank = s => (s === 'Accepted' || s === 'Rejected' ? 1 : 0);
    const ra = rank(a.status), rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
  tbody.innerHTML = apps.map(_renderRow).join('');
}

function _renderRow(a) {
  const name = esc(a.preferred_name || a.full_name || '—');
  const uni = [a.university, a.major].filter(Boolean).map(esc).join(' / ') || '—';
  // fmtDate already returns safe HTML (<span dir="ltr">...</span>) — don't
  // double-escape it. Same fix for the dashboard's queue rows.
  const when = fmtDate(a.created_at) || '<span style="color:var(--tm)">—</span>';
  const statusLabel = STATUS_KEY[a.status] ? t(STATUS_KEY[a.status]) : (a.status || '—');
  const statusTag = tag(statusLabel, STATUS_CLS[a.status] || 't-gr');
  // Per §6 of the requirements, heads have three options on a routed
  // application: accept directly, reject with reason, OR request an
  // interview before deciding. The interview button is only shown when
  // an interview hasn't already been requested — re-requesting is a
  // no-op clutter, just go through accept/reject after the interview.
  const actions = [];
  const isPending = a.status !== 'Accepted' && a.status !== 'Rejected';
  if (isPending) {
    actions.push(`<button class="btn-icon" title="${esc(t('hp.apps.action_accept'))}" data-action="hd.apps.accept" data-id="${a.application_id}">✅</button>`);
    if (a.status !== 'InterviewRequested' && a.status !== 'AwaitingInterview') {
      actions.push(`<button class="btn-icon" title="${esc(t('hp.apps.action_request_interview'))}" data-action="hd.apps.requestInterview" data-id="${a.application_id}">💬</button>`);
    }
    actions.push(`<button class="btn-icon" title="${esc(t('hp.apps.action_reject'))}" data-action="hd.apps.reject" data-id="${a.application_id}">❌</button>`);
  }
  return `<tr>
    <td><strong>${name}</strong><div style="font-size:.7rem;color:var(--tm)">${esc(a.email || '')}</div></td>
    <td style="color:var(--tm);font-size:.85rem">${uni}</td>
    <td>${when}</td>
    <td>${statusTag}</td>
    <td>${actions.join(' ') || '<span style="color:var(--tm)">—</span>'}</td>
  </tr>`;
}

export async function requestInterview(id) {
  const note = prompt(t('hp.apps.prompt_interview'));
  if (note === null) return;   // user cancelled
  const res = await api('applications.requestInterview', { id, note: note || undefined });
  if (res && res.success) {
    toast(t('hp.apps.success_interview'));
    loadHeadApplications();
  }
}

export async function acceptApplication(id) {
  if (!confirm(t('hp.apps.confirm_accept'))) return;
  const res = await api('applications.accept', { id });
  if (res && res.success) {
    toast(t('hp.apps.success_accept'));
    loadHeadApplications();
  }
}

export async function rejectApplication(id) {
  const reason = prompt(t('hp.apps.prompt_reject'));
  if (reason === null) return;
  const res = await api('applications.reject', { id, reason: reason || undefined });
  if (res && res.success) {
    toast(t('hp.apps.success_reject'));
    loadHeadApplications();
  }
}
