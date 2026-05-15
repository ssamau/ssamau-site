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
import { t } from '../../lib/i18n.js';

// Club-role + status enum → translation key. Mirrors the maps in
// members.js so the profile hero shows localized role + status tag.
const CLUB_ROLE_KEY = {
  'President':           'ap.role.president',
  'Vice President':      'ap.role.vice_president',
  'Deputy Vice Head':    'ap.role.deputy_vice_head',
  'Committee Head':      'ap.role.committee_head',
  'Committee Vice Head': 'ap.role.committee_vice_head',
  'Project Manager':     'ap.role.project_manager',
  'Event Manager':       'ap.role.event_manager',
  'Member':              'ap.role.member',
  'Volunteer':           'ap.role.volunteer',
};
const STATUS_KEY = {
  Active:   'ap.status.active',
  Inactive: 'ap.status.inactive',
};

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
  const roleLabel   = CLUB_ROLE_KEY[member.club_role] ? t(CLUB_ROLE_KEY[member.club_role]) : (member.club_role || '');
  const statusLabel = STATUS_KEY[member.status]       ? t(STATUS_KEY[member.status])       : (member.status     || '');
  content.innerHTML = `
    <div class="profile-hero">
      <div class="profile-avatar">${(member.preferred_name || member.full_name).charAt(0)}</div>
      <div>
        <div class="profile-name">${esc(member.preferred_name || member.full_name)}</div>
        <div style="font-size:.78rem;color:rgba(255,255,255,.7);margin-top:.15rem">${esc(member.full_name)}</div>
        <div class="profile-role">${esc(roleLabel)} ${com ? '· ' + esc(com.committee_name) : ''}</div>
        <div style="font-size:.72rem;color:rgba(255,255,255,.5);direction:ltr;margin-top:.2rem">${esc(member.email)}</div>
      </div>
    </div>
    <div class="profile-stats">
      <div class="profile-stat"><div class="pn">${totalHours.toFixed(1)}</div><div class="pl">${esc(t('ap.prf.stat_hours'))}</div></div>
      <div class="profile-stat"><div class="pn">${projectsParticipated}</div><div class="pl">${esc(t('ap.prf.stat_projects'))}</div></div>
      <div class="profile-stat"><div class="pn">${tag(statusLabel, STATUS_COLORS[member.status] || 't-gr')}</div><div class="pl">${esc(t('ap.prf.stat_status'))}</div></div>
      <div class="profile-stat"><div class="pn" style="font-size:1rem">${fmtDate(member.join_date) || '—'}</div><div class="pl">${esc(t('ap.prf.stat_join_date'))}</div></div>
    </div>
    ${hours.length ? `
    <div class="card">
      <div class="card-head"><h3>${esc(t('ap.prf.hours_history_card'))}</h3></div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>${esc(t('ap.prf.col_project'))}</th>
          <th>${esc(t('ap.prf.col_before'))}</th>
          <th>${esc(t('ap.prf.col_during'))}</th>
          <th>${esc(t('ap.prf.col_after'))}</th>
          <th>${esc(t('ap.prf.col_total'))}</th>
          <th>${esc(t('ap.prf.col_notes'))}</th>
        </tr></thead>
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
    </div>` : `<div style="color:var(--tm);text-align:center;padding:2rem">${esc(t('ap.prf.empty_hours'))}</div>`}`;
}

export function viewProfile(memberId) {
  showPage('profile');
  sv('profile-member-select', memberId);
  loadMemberProfile(memberId);
}
