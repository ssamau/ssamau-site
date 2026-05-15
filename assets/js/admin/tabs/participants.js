// Participants tab — who said they'd come to which project (member or
// external volunteer). The form toggles between two field groups depending
// on participant_type; toggleParticipantFields is wired to the dropdown
// onchange in admin.html.

import { DB, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, tag } from '../../lib/format.js';
import { api, toast, closeModal } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';

// Participant type / status / availability enums → translation keys.
// Project type label reuses the projects-module key map (kept inline
// here to avoid a cross-tab import for two constants).
const PROJECT_TYPE_KEY = {
  Event:   'ap.prj.type_event',
  Project: 'ap.prj.type_project',
};
const PAR_TYPE_KEY = {
  Member:    'ap.par.type_member',
  Volunteer: 'ap.par.type_volunteer',
};
const PAR_STATUS_KEY = {
  Confirmed: 'ap.par.status_confirmed',
  Pending:   'ap.par.status_pending',
  Cancelled: 'ap.par.status_cancelled',
};
const PAR_AVAIL_KEY = {
  Full:    'ap.par.avail_full',
  Partial: 'ap.par.avail_partial',
};

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
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(t('ap.par.empty'))}</td></tr>`;
    return;
  }
  const deleteTargetName = t('ap.par.delete_target_name');
  tbody.innerHTML = items.map(p => {
    const member  = DB.members.find(m  => m.member_id  === p.member_id);
    const project = DB.projects.find(x => x.project_id === p.project_id);
    const name = p.participant_type === 'Member'
      ? (member ? esc(member.preferred_name || member.full_name) : p.member_id)
      : esc(p.volunteer_name);
    const projectTypeLabel = project && PROJECT_TYPE_KEY[project.project_type]
      ? t(PROJECT_TYPE_KEY[project.project_type])
      : project?.project_type || '';
    const projectCell = project
      ? `<div style="font-weight:600">${esc(project.project_name)}</div>
         <div style="font-size:.7rem;color:var(--tm)">${tag(projectTypeLabel, project.project_type === 'Project' ? 't-b' : 't-p')}</div>`
      : `<span style="color:var(--tm)">${esc(p.project_id)}</span>`;
    const parTypeLabel   = PAR_TYPE_KEY[p.participant_type]      ? t(PAR_TYPE_KEY[p.participant_type])      : p.participant_type;
    const parStatusLabel = PAR_STATUS_KEY[p.participation_status]? t(PAR_STATUS_KEY[p.participation_status]): p.participation_status;
    const availLabel     = PAR_AVAIL_KEY[p.availability_type]    ? t(PAR_AVAIL_KEY[p.availability_type])    : p.availability_type;
    return `<tr>
      <td>
        <div style="font-weight:700">${name}</div>
        ${p.participant_type === 'Volunteer' ? `<div style="font-size:.72rem;color:var(--tm);direction:ltr">${esc(p.volunteer_email)}</div>` : ''}
      </td>
      <td>${projectCell}</td>
      <td>${tag(parTypeLabel, p.participant_type === 'Member' ? 't-b' : 't-p')}</td>
      <td>${tag(parStatusLabel, STATUS_COLORS[p.participation_status] || 't-gr')}</td>
      <td><span class="tag t-gr">${esc(availLabel)}</span></td>
      <td>${p.outstanding_flag === 'true' || p.outstanding_flag === true ? '⭐' : '—'}</td>
      <td>
        <button class="btn-icon del" data-action="confirmDelete" data-type="participant" data-id="${p.participant_id}" data-name="${esc(deleteTargetName)}">🗑️</button>
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
  if (!body.project_id) { toast(t('ap.par.err_pick_project'), 'twarn'); return; }
  const res = await api('addParticipant', body);
  if (res) {
    toast(t('ap.par.success_add'));
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
