// Participants tab — who said they'd come to which project (member or
// external volunteer). The form toggles between two field groups depending
// on participant_type; toggleParticipantFields is wired to the dropdown
// onchange in admin.html.

import { DB, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, tag } from '../../lib/format.js';
import { api, toast, closeModal } from '../../lib/ui.js';

// ══════════════════════════════════════════
// PARTICIPANTS
// ══════════════════════════════════════════
export async function loadParticipants(projectId) {
  const params = projectId ? { project_id: projectId } : {};
  const data = await api('getParticipants', params);
  if (!data || !data.success) return;
  const tbody = document.getElementById('participants-tbody');
  const items = data.data || [];
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">لا يوجد مشاركون بعد</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(p => {
    const member  = DB.members.find(m  => m.member_id  === p.member_id);
    const project = DB.projects.find(x => x.project_id === p.project_id);
    const name = p.participant_type === 'Member'
      ? (member ? esc(member.preferred_name || member.full_name) : p.member_id)
      : esc(p.volunteer_name);
    const projectCell = project
      ? `<div style="font-weight:600">${esc(project.project_name)}</div>
         <div style="font-size:.7rem;color:var(--tm)">${tag(project.project_type, project.project_type === 'Project' ? 't-b' : 't-p')}</div>`
      : `<span style="color:var(--tm)">${esc(p.project_id)}</span>`;
    return `<tr>
      <td>
        <div style="font-weight:700">${name}</div>
        ${p.participant_type === 'Volunteer' ? `<div style="font-size:.72rem;color:var(--tm);direction:ltr">${esc(p.volunteer_email)}</div>` : ''}
      </td>
      <td>${projectCell}</td>
      <td>${tag(p.participant_type, p.participant_type === 'Member' ? 't-b' : 't-p')}</td>
      <td>${tag(p.participation_status, STATUS_COLORS[p.participation_status] || 't-gr')}</td>
      <td><span class="tag t-gr">${esc(p.availability_type)}</span></td>
      <td>${p.outstanding_flag === 'true' || p.outstanding_flag === true ? '⭐' : '—'}</td>
      <td>
        <button class="btn-icon del" onclick="confirmDelete('participant','${p.participant_id}','هذا المشارك')">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

export async function saveParticipant() {
  const body = {
    project_id:         gv('par-project'),
    participant_type:   gv('par-type'),
    member_id:          gv('par-member'),
    volunteer_name:     gv('par-vol-name'),
    volunteer_email:    gv('par-vol-email'),
    volunteer_phone:    gv('par-vol-phone'),
    participation_status: gv('par-status'),
    availability_type:  gv('par-avail'),
    manager_notes:      gv('par-notes'),
    outstanding_flag:   document.getElementById('par-outstanding').checked,
  };
  if (!body.project_id) { toast('اختر مشروعاً', 'twarn'); return; }
  const res = await api('addParticipant', body);
  if (res) {
    toast('✅ تم إضافة المشارك');
    closeModal('participant');
    if (document.getElementById('participants-project-filter').value === body.project_id) {
      loadParticipants(body.project_id);
    }
  }
}

export function toggleParticipantFields() {
  const type = gv('par-type');
  document.getElementById('par-member-section').style.display   = type === 'Member' ? '' : 'none';
  document.getElementById('par-volunteer-section').style.display = type === 'Volunteer' ? '' : 'none';
}
