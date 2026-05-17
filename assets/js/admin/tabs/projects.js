// Projects tab — events + initiatives. Also owns the "project detail" page
// because that view is just a deep-link from the projects list.
//
// `filterProjectsByStatus` is referenced from the dropdown above the table.
// `viewProjectDetail` is the entry point for the per-project drill-down; it
// calls showPage('project-detail') (so router knows it should be visible)
// then fills the right rail. The three bulk action buttons in the project
// hero are wired through openModalWithPrj — a tiny "open this modal with
// the project pre-selected" helper that also belongs here because that
// hero owns it.

import { DB, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, sv, tag, attrJson, fmtDate } from '../../lib/format.js';
import {
  api, apiGet, toast, openModal, closeModal, clearForm,
  populateProjectSelects,
} from '../../lib/ui.js';
import { showPage } from '../router.js';
import { loadBulkAttGrid } from './attendance.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

// Project type + status enum → translation key. Tag colors stay keyed
// off the canonical English values so STATUS_COLORS keeps working.
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
// Attendance enum used by the project-detail KPI grid.
const PDETAIL_PARTICIPANT_STATUS_KEY = {
  Confirmed: 'ap.par.status_confirmed',
  Pending:   'ap.par.status_pending',
  Cancelled: 'ap.par.status_cancelled',
};
const PDETAIL_ATTENDANCE_KEY = {
  Pending:  'ap.att.pending',
  Attended: 'ap.att.attended',
  Absent:   'ap.att.absent',
  Excused:  'ap.att.excused',
  Late:     'ap.att.late',
};

// ══════════════════════════════════════════
// PROJECTS
// ══════════════════════════════════════════
export async function loadProjects() {
  const data = await apiGet('getProjects');
  if (!data || !data.success) return;
  DB.projects = data.data || [];
  renderProjects(DB.projects);
  populateProjectSelects();
}

export function renderProjects(projects) {
  const tbody = document.getElementById('projects-tbody');
  if (!projects.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(t('ap.prj.empty'))}</td></tr>`;
    return;
  }
  tbody.innerHTML = projects.map(p => {
    const mgr = DB.members.find(m =>
      m.member_id === p.assigned_project_manager_member_id ||
      m.member_id === p.assigned_event_manager_member_id
    );
    const typeLabel   = TYPE_KEY[p.project_type]     ? t(TYPE_KEY[p.project_type])     : (p.project_type   || '—');
    const statusLabel = STATUS_KEY[p.project_status] ? t(STATUS_KEY[p.project_status]) : (p.project_status || '—');
    return `<tr>
      <td><strong>${esc(p.project_name)}</strong></td>
      <td>${tag(typeLabel, p.project_type === 'Project' ? 't-b' : 't-p')}</td>
      <td>${fmtDate(p.event_date) || '—'}</td>
      <td style="font-size:.78rem">${esc(p.location) || '—'}</td>
      <td>${mgr ? esc(mgr.preferred_name || mgr.full_name) : '<span style="color:var(--tm)">—</span>'}</td>
      <td>${tag(statusLabel, STATUS_COLORS[p.project_status] || 't-gr')}</td>
      <td>
        <button class="btn-icon edit" data-action="editProject" data-id="${p.project_id}">✏️</button>
        <button class="btn-icon del" data-action="confirmDelete" data-type="project" data-id="${p.project_id}" data-name=${attrJson(p.project_name)}>🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

export function filterProjectsByStatus(status) {
  const filtered = status ? DB.projects.filter(p => p.project_status === status) : DB.projects;
  renderProjects(filtered);
}

export async function saveProject() {
  const id = gv('prj-edit-id');
  const body = {
    project_name:                         gv('prj-name'),
    project_type:                         gv('prj-type'),
    project_description:                  gv('prj-desc'),
    event_date:                           gv('prj-date'),
    start_time:                           gv('prj-start'),
    end_time:                             gv('prj-end'),
    location:                             gv('prj-location'),
    proposal_file_url:                    gv('prj-proposal'),
    created_by_member_id:                 gv('prj-created-by'),
    assigned_project_manager_member_id:   gv('prj-manager'),
    assigned_event_manager_member_id:     gv('prj-event-mgr'),
    project_status:                       gv('prj-status'),
    notes:                                gv('prj-notes'),
  };
  if (!body.project_name || !body.created_by_member_id) {
    toast(t('ap.prj.err_required'), 'twarn'); return;
  }
  let res;
  if (id) res = await api('updateProject', { id, data: body });
  else     res = await api('createProject', body);
  if (res) { toast(t('ap.prj.success_save')); closeModal('project'); clearForm('project'); loadProjects(); }
}

export function editProject(id) {
  const p = DB.projects.find(x => x.project_id === id);
  if (!p) return;
  sv('prj-edit-id', id);
  sv('prj-name', p.project_name); sv('prj-type', p.project_type);
  sv('prj-desc', p.project_description);
  // <input type="date"> needs YYYY-MM-DD; <input type="time"> needs HH:MM.
  // Postgres returns event_date as ISO with time, and start/end_time as 'HH:MM:SS'.
  sv('prj-date',  p.event_date  ? String(p.event_date).slice(0, 10) : '');
  sv('prj-start', p.start_time  ? String(p.start_time).slice(0, 5)  : '');
  sv('prj-end',   p.end_time    ? String(p.end_time).slice(0, 5)    : '');
  sv('prj-location', p.location); sv('prj-proposal', p.proposal_file_url);
  sv('prj-created-by', p.created_by_member_id);
  sv('prj-manager', p.assigned_project_manager_member_id);
  sv('prj-event-mgr', p.assigned_event_manager_member_id);
  sv('prj-status', p.project_status); sv('prj-notes', p.notes);
  document.getElementById('project-modal-title').textContent = t('ap.prj.modal_edit');

  // Phase B — cover photo uploader. Show the section + current photo
  // preview, if any. Storage upload scopes to project_id, so we only
  // surface this on edit (the row exists after first save).
  document.getElementById('prj-photo-section').style.display = '';
  document.getElementById('prj-photo-wrap').style.display    = '';
  const currentEl = document.getElementById('prj-photo-current');
  if (currentEl) {
    // Cover preview + delete button. The delete button only renders
    // when there's a URL to clear, and onerror falls back to the
    // "missing image" indicator so an orphaned URL (storage object
    // gone, column still set) doesn't render as a broken icon.
    currentEl.innerHTML = p.cover_photo_url
      ? `<div style="display:flex;gap:.5rem;align-items:flex-start;flex-wrap:wrap">
           <img src="${esc(p.cover_photo_url)}" alt="" style="max-width:220px;height:auto;border-radius:8px;border:1px solid var(--bd)" onerror="this.replaceWith(Object.assign(document.createElement('div'),{textContent:'⚠️',title:'',style:'font-size:1.4rem;padding:.4rem .6rem;border:1px dashed var(--bd);border-radius:8px'}))"/>
           <button class="btn btn-ol btn-sm" type="button" data-action="deleteProjectPhoto" title="${esc(t('ap.prj.photo_delete_btn'))}">🗑️ ${esc(t('ap.prj.photo_delete_btn'))}</button>
         </div>`
      : `<span style="font-size:.78rem;color:var(--tm);font-style:italic">${esc(t('ap.prj.photo_none_yet'))}</span>`;
  }
  // Reset the picker + button so a previous unsubmitted file doesn't
  // bleed across opens.
  const fileEl = document.getElementById('prj-photo-file');
  if (fileEl) fileEl.value = '';
  const btn = document.getElementById('prj-photo-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('ap.prj.photo_upload_btn'); }

  openModal('project');
}

// Phase B — cover photo upload handlers (wired in admin/main.js via
// data-action). onProjectPhotoChange enables the rفع button once a
// file is picked; uploadProjectPhotoFromForm reads the modal state
// (edit-id) + the file picker, posts to storage.uploadProjectPhoto,
// then re-loads projects so the homepage + admin grid see the new URL.
export function onProjectPhotoChange(el) {
  const btn = document.getElementById('prj-photo-btn');
  if (btn) btn.disabled = !el.files || !el.files[0];
}

export async function uploadProjectPhotoFromForm() {
  const projectId = gv('prj-edit-id');
  const fileEl    = document.getElementById('prj-photo-file');
  const file      = fileEl?.files?.[0];
  if (!projectId) { toast(t('ap.prj.err_save_first'), 'twarn'); return; }
  if (!file)      { toast(t('ap.prj.err_pick_image'), 'twarn'); return; }
  if (file.size > 4 * 1024 * 1024) {
    toast(t('ap.prj.err_image_too_large'), 'twarn');
    return;
  }
  const btn = document.getElementById('prj-photo-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('ap.prj.photo_uploading'); }
  try {
    const base64Data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('read failed'));
      r.readAsDataURL(file);
    });
    const res = await api('storage.uploadProjectPhoto', {
      data: { project_id: projectId, filename: file.name, contentType: file.type, base64Data },
    });
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t('ap.prj.err_upload_failed'), 'twarn');
      return;
    }
    toast(t('ap.prj.success_upload'), 'tok');
    // Refresh + re-open so the new image preview renders.
    await loadProjects();
    editProject(projectId);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('ap.prj.photo_upload_btn'); }
  }
}

// Clear the cover from the open project — wired via data-action on the
// 🗑️ button next to the preview. Confirms first because the action is
// irreversible (the storage object is removed). Backend nulls
// cover_photo_url even if the storage delete fails, so this also acts
// as a recovery path for the user's reported bug (object gone from
// Supabase, URL still stuck on the row).
export async function deleteProjectPhotoFromForm() {
  const projectId = gv('prj-edit-id');
  if (!projectId) { toast(t('ap.prj.err_save_first'), 'twarn'); return; }
  if (!confirm(t('ap.prj.photo_delete_confirm'))) return;
  const res = await api('storage.deleteProjectPhoto', { data: { project_id: projectId } });
  if (!res || !res.success) {
    toast(localizeError(res?.error, res?.errorParams) || t('ap.prj.err_delete_photo'), 'twarn');
    return;
  }
  toast(t('ap.prj.success_delete_photo'), 'tok');
  await loadProjects();
  editProject(projectId);
}

// ── PROJECT DETAIL ────────────────────────────────────────────
export async function viewProjectDetail(pid) {
  showPage('project-detail');
  const el = document.getElementById('pdetail-content');
  if (el) el.innerHTML = `<div class="loading-spinner"><div class="spinner"></div>${esc(t('common.loading'))}</div>`;

  const d = await api('dashboard.projectDetail', { project_id: pid });
  if (!d || !d.success) {
    if (el) el.innerHTML = `<p style="color:var(--dn);padding:2rem">${esc(t('ap.pdetail.err_load'))}</p>`;
    return;
  }

  const { project: p, participants, interest_summary: is, attendance_summary: as, hours_summary: hs } = d;
  const creator = DB.members.find(m => m.member_id === p.created_by_member_id);
  const pm      = DB.members.find(m => m.member_id === p.assigned_project_manager_member_id);
  const em      = DB.members.find(m => m.member_id === p.assigned_event_manager_member_id);
  const typeLabel   = TYPE_KEY[p.project_type]     ? t(TYPE_KEY[p.project_type])     : p.project_type;
  const statusLabel = STATUS_KEY[p.project_status] ? t(STATUS_KEY[p.project_status]) : p.project_status;

  el.innerHTML = `
    <div class="proj-hero">
      <div style="flex:1">
        <div style="font-size:.65rem;font-weight:700;color:rgba(255,255,255,.45);margin-bottom:.28rem">
          ${tag(typeLabel, p.project_type==='Project'?'t-b':'t-p')} · ${p.event_date||'—'} ${p.location?'· '+esc(p.location):''}
        </div>
        <div style="font-size:1.05rem;font-weight:800;margin-bottom:.22rem">${esc(p.project_name)}</div>
        <div style="font-size:.74rem;color:rgba(255,255,255,.55)">${p.start_time?p.start_time+' → '+p.end_time:''}</div>
        <div style="margin-top:.55rem;display:flex;gap:.55rem;flex-wrap:wrap">
          ${creator?`<span style="font-size:.71rem;color:rgba(255,255,255,.5)">👤 ${esc(creator.preferred_name||creator.full_name)}</span>`:''}
          ${pm?`<span style="font-size:.71rem;color:rgba(255,255,255,.5)">🔑 ${esc(pm.preferred_name||pm.full_name)}</span>`:''}
          ${em?`<span style="font-size:.71rem;color:rgba(255,255,255,.5)">🔑 ${esc(em.preferred_name||em.full_name)}</span>`:''}
        </div>
      </div>
      <div style="display:flex;gap:.45rem;flex-wrap:wrap;align-items:flex-start">
        ${tag(statusLabel, STATUS_COLORS[p.project_status]||'t-gr')}
        ${p.proposal_file_url?`<a href="${p.proposal_file_url}" target="_blank" class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)">${esc(t('ap.pdetail.proposal_btn'))}</a>`:''}
        <button class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)"
          data-action="openModalWithPrj" data-modal="bulk-att" data-selector="batt-prj" data-project-id="${p.project_id}">${esc(t('ap.pdetail.bulk_att_btn'))}</button>
        <button class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)"
          data-action="openModalWithPrj" data-modal="bulk-thanks" data-selector="bthx-prj" data-project-id="${p.project_id}">${esc(t('ap.pdetail.bulk_thanks_btn'))}</button>
        <button class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)"
          data-action="openModalWithPrj" data-modal="bulk-certs" data-selector="bcert-prj" data-project-id="${p.project_id}">${esc(t('ap.pdetail.bulk_certs_btn'))}</button>
      </div>
    </div>
    <div class="proj-kpis">
      <div class="kpi"><div class="kpi-n">${participants.length}</div><div class="kpi-l">${esc(t('ap.pdetail.kpi_participants'))}</div></div>
      <div class="kpi"><div class="kpi-n">${is.interested||0}</div><div class="kpi-l">${esc(t('ap.pdetail.kpi_interested'))}</div></div>
      <div class="kpi"><div class="kpi-n" style="color:var(--sc)">${as.present||0}</div><div class="kpi-l">${esc(t('ap.pdetail.kpi_attended'))}</div></div>
      <div class="kpi"><div class="kpi-n" style="color:var(--bl)">${hs.total_hours||0}</div><div class="kpi-l">${esc(t('ap.pdetail.kpi_hours'))}</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>${esc(t('ap.pdetail.participants_card'))} (${participants.length})</h3></div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>${esc(t('ap.pdetail.par_col_name'))}</th>
          <th>${esc(t('ap.pdetail.par_col_type'))}</th>
          <th>${esc(t('ap.pdetail.par_col_status'))}</th>
          <th>${esc(t('ap.pdetail.par_col_attendance'))}</th>
          <th>${esc(t('ap.pdetail.par_col_hours'))}</th>
          <th>${esc(t('ap.pdetail.par_col_outstanding'))}</th>
        </tr></thead>
        <tbody>${participants.length ? participants.map(par => {
          const parTypeLabel = par.participant_type === 'Member' ? t('ap.par.type_member') : (par.participant_type === 'Volunteer' ? t('ap.par.type_volunteer') : par.participant_type);
          const parStatusLabel = PDETAIL_PARTICIPANT_STATUS_KEY[par.participation_status]
            ? t(PDETAIL_PARTICIPANT_STATUS_KEY[par.participation_status])
            : par.participation_status;
          const attCellLabel = PDETAIL_ATTENDANCE_KEY[par.attendance_status]
            ? t(PDETAIL_ATTENDANCE_KEY[par.attendance_status])
            : par.attendance_status;
          return `<tr>
            <td><strong>${esc(par.display_name)}</strong></td>
            <td>${tag(parTypeLabel, par.participant_type==='Member'?'t-b':'t-p')}</td>
            <td>${tag(parStatusLabel, STATUS_COLORS[par.participation_status]||'t-gr')}</td>
            <td>${par.attendance_status!=='—'?tag(attCellLabel, STATUS_COLORS[par.attendance_status]||'t-gr'):'<span style="color:var(--tm)">—</span>'}</td>
            <td><strong style="color:var(--g)">${par.total_hours||0}</strong></td>
            <td>${(par.outstanding_flag===true||par.outstanding_flag==='TRUE')? '⭐':'—'}</td>
          </tr>`;
        }).join('') : `<tr class="empty-row"><td colspan="6">${esc(t('ap.pdetail.no_participants'))}</td></tr>`}</tbody>
      </table></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.85rem">
      <div class="card"><div class="card-head"><h3>${esc(t('ap.pdetail.interest_card'))}</h3></div><div class="card-body">
        <div style="font-size:1.35rem;font-weight:800;color:var(--g)">${is.interested||0}<span style="font-size:.88rem;color:var(--tm)"> / ${is.total||0}</span></div>
        <div style="font-size:.72rem;color:var(--tl);margin-top:.18rem">${esc(t('ap.pdetail.interest_label'))}</div>
      </div></div>
      <div class="card"><div class="card-head"><h3>${esc(t('ap.pdetail.attendance_card'))}</h3></div><div class="card-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.4rem;text-align:center">
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--sc)">${as.present||0}</div><div style="font-size:.65rem;color:var(--tl)">${esc(t('ap.pdetail.att_present'))}</div></div>
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--dn)">${as.absent||0}</div><div style="font-size:.65rem;color:var(--tl)">${esc(t('ap.pdetail.att_absent'))}</div></div>
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--wn)">${as.late||0}</div><div style="font-size:.65rem;color:var(--tl)">${esc(t('ap.pdetail.att_late'))}</div></div>
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--bl)">${as.excused||0}</div><div style="font-size:.65rem;color:var(--tl)">${esc(t('ap.pdetail.att_excused'))}</div></div>
        </div>
      </div></div>
      <div class="card"><div class="card-head"><h3>${esc(t('ap.pdetail.hours_card'))}</h3></div><div class="card-body">
        <div style="font-size:1.7rem;font-weight:800;color:var(--g)">${hs.total_hours||0}</div>
        <div style="font-size:.72rem;color:var(--tl)">${esc(t('ap.pdetail.hours_label'))}</div>
      </div></div>
    </div>`;
}

export function openModalWithPrj(modal, selectId, pid) {
  openModal(modal);
  const sel = document.getElementById(selectId);
  if (sel) sel.value = pid;
  if (modal === 'bulk-att') loadBulkAttGrid(pid);
}
