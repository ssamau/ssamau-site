// Head's "الساعات" tab — list hours for the head's committee and let
// the head primary-approve or reject Draft rows. Final approval stays
// with the presidency per the §7 two-stage flow.

import { esc, fmtDate, tag } from '../../lib/format.js';
import { api, toast } from '../../lib/ui.js';

const STATUS_AR = {
  Draft:           'مسودة',
  PrimaryApproved: 'اعتماد أولي',
  FinalApproved:   'اعتماد نهائي',
  Rejected:        'مرفوض',
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
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">⚠️ تعذّر تحميل الساعات</td></tr>';
    return;
  }
  const items = res.data || [];
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">لا توجد ساعات مسجّلة لأعضاء لجنتك بعد</td></tr>';
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
  const statusTag = tag(STATUS_AR[status] || status, STATUS_CLS[status] || 't-gr');
  const rowId = h.hours_id || h.id;
  // Heads now own all three approval stages (primary, final, rollback)
  // for their committee — per 2026-05-16 permission revision. Different
  // buttons per status, all gated server-side via requireAdminScope.
  const actions = [];
  if (status === 'Draft') {
    actions.push(`<button class="btn-icon" title="اعتماد أولي" data-action="hd.hours.primaryApprove" data-id="${rowId}">✅</button>`);
    actions.push(`<button class="btn-icon" title="رفض" data-action="hd.hours.reject" data-id="${rowId}">❌</button>`);
  } else if (status === 'PrimaryApproved') {
    actions.push(`<button class="btn-icon" title="اعتماد نهائي" data-action="hd.hours.finalApprove" data-id="${rowId}">✅</button>`);
    actions.push(`<button class="btn-icon" title="رفض" data-action="hd.hours.reject" data-id="${rowId}">❌</button>`);
  } else if (status === 'FinalApproved') {
    actions.push(`<button class="btn-icon" title="رفض / استرجاع" data-action="hd.hours.reject" data-id="${rowId}">↩️</button>`);
  }
  return `<tr>
    <td><strong>${name}</strong></td>
    <td>${proj}</td>
    <td>${esc((h.total_hours ?? 0) + ' ساعة')}</td>
    <td>${statusTag}</td>
    <td>${actions.join(' ') || '<span style="color:var(--tm)">—</span>'}</td>
  </tr>`;
}

export async function primaryApproveHours(id) {
  if (!confirm('اعتماد أولي لهذه الساعات؟')) return;
  const res = await api('hours.primaryApprove', { id: Number(id) });
  if (res && res.success) {
    toast('✅ تم الاعتماد الأولي');
    loadHeadHours();
  }
}

export async function finalApproveHours(id) {
  if (!confirm('اعتماد نهائي لهذه الساعات؟ ستُحتسب لرصيد العضو.')) return;
  const res = await api('hours.finalApprove', { id: Number(id) });
  if (res && res.success) {
    toast('✅ تم الاعتماد النهائي');
    loadHeadHours();
  }
}

export async function rejectHours(id) {
  const reason = prompt('سبب الرفض (اختياري):');
  if (reason === null) return;   // user cancelled
  const res = await api('hours.reject', { id: Number(id), reason: reason || undefined });
  if (res && res.success) {
    toast('تم رفض السجل');
    loadHeadHours();
  }
}
