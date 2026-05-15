// Head's "طلبات الانضمام" tab — applications routed to the head's
// committee (plus untriaged ones, per applications.list head-scoping).
// Inline accept / reject so the head closes the loop without leaving
// the page.

import { esc, fmtDate, tag } from '../../lib/format.js';
import { api, toast } from '../../lib/ui.js';

const STATUS_AR = {
  PendingTriage:       'بانتظار التوجيه',
  AssignedToCommittee: 'موجّه للجنتك',
  AwaitingInterview:   'بانتظار مقابلة',
  Accepted:            'مقبول',
  Rejected:            'مرفوض',
};
const STATUS_CLS = {
  PendingTriage:       't-y',
  AssignedToCommittee: 't-b',
  AwaitingInterview:   't-b',
  Accepted:            'tok',
  Rejected:            't-r',
};

export async function loadHeadApplications() {
  const tbody = document.getElementById('hd-apps-tbody');
  if (!tbody) return;
  const res = await api('applications.list');
  if (!res || !res.success) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">⚠️ تعذّر تحميل الطلبات</td></tr>';
    return;
  }
  const apps = res.data || [];
  if (!apps.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">لا توجد طلبات بعد</td></tr>';
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
  const when = fmtDate(a.created_at) || '—';
  const statusTag = tag(STATUS_AR[a.status] || a.status || '—', STATUS_CLS[a.status] || 't-gr');
  const actions = [];
  const isPending = a.status !== 'Accepted' && a.status !== 'Rejected';
  if (isPending) {
    actions.push(`<button class="btn-icon" title="قبول" data-action="hd.apps.accept" data-id="${a.application_id}">✅</button>`);
    actions.push(`<button class="btn-icon" title="رفض" data-action="hd.apps.reject" data-id="${a.application_id}">❌</button>`);
  }
  return `<tr>
    <td><strong>${name}</strong><div style="font-size:.7rem;color:var(--tm)">${esc(a.email || '')}</div></td>
    <td style="color:var(--tm);font-size:.85rem">${uni}</td>
    <td>${esc(when)}</td>
    <td>${statusTag}</td>
    <td>${actions.join(' ') || '<span style="color:var(--tm)">—</span>'}</td>
  </tr>`;
}

export async function acceptApplication(id) {
  if (!confirm('قبول هذا الطلب؟ سيُنشأ حساب عضو جديد بشكل تلقائي.')) return;
  const res = await api('applications.accept', { id });
  if (res && res.success) {
    toast('✅ تم قبول الطلب');
    loadHeadApplications();
  }
}

export async function rejectApplication(id) {
  const reason = prompt('سبب الرفض (يُرسل للمتقدم في إيميل الرفض):');
  if (reason === null) return;
  const res = await api('applications.reject', { id, reason: reason || undefined });
  if (res && res.success) {
    toast('تم رفض الطلب');
    loadHeadApplications();
  }
}
