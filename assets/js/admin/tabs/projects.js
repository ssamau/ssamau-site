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
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">لا توجد مشاريع</td></tr>';
    return;
  }
  tbody.innerHTML = projects.map(p => {
    const mgr = DB.members.find(m =>
      m.member_id === p.assigned_project_manager_member_id ||
      m.member_id === p.assigned_event_manager_member_id
    );
    return `<tr>
      <td><strong>${esc(p.project_name)}</strong></td>
      <td>${tag(p.project_type, p.project_type === 'Project' ? 't-b' : 't-p')}</td>
      <td>${fmtDate(p.event_date) || '—'}</td>
      <td style="font-size:.78rem">${esc(p.location) || '—'}</td>
      <td>${mgr ? esc(mgr.preferred_name || mgr.full_name) : '<span style="color:var(--tm)">—</span>'}</td>
      <td>${tag(p.project_status, STATUS_COLORS[p.project_status] || 't-gr')}</td>
      <td>
        <button class="btn-icon edit" onclick="editProject('${p.project_id}')">✏️</button>
        <button class="btn-icon del" onclick="confirmDelete('project','${p.project_id}',${attrJson(p.project_name)})">🗑️</button>
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
    toast('الاسم ومنشئ المشروع مطلوبان', 'twarn'); return;
  }
  let res;
  if (id) res = await api('updateProject', { id, data: body });
  else     res = await api('createProject', body);
  if (res) { toast('✅ تم الحفظ'); closeModal('project'); clearForm('project'); loadProjects(); }
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
  document.getElementById('project-modal-title').textContent = '✏️ تعديل المشروع';
  openModal('project');
}

// ── PROJECT DETAIL ────────────────────────────────────────────
export async function viewProjectDetail(pid) {
  showPage('project-detail');
  const el = document.getElementById('pdetail-content');
  if (el) el.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>جاري التحميل...</div>';

  const d = await api('dashboard.projectDetail', { project_id: pid });
  if (!d || !d.success) {
    if (el) el.innerHTML = '<p style="color:var(--dn);padding:2rem">خطأ في تحميل البيانات</p>';
    return;
  }

  const { project: p, participants, interest_summary: is, attendance_summary: as, hours_summary: hs } = d;
  const creator = DB.members.find(m => m.member_id === p.created_by_member_id);
  const pm      = DB.members.find(m => m.member_id === p.assigned_project_manager_member_id);
  const em      = DB.members.find(m => m.member_id === p.assigned_event_manager_member_id);

  el.innerHTML = `
    <div class="proj-hero">
      <div style="flex:1">
        <div style="font-size:.65rem;font-weight:700;color:rgba(255,255,255,.45);margin-bottom:.28rem">
          ${tag(p.project_type, p.project_type==='Project'?'t-b':'t-p')} · ${p.event_date||'—'} ${p.location?'· '+esc(p.location):''}
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
        ${tag(p.project_status, STATUS_COLORS[p.project_status]||'t-gr')}
        ${p.proposal_file_url?`<a href="${p.proposal_file_url}" target="_blank" class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)">📄 المقترح</a>`:''}
        <button class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)"
          onclick="openModalWithPrj('bulk-att','batt-prj','${p.project_id}')">⚡ حضور جماعي</button>
        <button class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)"
          onclick="openModalWithPrj('bulk-thanks','bthx-prj','${p.project_id}')">💌 شكر</button>
        <button class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)"
          onclick="openModalWithPrj('bulk-certs','bcert-prj','${p.project_id}')">🏅 شهادات</button>
      </div>
    </div>
    <div class="proj-kpis">
      <div class="kpi"><div class="kpi-n">${participants.length}</div><div class="kpi-l">مشارك</div></div>
      <div class="kpi"><div class="kpi-n">${is.interested||0}</div><div class="kpi-l">مهتم</div></div>
      <div class="kpi"><div class="kpi-n" style="color:var(--sc)">${as.present||0}</div><div class="kpi-l">حضر</div></div>
      <div class="kpi"><div class="kpi-n" style="color:var(--bl)">${hs.total_hours||0}</div><div class="kpi-l">ساعة</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>🙋 المشاركون (${participants.length})</h3></div>
      <div class="table-wrap"><table>
        <thead><tr><th>الاسم</th><th>النوع</th><th>المشاركة</th><th>الحضور</th><th>الساعات</th><th>مميّز</th></tr></thead>
        <tbody>${participants.length ? participants.map(par => `<tr>
          <td><strong>${esc(par.display_name)}</strong></td>
          <td>${tag(par.participant_type, par.participant_type==='Member'?'t-b':'t-p')}</td>
          <td>${tag(par.participation_status, STATUS_COLORS[par.participation_status]||'t-gr')}</td>
          <td>${par.attendance_status!=='—'?tag(par.attendance_status,STATUS_COLORS[par.attendance_status]||'t-gr'):'<span style="color:var(--tm)">—</span>'}</td>
          <td><strong style="color:var(--g)">${par.total_hours||0}</strong></td>
          <td>${(par.outstanding_flag===true||par.outstanding_flag==='TRUE')? '⭐':'—'}</td>
        </tr>`).join('') : '<tr class="empty-row"><td colspan="6">لا يوجد مشاركون</td></tr>'}</tbody>
      </table></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.85rem">
      <div class="card"><div class="card-head"><h3>🙋 الاهتمام</h3></div><div class="card-body">
        <div style="font-size:1.35rem;font-weight:800;color:var(--g)">${is.interested||0}<span style="font-size:.88rem;color:var(--tm)"> / ${is.total||0}</span></div>
        <div style="font-size:.72rem;color:var(--tl);margin-top:.18rem">أبدوا اهتماماً</div>
      </div></div>
      <div class="card"><div class="card-head"><h3>✅ الحضور</h3></div><div class="card-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.4rem;text-align:center">
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--sc)">${as.present||0}</div><div style="font-size:.65rem;color:var(--tl)">حضر</div></div>
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--dn)">${as.absent||0}</div><div style="font-size:.65rem;color:var(--tl)">غاب</div></div>
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--wn)">${as.late||0}</div><div style="font-size:.65rem;color:var(--tl)">تأخّر</div></div>
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--bl)">${as.excused||0}</div><div style="font-size:.65rem;color:var(--tl)">معذور</div></div>
        </div>
      </div></div>
      <div class="card"><div class="card-head"><h3>⏱️ الساعات</h3></div><div class="card-body">
        <div style="font-size:1.7rem;font-weight:800;color:var(--g)">${hs.total_hours||0}</div>
        <div style="font-size:.72rem;color:var(--tl)">إجمالي ساعات المشاركين</div>
      </div></div>
    </div>`;
}

export function openModalWithPrj(modal, selectId, pid) {
  openModal(modal);
  const sel = document.getElementById(selectId);
  if (sel) sel.value = pid;
  if (modal === 'bulk-att') loadBulkAttGrid(pid);
}
