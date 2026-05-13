// Opportunities tab + Assignments modal.
//
// Two distinct things live in this file because they share state and only
// make sense together:
//   1. The opportunities list (CRUD over `opportunities`) + role-preset
//      dropdown that pre-fills role_name / estimated_hours from §12.
//   2. The per-opportunity Assignments modal where heads pick members,
//      add external volunteers, and mark attendance (Pending → Attended
//      → Absent / Excused). Attendance status is what gates hour-logging
//      in tabs/hours.js (Principle 2 in the requirements doc).
//
// `_activeOpportunity` is module-scoped state for the assignments modal —
// it survives across multiple openOpportunityAssignments() calls but is
// only one modal at a time so a single ref is enough.

import { DB, STANDARD_ROLES, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, sv, tag, fmtDate } from '../../lib/format.js';
import { api, toast, openModal, closeModal, clearForm } from '../../lib/ui.js';

// ══════════════════════════════════════════
// OPPORTUNITIES (§4, §12) + ASSIGNMENTS
// ══════════════════════════════════════════
export const ATTENDANCE_OPTIONS = ['Pending', 'Attended', 'Absent', 'Excused'];
export const ATTENDANCE_LABEL_AR = {
  Pending: 'قيد الانتظار', Attended: 'حضر', Absent: 'غاب', Excused: 'معذور',
};
export const OPP_STATUS_AR = {
  Open: 'مفتوحة', Filled: 'مكتملة', NeedsHelp: 'تحتاج مساعدة',
  Cancelled: 'ملغاة', Done: 'منتهية',
};

let _activeOpportunity = null; // currently-open opportunity in the assignments modal

export async function loadOpportunities() {
  const params = {};
  const pid = gv('opportunities-project-filter'); if (pid) params.project_id = pid;
  const st  = gv('opportunities-status-filter');  if (st)  params.status     = st;
  const data = await api('opportunities.list', params);
  if (!data || !data.success) return;
  DB.opportunities = data.data || [];
  renderOpportunities(DB.opportunities);
  const badge = document.getElementById('b-opportunities');
  if (badge) badge.textContent = DB.opportunities.length;
}

export function renderOpportunities(items) {
  const tbody = document.getElementById('opportunities-tbody');
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">لا توجد فرص بعد</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(o => {
    const project = DB.projects.find(p => p.project_id === o.project_id);
    const com = DB.committees.find(c => c.committee_id === o.owning_committee_id);
    const projectCell = project
      ? `<div style="font-weight:600">${esc(project.project_name)}</div>
         <div style="font-size:.7rem;color:var(--tm)">${fmtDate(project.event_date)}</div>`
      : esc(o.project_id);
    const filled = (o.assigned_count || 0);
    const need   = o.headcount_needed || 1;
    const fillBar = `${filled} / ${need}` + (filled >= need ? ' ✅' : '');
    const att = `${o.attended_count || 0} حضر`;
    const statusLabel = OPP_STATUS_AR[o.status] || o.status;
    return `<tr>
      <td>${projectCell}</td>
      <td><strong>${esc(o.role_name)}</strong></td>
      <td>${com ? esc(com.committee_name) : '<span style="color:var(--tm)">—</span>'}</td>
      <td>${o.estimated_hours} س</td>
      <td>${fillBar}</td>
      <td style="font-size:.8rem">${att}</td>
      <td>${tag(statusLabel, STATUS_COLORS[o.status] || 't-gr')}</td>
      <td>
        <button class="btn-icon" title="إدارة المسندين" data-action="openOpportunityAssignments" data-id="${o.opportunity_id}">👥</button>
        <button class="btn-icon edit" data-action="editOpportunity" data-id="${o.opportunity_id}">✏️</button>
        <button class="btn-icon del" data-action="confirmDeleteOpportunity" data-id="${o.opportunity_id}" data-role="${esc(o.role_name)}">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

export function populateRolePresets() {
  const sel = document.getElementById('opp-role-key');
  if (!sel || sel.options.length > 1) return;
  for (const r of STANDARD_ROLES) {
    const opt = document.createElement('option');
    opt.value = r.key;
    opt.textContent = `${r.name} (${r.hours || '—'} س)`;
    sel.appendChild(opt);
  }
}

export function onOppRolePreset() {
  const key = gv('opp-role-key');
  if (!key) return;
  const r = STANDARD_ROLES.find(x => x.key === key);
  if (!r) return;
  // Only fill when the user hasn't typed anything custom yet — don't clobber.
  if (!gv('opp-role-name')) sv('opp-role-name', r.name);
  if (r.hours && parseFloat(gv('opp-est-hours') || 0) === 2) sv('opp-est-hours', r.hours);
}

export async function saveOpportunity() {
  const id = gv('opp-edit-id');
  const body = {
    project_id:          gv('opp-project'),
    role_name:           gv('opp-role-name'),
    role_key:            gv('opp-role-key') || null,
    estimated_hours:     parseFloat(gv('opp-est-hours')) || 0,
    headcount_needed:    parseInt(gv('opp-headcount'), 10) || 1,
    owning_committee_id: gv('opp-committee') || null,
    status:              gv('opp-status'),
    notes:               gv('opp-notes'),
  };
  if (!body.project_id || !body.role_name) {
    toast('المشروع واسم الدور مطلوبان', 'twarn'); return;
  }
  const res = id
    ? await api('opportunities.update', { id, data: body })
    : await api('opportunities.create', body);
  if (res && res.success) {
    toast('✅ تم الحفظ');
    closeModal('opportunity');
    clearForm('opportunity');
    loadOpportunities();
  }
}

export function editOpportunity(id) {
  const o = DB.opportunities.find(x => x.opportunity_id === id);
  if (!o) return;
  sv('opp-edit-id', id);
  sv('opp-project', o.project_id);
  sv('opp-role-key', o.role_key || '');
  sv('opp-role-name', o.role_name || '');
  sv('opp-est-hours', o.estimated_hours || 0);
  sv('opp-headcount', o.headcount_needed || 1);
  sv('opp-committee', o.owning_committee_id || '');
  sv('opp-status', o.status || 'Open');
  sv('opp-notes', o.notes || '');
  openModal('opportunity');
}

export function confirmDeleteOpportunity(id, name) {
  document.getElementById('confirm-msg').textContent = `هل تريد حذف الفرصة "${name}"؟ سيتم حذف جميع المسندين عليها.`;
  document.getElementById('confirm-btn').onclick = async () => {
    const res = await api('opportunities.delete', { id });
    if (res && res.success) {
      toast('🗑️ تم الحذف');
      closeModal('confirm');
      loadOpportunities();
    }
  };
  openModal('confirm');
}

// ─── ASSIGNMENTS MODAL ───────────────────────────────────────────────
export async function openOpportunityAssignments(opportunityId) {
  _activeOpportunity = DB.opportunities.find(o => o.opportunity_id === opportunityId);
  if (!_activeOpportunity) return;
  const o = _activeOpportunity;
  const project = DB.projects.find(p => p.project_id === o.project_id);
  const com = DB.committees.find(c => c.committee_id === o.owning_committee_id);
  document.getElementById('opp-assign-header').innerHTML = `
    <div style="font-weight:700">${esc(o.role_name)}</div>
    <div style="font-size:.78rem;color:var(--tm);margin-top:.25rem">
      ${project ? esc(project.project_name) : ''} · ${o.estimated_hours} س ·
      ${com ? esc(com.committee_name) : '—'}
    </div>`;

  // Fill member-picker with members not yet assigned to this opportunity
  const memberSel = document.getElementById('opp-assign-member');
  memberSel.innerHTML = '<option value="">— اختر —</option>';
  const r = await api('assignments.list', { opportunity_id: opportunityId });
  const assigned = (r && r.success ? r.data : []) || [];
  const assignedMemberIds = new Set(assigned.map(a => a.member_id).filter(Boolean));
  for (const m of DB.members) {
    if (assignedMemberIds.has(m.member_id)) continue;
    const opt = document.createElement('option');
    opt.value = m.member_id;
    opt.textContent = m.preferred_name || m.full_name;
    memberSel.appendChild(opt);
  }
  renderAssignments(assigned);
  openModal('opp-assign');
}

export function renderAssignments(items) {
  const tbody = document.getElementById('opp-assign-tbody');
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="3">لا يوجد مسندون بعد</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(a => {
    const member = DB.members.find(m => m.member_id === a.member_id);
    const name = a.member_id
      ? (member ? esc(member.preferred_name || member.full_name) : a.member_id)
      : `${esc(a.volunteer_name)}${a.volunteer_email ? ` <span style="color:var(--tm);font-size:.72rem;direction:ltr">(${esc(a.volunteer_email)})</span>` : ''}`;
    const opts = ATTENDANCE_OPTIONS.map(s =>
      `<option value="${s}" ${a.attendance_status === s ? 'selected' : ''}>${ATTENDANCE_LABEL_AR[s]}</option>`
    ).join('');
    return `<tr>
      <td>${name}</td>
      <td><select data-action="markAttendance" data-id="${a.assignment_id}">${opts}</select></td>
      <td><button class="btn-icon del" data-action="removeAssignment" data-id="${a.assignment_id}">🗑️</button></td>
    </tr>`;
  }).join('');
}

export async function addAssignmentMember() {
  const memberId = gv('opp-assign-member');
  if (!memberId || !_activeOpportunity) return;
  const res = await api('assignments.add', {
    opportunity_id: _activeOpportunity.opportunity_id,
    member_id:      memberId,
  });
  if (res && res.success) {
    toast('✅ تم الإسناد');
    openOpportunityAssignments(_activeOpportunity.opportunity_id);
    loadOpportunities();
  }
}

export async function addAssignmentVolunteer() {
  const name  = gv('opp-assign-vol-name');
  const email = gv('opp-assign-vol-email');
  if (!name || !_activeOpportunity) { toast('اسم المتطوع مطلوب', 'twarn'); return; }
  const res = await api('assignments.add', {
    opportunity_id:  _activeOpportunity.opportunity_id,
    volunteer_name:  name,
    volunteer_email: email || null,
  });
  if (res && res.success) {
    toast('✅ تم الإسناد');
    sv('opp-assign-vol-name', '');
    sv('opp-assign-vol-email', '');
    openOpportunityAssignments(_activeOpportunity.opportunity_id);
    loadOpportunities();
  }
}

export async function markAttendance(assignmentId, status) {
  const res = await api('assignments.markAttendance', {
    assignment_id: assignmentId, attendance_status: status,
  });
  if (res && res.success) {
    toast('✅ تم التحديث');
    if (_activeOpportunity) loadOpportunities();
  }
}

export async function removeAssignment(assignmentId) {
  if (!confirm('إزالة هذا الشخص من الفرصة؟')) return;
  const res = await api('assignments.remove', { id: assignmentId });
  if (res && res.success) {
    toast('🗑️ تمت الإزالة');
    if (_activeOpportunity) openOpportunityAssignments(_activeOpportunity.opportunity_id);
    loadOpportunities();
  }
}

