// Hours tab — member portal (Phase 5c of Branch 4).
//
// Calls hours.listOwn (added in 5a). Renders a single table sorted by
// recorded_at DESC, with a status badge per row + a header pill showing
// the total of FinalApproved hours (matches members.total_hours but
// computed client-side so a member sees their pending hours separately).

import { api } from '../../lib/ui.js';
import { esc, fmtDate } from '../../lib/format.js';
import { t } from '../../lib/i18n.js';

// Status labels resolved through t() — translation key per enum value.
// Same data flowing as before; only the lookup path changes.
const STATUS_KEY = {
  Draft:           'mp.hours.status_draft',
  PrimaryApproved: 'mp.hours.status_primary',
  FinalApproved:   'mp.hours.status_final',
  Rejected:        'mp.hours.status_rejected',
};
const STATUS_CLASS = {
  Draft:           'hs-draft',
  PrimaryApproved: 'hs-primaryapproved',
  FinalApproved:   'hs-finalapproved',
  Rejected:        'hs-rejected',
};

export async function loadHours() {
  const tbody = document.getElementById('hours-tbody');
  const pill  = document.getElementById('hours-total-pill');
  if (!tbody) return;
  tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${esc(t('common.loading'))}</td></tr>`;

  const res = await api('hours.listOwn');
  if (!res || !res.success) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5" style="color:var(--dn)">${esc(t('mp.hours.err_load'))}</td></tr>`;
    return;
  }
  const rows = res.data || [];

  // FinalApproved-only sum mirrors members.total_hours computed
  // server-side. Pill HTML stays identical in shape so styles match.
  const finalApprovedTotal = rows
    .filter(r => r.approval_status === 'FinalApproved')
    .reduce((s, r) => s + (parseFloat(r.total_hours) || 0), 0);
  if (pill) {
    pill.innerHTML = `${esc(t('mp.hours.total_label'))} <strong>${finalApprovedTotal.toFixed(1)}</strong> ${esc(t('mp.hours.hours_unit'))}`;
  }

  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5" style="color:var(--tm)">${esc(t('mp.hours.empty'))}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const statusLabel = STATUS_KEY[r.approval_status]
      ? t(STATUS_KEY[r.approval_status])
      : (r.approval_status || '');
    // 2026-05-20: rows can come from the attendance tab (meetings or
    // project attendance the head credited inline) — show the meeting
    // title when there's no project name, and add a small meeting
    // badge so the member knows where the hours came from.
    // 2026-05-21: hours table is the single canonical source. Rows that
    // were auto-created from a meeting attendance carry a notes prefix
    // of `auto:meeting:`. The check below replaces the old
    // `source === 'attendance'` signal (which is gone with the UNION).
    const isAttendanceRow = (r.notes || '').startsWith('auto:meeting:');
    const projectName = r.project_name || (isAttendanceRow ? r.meeting_title : null);
    const projectCell = projectName
      ? `${esc(projectName)}${isAttendanceRow ? ` <span style="font-size:.65rem;color:var(--bl)">${esc(t('ap.att.badge_meeting'))}</span>` : ''}`
      : (r.project_id || '—');
    const dateValue = r.event_date || r.meeting_date || r.recorded_at;
    return `
    <tr>
      <td>${projectCell}</td>
      <td>${esc(r.opportunity_role_name) || '—'}</td>
      <td>${fmtDate(dateValue) || '—'}</td>
      <td><strong>${r.total_hours || 0}</strong></td>
      <td><span class="hs-badge ${STATUS_CLASS[r.approval_status] || ''}">${esc(statusLabel)}</span></td>
    </tr>
  `;
  }).join('');
}
