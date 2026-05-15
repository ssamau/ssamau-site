// Head's "الساعات" tab — list hours for the head's committee and let
// the head primary-approve or reject Draft rows. Final approval stays
// with the presidency per the §7 two-stage flow.

import { esc, fmtDate, tag } from '../../lib/format.js';
import { api, toast } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';

// Status enum (canonical English from DB) → translation key + chip class.
// Reuses mp.hours.status_* — the labels are identical regardless of who
// is viewing the row.
const STATUS_KEY = {
  Draft:           'mp.hours.status_draft',
  PrimaryApproved: 'mp.hours.status_primary',
  FinalApproved:   'mp.hours.status_final',
  Rejected:        'mp.hours.status_rejected',
};
const STATUS_CLS = {
  Draft:           't-y',
  PrimaryApproved: 't-b',
  FinalApproved:   'tok',
  Rejected:        't-r',
};

export async function loadHeadHours() {
  const tbody = document.getElementById('hd-hours-tbody');
  if (!tbody) return;
  const res = await api('getMemberHours');
  if (!res || !res.success) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${esc(t('hp.hours.err_load'))}</td></tr>`;
    return;
  }
  const items = res.data || [];
  if (!items.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${esc(t('hp.hours.empty'))}</td></tr>`;
    return;
  }
  // Sort Draft first (head's queue), then by recorded_at desc.
  items.sort((a, b) => {
    const rank = s => (s === 'Draft' ? 0 : 1);
    const ra = rank(a.approval_status), rb = rank(b.approval_status);
    if (ra !== rb) return ra - rb;
    return String(b.recorded_at).localeCompare(String(a.recorded_at));
  });
  tbody.innerHTML = items.map(_renderRow).join('');
}

function _renderRow(h) {
  const name = esc(h.member_preferred_name || h.member_full_name || h.member_id || '—');
  const proj = h.project_name
    ? `<div>${esc(h.project_name)}</div>
       ${h.opportunity_role_name ? `<div style="font-size:.7rem;color:var(--tm)">${esc(h.opportunity_role_name)}</div>` : ''}`
    : `<span style="color:var(--tm)">${esc(h.project_id || '—')}</span>`;
  const status = h.approval_status || 'Draft';
  const statusLabel = STATUS_KEY[status] ? t(STATUS_KEY[status]) : status;
  const statusTag = tag(statusLabel, STATUS_CLS[status] || 't-gr');
  const rowId = h.hours_id || h.id;
  // Heads now own all three approval stages (primary, final, rollback)
  // for their committee — per 2026-05-16 permission revision. Different
  // buttons per status, all gated server-side via requireAdminScope.
  const actions = [];
  if (status === 'Draft') {
    actions.push(`<button class="btn-icon" title="${esc(t('hp.hours.action_primary'))}" data-action="hd.hours.primaryApprove" data-id="${rowId}">✅</button>`);
    actions.push(`<button class="btn-icon" title="${esc(t('hp.hours.action_reject'))}" data-action="hd.hours.reject" data-id="${rowId}">❌</button>`);
  } else if (status === 'PrimaryApproved') {
    actions.push(`<button class="btn-icon" title="${esc(t('hp.hours.action_final'))}" data-action="hd.hours.finalApprove" data-id="${rowId}">✅</button>`);
    actions.push(`<button class="btn-icon" title="${esc(t('hp.hours.action_reject'))}" data-action="hd.hours.reject" data-id="${rowId}">❌</button>`);
  } else if (status === 'FinalApproved') {
    actions.push(`<button class="btn-icon" title="${esc(t('hp.hours.action_rollback'))}" data-action="hd.hours.reject" data-id="${rowId}">↩️</button>`);
  }
  return `<tr>
    <td><strong>${name}</strong></td>
    <td>${proj}</td>
    <td>${esc((h.total_hours ?? 0) + ' ' + t('mp.hours.hours_unit'))}</td>
    <td>${statusTag}</td>
    <td>${actions.join(' ') || '<span style="color:var(--tm)">—</span>'}</td>
  </tr>`;
}

export async function primaryApproveHours(id) {
  if (!confirm(t('hp.hours.confirm_primary'))) return;
  const res = await api('hours.primaryApprove', { id: Number(id) });
  if (res && res.success) {
    toast(t('hp.hours.success_primary'));
    loadHeadHours();
  }
}

export async function finalApproveHours(id) {
  if (!confirm(t('hp.hours.confirm_final'))) return;
  const res = await api('hours.finalApprove', { id: Number(id) });
  if (res && res.success) {
    toast(t('hp.hours.success_final'));
    loadHeadHours();
  }
}

export async function rejectHours(id) {
  const reason = prompt(t('hp.hours.prompt_reject'));
  if (reason === null) return;   // user cancelled
  const res = await api('hours.reject', { id: Number(id), reason: reason || undefined });
  if (res && res.success) {
    toast(t('hp.hours.success_reject'));
    loadHeadHours();
  }
}
