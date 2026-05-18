// Head's "المشاريع والفعاليات" tab — president's spec 2026-05-18:
// committee heads can add + edit projects scoped to THEIR committee
// only. Admins can still edit head-created projects (the server's
// requireAdminScope already lets admin/superadmin operate on any
// committee). Heads must NOT see/edit projects from other
// committees or admin-managed unscoped ones.
//
// Server-side: no new actions — reuses getProjects, createProject,
// updateProject, deleteProject. requireAdminScope gates committee
// match for heads. Client-side: this module filters the projects
// list to the head's own committee + forces owning_committee_id on
// save.

import { esc, gv, sv, tag, attrJson, fmtDate } from '../../lib/format.js';
import { api, apiGet, toast, openModal, closeModal, clearForm } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';

// Project type + status enums → translation keys. Same maps the admin
// tab uses; duplicated inline so this module doesn't reach into admin/.
const TYPE_KEY = {
  Event:   'ap.prj.type_event',
  Project: 'ap.prj.type_project',
};
const STATUS_KEY = {
  Planning:  'ap.prj.status_planning',
  Active:    'ap.prj.status_active',
  Completed: 'ap.prj.status_completed',
  Cancelled: 'ap.prj.status_cancelled',
};
const STATUS_COLOR = {
  Planning:  't-y',
  Active:    't-g',
  Completed: 't-b',
  Cancelled: 't-gr',
};

let _projects = [];

export async function loadHeadProjects() {
  const tbody = document.getElementById('hd-projects-tbody');
  if (!tbody) return;
  const myCom = window.CURRENT_USER?.committee_id || null;
  const res = await apiGet('getProjects');
  if (!res || !res.success) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('hp.proj.err_load'))}</td></tr>`;
    return;
  }
  // Scope to the head's own committee. Server returns the full list
  // (getProjects is unscoped for read), so we filter here. Admin-
  // owned / unscoped projects are intentionally hidden — heads
  // shouldn't see those in their management view.
  _projects = (res.data || []).filter(p => p.owning_committee_id === myCom);
  _render();
}

function _render() {
  const tbody = document.getElementById('hd-projects-tbody');
  if (!tbody) return;
  if (!_projects.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('hp.proj.empty'))}</td></tr>`;
    return;
  }
  tbody.innerHTML = _projects.map(p => {
    const typeLabel   = TYPE_KEY[p.project_type]     ? t(TYPE_KEY[p.project_type])     : (p.project_type   || '—');
    const statusLabel = STATUS_KEY[p.project_status] ? t(STATUS_KEY[p.project_status]) : (p.project_status || '—');
    return `<tr>
      <td><strong>${esc(p.project_name)}</strong></td>
      <td>${tag(typeLabel, p.project_type === 'Project' ? 't-b' : 't-p')}</td>
      <td>${fmtDate(p.event_date) || '—'}</td>
      <td style="font-size:.78rem">${esc(p.location) || '—'}</td>
      <td>${tag(statusLabel, STATUS_COLOR[p.project_status] || 't-gr')}</td>
      <td>
        <button class="btn-icon edit" data-action="hd.projects.edit" data-id="${esc(p.project_id)}" title="${esc(t('hp.proj.row_edit'))}">✏️</button>
        <button class="btn-icon del" data-action="hd.projects.confirmDelete" data-id="${esc(p.project_id)}" data-name=${attrJson(p.project_name)} title="${esc(t('hp.proj.row_delete'))}">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

// Open the project modal in CREATE mode. The committee scope is
// implicit (auto-set on save) so the form has no committee picker —
// the head can only create in their own committee anyway.
export function openHeadProjectCreate() {
  clearForm('hd-project');
  document.getElementById('hd-project-modal-title').textContent = t('hp.proj.modal_add');
  openModal('hd-project');
}

export function editHeadProject(id) {
  const p = _projects.find(x => x.project_id === id);
  if (!p) return;
  sv('hd-prj-edit-id',   id);
  sv('hd-prj-name',      p.project_name);
  sv('hd-prj-type',      p.project_type || 'Event');
  sv('hd-prj-desc',      p.project_description || '');
  sv('hd-prj-date',      p.event_date ? String(p.event_date).slice(0, 10) : '');
  sv('hd-prj-start',     p.start_time ? String(p.start_time).slice(0, 5) : '');
  sv('hd-prj-end',       p.end_time   ? String(p.end_time).slice(0, 5)   : '');
  sv('hd-prj-location',  p.location || '');
  sv('hd-prj-status',    p.project_status || 'Planning');
  document.getElementById('hd-project-modal-title').textContent = t('hp.proj.modal_edit');
  openModal('hd-project');
}

export async function saveHeadProject() {
  const id = gv('hd-prj-edit-id');
  const me = window.CURRENT_USER;
  if (!me?.committee_id) { toast(t('hp.proj.err_no_committee'), 'twarn'); return; }
  if (!me?.member_id)    { toast(t('hp.proj.err_no_member_id'), 'twarn'); return; }
  const body = {
    project_name:        gv('hd-prj-name'),
    project_type:        gv('hd-prj-type'),
    project_description: gv('hd-prj-desc') || null,
    event_date:          gv('hd-prj-date') || null,
    start_time:          gv('hd-prj-start') || null,
    end_time:            gv('hd-prj-end') || null,
    location:            gv('hd-prj-location') || null,
    project_status:      gv('hd-prj-status'),
    // Server enforces requireAdminScope on owning_committee_id —
    // head can only create in their own. Hard-code to be safe.
    owning_committee_id: me.committee_id,
    // created_by is required by createProject. We auto-set to the
    // head's own member_id. For updates, the existing value is
    // preserved by the server's COALESCE pattern.
    created_by_member_id: me.member_id,
  };
  if (!body.project_name) {
    toast(t('hp.proj.err_name_required'), 'twarn'); return;
  }
  let res;
  if (id) res = await api('updateProject', { id, data: body });
  else    res = await api('createProject', body);
  if (res && res.success) {
    toast(t(id ? 'hp.proj.success_update' : 'hp.proj.success_create'));
    closeModal('hd-project');
    clearForm('hd-project');
    loadHeadProjects();
  }
}

export function confirmDeleteHeadProject(id, name) {
  if (!confirm(t('hp.proj.delete_confirm', { name }))) return;
  api('deleteProject', { id }).then(res => {
    if (res && res.success) { toast(t('hp.proj.success_delete')); loadHeadProjects(); }
  });
}
