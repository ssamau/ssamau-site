// Head's "الفرص التطوعية" tab — list opportunities owned by the head's
// committee. Read-mostly for the MVP — creation + cancellation still
// happens via admin.html until the head portal grows its own forms.

import { esc, fmtDate, tag } from '../../lib/format.js';
import { api } from '../../lib/ui.js';

const STATUS_AR = {
  Open:      'مفتوحة',
  Filled:    'مكتملة',
  NeedsHelp: 'تحتاج مساعدة',
  Cancelled: 'ملغاة',
  Done:      'منتهية',
};
const STATUS_CLS = {
  Open:      't-b',
  Filled:    't-g',
  NeedsHelp: 't-y',
  Cancelled: 't-gr',
  Done:      't-gr',
};

export async function loadHeadOpportunities() {
  const tbody = document.getElementById('hd-opps-tbody');
  if (!tbody) return;
  const params = {};
  const cid = window.CURRENT_USER?.committee_id;
  if (cid) params.committee_id = cid;
  const res = await api('opportunities.list', params);
  if (!res || !res.success) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">⚠️ تعذّر تحميل الفرص</td></tr>';
    return;
  }
  const opps = res.data || [];
  if (!opps.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">لا توجد فرص في لجنتك بعد</td></tr>';
    return;
  }
  tbody.innerHTML = opps.map(o => {
    const proj = o.project_name
      ? `<div>${esc(o.project_name)}</div>
         ${o.event_date ? `<div style="font-size:.7rem;color:var(--tm)">${fmtDate(o.event_date)}</div>` : ''}`
      : `<span style="color:var(--tm)">${esc(o.project_id || '—')}</span>`;
    const status = tag(STATUS_AR[o.status] || o.status || '—', STATUS_CLS[o.status] || 't-gr');
    const filled = `${o.attended_count || 0}/${o.headcount_needed || 0}`;
    return `<tr>
      <td><strong>${esc(o.role_name || '—')}</strong></td>
      <td>${proj}</td>
      <td>${esc((o.estimated_hours || 0) + ' ساعة')}</td>
      <td>${esc(filled)}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
}
