// Head's "أعضاء اللجنة" tab — read-only roster of the head's own
// committee. `getMembers` is auto-scoped server-side for heads so we
// don't need to pass any filter.

import { esc } from '../../lib/format.js';
import { api } from '../../lib/ui.js';

const CLUB_ROLE_AR = {
  'President':          'رئيس النادي',
  'Vice President':     'نائب الرئيس',
  'Committee Head':     'رئيس اللجنة',
  'Committee Vice Head':'نائب رئيس اللجنة',
  'Deputy Vice Head':   'مساعد نائب رئيس اللجنة',
  'Member':             'عضو',
};

export async function loadHeadMembers() {
  const res = await api('getMembers');
  const tbody = document.getElementById('hd-members-tbody');
  if (!tbody) return;
  if (!res || !res.success) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">⚠️ تعذّر تحميل قائمة الأعضاء</td></tr>';
    return;
  }
  // `getMembers` is public + unscoped (admin's UI also filters client-side
  // via RBAC.filterMembers). For heads we just want members of their own
  // committee — committee_id match, no leadership-tier inclusion.
  const myCommittee = window.CURRENT_USER?.committee_id;
  const members = (res.data || [])
    .filter(m => m.status !== 'Inactive')
    .filter(m => myCommittee ? m.committee_id === myCommittee : true);
  if (!members.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">لا يوجد أعضاء في لجنتك بعد</td></tr>';
    return;
  }
  // Sort: leadership-roles first, then by name.
  members.sort((a, b) => {
    const rank = r => ({
      'Committee Head': 0,
      'Committee Vice Head': 1,
      'Deputy Vice Head': 2,
      'Member': 3,
    }[r] ?? 4);
    const ra = rank(a.club_role), rb = rank(b.club_role);
    return ra !== rb ? ra - rb : (a.full_name || '').localeCompare(b.full_name || '', 'ar');
  });
  tbody.innerHTML = members.map(m => {
    const name = esc(m.preferred_name || m.full_name || '—');
    const role = esc(CLUB_ROLE_AR[m.club_role] || m.club_role || '—');
    const uni  = [m.university, m.major].filter(Boolean).map(esc).join(' / ') || '—';
    const hrs  = m.total_hours != null ? `${m.total_hours} ساعة` : '—';
    const stat = m.status === 'Active'
      ? '<span class="tag t-g">نشط</span>'
      : `<span class="tag t-gr">${esc(m.status || '—')}</span>`;
    return `<tr>
      <td><strong>${name}</strong></td>
      <td>${role}</td>
      <td style="color:var(--tm);font-size:.85rem">${uni}</td>
      <td>${esc(hrs)}</td>
      <td>${stat}</td>
    </tr>`;
  }).join('');
}
