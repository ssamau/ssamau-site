// Hours tab — member portal (Phase 5c of Branch 4).
//
// Calls hours.listOwn (added in 5a). Renders a single table sorted by
// recorded_at DESC, with a status badge per row + a header pill showing
// the total of FinalApproved hours (matches members.total_hours but
// computed client-side so a member sees their pending hours separately).

import { api } from '../../lib/ui.js';
import { esc, fmtDate } from '../../lib/format.js';

const STATUS_LABEL_AR = {
  Draft:           'مسوّدة',
  PrimaryApproved: 'موافقة أولية',
  FinalApproved:   'معتمدة نهائيًا',
  Rejected:        'مرفوضة',
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
  tbody.innerHTML = '<tr class="empty-row"><td colspan="5">جاري التحميل...</td></tr>';

  const res = await api('hours.listOwn');
  if (!res || !res.success) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5" style="color:var(--dn)">تعذّر التحميل</td></tr>';
    return;
  }
  const rows = res.data || [];

  // FinalApproved-only sum mirrors what the server stores in
  // members.total_hours via recomputeMemberTotalHours().
  const finalApprovedTotal = rows
    .filter(r => r.approval_status === 'FinalApproved')
    .reduce((s, r) => s + (parseFloat(r.total_hours) || 0), 0);
  if (pill) pill.innerHTML = `المجموع المعتمد: <strong>${finalApprovedTotal.toFixed(1)}</strong> ساعة`;

  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5" style="color:var(--tm)">لا توجد ساعات مسجّلة بعد</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${esc(r.project_name) || r.project_id || '—'}</td>
      <td>${esc(r.opportunity_role_name) || '—'}</td>
      <td>${fmtDate(r.event_date || r.recorded_at) || '—'}</td>
      <td><strong>${r.total_hours || 0}</strong></td>
      <td><span class="hs-badge ${STATUS_CLASS[r.approval_status] || ''}">${STATUS_LABEL_AR[r.approval_status] || esc(r.approval_status)}</span></td>
    </tr>
  `).join('');
}
