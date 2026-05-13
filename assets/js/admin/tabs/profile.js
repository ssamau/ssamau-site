// Member profile tab — picker at the top, hero card + stats + hours table
// for the selected member.
//
// loadProfileSelect is the tab's loader (called by the router). It defers
// to populateProfileSelect (in lib/ui.js) once members are loaded, kicking
// off a load if DB.members is still empty (heads landing here as their
// first page, etc.). viewProfile is the cross-tab entry point — called
// from the members table 👤 button — that navigates here and pre-selects
// the right member.

import { DB, STATUS_COLORS } from '../../lib/state.js';
import { esc, sv, tag, fmtDate } from '../../lib/format.js';
import { api, populateProfileSelect } from '../../lib/ui.js';
import { showPage } from '../router.js';
import { loadMembers } from './members.js';

// ══════════════════════════════════════════
// MEMBER PROFILE
// ══════════════════════════════════════════
export function loadProfileSelect() {
  if (!DB.members.length) loadMembers().then(populateProfileSelect);
  else populateProfileSelect();
}

export async function loadMemberProfile(memberId) {
  if (!memberId) return;
  const member = DB.members.find(m => m.member_id === memberId);
  if (!member) return;
  const com = DB.committees.find(c => c.committee_id === member.committee_id);

  // Load this member's hours
  const hoursData = await api('getMemberHours', { member_id: memberId });
  const hours = hoursData?.data || [];
  const totalHours = hours.reduce((s, h) => s + (parseFloat(h.total_hours) || 0), 0);
  const projectsParticipated = new Set(hours.map(h => h.project_id)).size;

  const content = document.getElementById('profile-content');
  content.innerHTML = `
    <div class="profile-hero">
      <div class="profile-avatar">${(member.preferred_name || member.full_name).charAt(0)}</div>
      <div>
        <div class="profile-name">${esc(member.preferred_name || member.full_name)}</div>
        <div style="font-size:.78rem;color:rgba(255,255,255,.7);margin-top:.15rem">${esc(member.full_name)}</div>
        <div class="profile-role">${esc(member.club_role)} ${com ? '· ' + esc(com.committee_name) : ''}</div>
        <div style="font-size:.72rem;color:rgba(255,255,255,.5);direction:ltr;margin-top:.2rem">${esc(member.email)}</div>
      </div>
    </div>
    <div class="profile-stats">
      <div class="profile-stat"><div class="pn">${totalHours.toFixed(1)}</div><div class="pl">ساعة تطوعية</div></div>
      <div class="profile-stat"><div class="pn">${projectsParticipated}</div><div class="pl">مشروع شارك</div></div>
      <div class="profile-stat"><div class="pn">${tag(member.status, STATUS_COLORS[member.status] || 't-gr')}</div><div class="pl">الحالة</div></div>
      <div class="profile-stat"><div class="pn" style="font-size:1rem">${fmtDate(member.join_date) || '—'}</div><div class="pl">تاريخ الانضمام</div></div>
    </div>
    ${hours.length ? `
    <div class="card">
      <div class="card-head"><h3>⏱️ سجل الساعات التطوعية</h3></div>
      <div class="table-wrap"><table>
        <thead><tr><th>المشروع</th><th>قبل</th><th>خلال</th><th>بعد</th><th>الإجمالي</th><th>ملاحظات</th></tr></thead>
        <tbody>${hours.map(h => {
          const prj = DB.projects.find(p => p.project_id === h.project_id);
          return `<tr>
            <td>${prj ? esc(prj.project_name) : h.project_id}</td>
            <td>${h.hours_before || 0}</td><td>${h.hours_during || 0}</td><td>${h.hours_after || 0}</td>
            <td><strong style="color:var(--g)">${h.total_hours || 0}</strong></td>
            <td style="font-size:.76rem">${esc(h.notes) || '—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>` : '<div style="color:var(--tm);text-align:center;padding:2rem">لا توجد ساعات مسجّلة لهذا العضو</div>'}`;
}

export function viewProfile(memberId) {
  showPage('profile');
  sv('profile-member-select', memberId);
  loadMemberProfile(memberId);
}
