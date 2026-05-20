// Volunteer hours tab — the §7 approval workflow lives here.
//
// Flow: Draft → PrimaryApproved (committee head) → FinalApproved (superadmin).
// rejectHours can fire from any stage and rolls the row back to Rejected.
// The action buttons rendered per row are gated by access level so heads
// only see "approve at primary stage" and admins see "approve at final
// stage" or "reject from final". Server re-checks every action regardless.
//
// "Hours via Opportunity" is the Principle-2 flow (assignments with
// attendance_status='Attended' are the only legal source for hour-logging).
// The opportunity dropdown drives the assignment dropdown, which auto-fills
// project + participant_type + member from the assignment.

import { DB, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, sv, tag } from '../../lib/format.js';
import { api, apiGet, toast, closeModal, clearForm } from '../../lib/ui.js';
import { loadDashboard } from './dashboard.js';
import { t } from '../../lib/i18n.js';

// Approval-status enum → translation key. Reuses mp.hours.status_* so
// the same labels show in the member portal and the admin hours tab.
const HOURS_STATUS_KEY = {
  Draft:           'mp.hours.status_draft',
  PrimaryApproved: 'mp.hours.status_primary',
  FinalApproved:   'mp.hours.status_final',
  Rejected:        'mp.hours.status_rejected',
};

// ══════════════════════════════════════════
// VOLUNTEER HOURS
// ══════════════════════════════════════════
export async function loadHours(projectId) {
  const params = projectId ? { project_id: projectId } : {};
  const data = await api('getMemberHours', params);
  if (!data || !data.success) return;
  const tbody = document.getElementById('hours-tbody');
  const items = data.data || [];
  if (!items.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${esc(t('ap.hrs.empty'))}</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map(h => renderHoursRow(h)).join('');
}

// Renders one hours row with the right approval-stage badge and action buttons
// (per §7). Visibility of approve/reject buttons is controlled by the caller's
// access level — the server still re-checks every action.
export function renderHoursRow(h) {
  const member  = DB.members.find(m => m.member_id === h.member_id);
  const project = DB.projects.find(p => p.project_id === h.project_id);
  // 2026-05-20: rows can come from two sources — the regular `hours`
  // table (approval workflow) or `attendance.meeting_hours` (counted
  // directly, no approval stage). Attendance-sourced rows are marked
  // with a "📅 لقاء" badge and don't get approve/reject/delete buttons
  // here (edit goes via the attendance tab).
  const isAttendanceRow = h.source === 'attendance';
  // Don't rely on participant_type string casing — older rows store
  // 'member' / 'volunteer' (lowercase) but the form sends 'Member' /
  // 'Volunteer' (capital). Check member_id presence directly: if there's
  // a member_id, treat as Member; otherwise it's a volunteer/external row.
  const name = h.member_id
    ? (member ? esc(member.preferred_name || member.full_name) : esc(h.member_id))
    : esc(h.volunteer_email || h.volunteer_name || '—');
  // Project cell: for project-linked rows show the project name + role
  // (if any). For attendance rows with no project (committee meetings),
  // fall back to meeting_title. The meeting badge then makes the source
  // obvious to admin so they can find the corresponding attendance row.
  let projectInner;
  if (project) {
    projectInner = `<div style="font-weight:600">${esc(project.project_name)}</div>
       ${h.opportunity_role_name ? `<div style="font-size:.7rem;color:var(--tm)">${esc(h.opportunity_role_name)}</div>` : ''}`;
  } else if (isAttendanceRow && h.meeting_title) {
    projectInner = `<div style="font-weight:600">${esc(h.meeting_title)}</div>`;
  } else {
    projectInner = esc(h.project_id || '—');
  }
  const meetingBadge = isAttendanceRow
    ? `<div style="font-size:.66rem;color:var(--bl);margin-top:.1rem">${esc(t('ap.att.badge_meeting'))}</div>`
    : '';
  const projectCell = projectInner + meetingBadge;
  const status = h.approval_status || 'Draft';
  const statusLabel = HOURS_STATUS_KEY[status] ? t(HOURS_STATUS_KEY[status]) : status;

  const access = (window.CURRENT_USER || {}).access;
  const isHead = access === 'head';
  const isAdmin = access === 'superadmin';
  const ownsCommittee = isAdmin
    || (isHead && h.opportunity_committee_id === window.CURRENT_USER.committee_id);

  // Per the 2026-05-16 permission revision, heads now own the full
  // approval chain for their own committee (primary + final + rollback).
  // The `ownsCommittee` check above already widens to "admin OR head
  // whose committee matches", so the same predicate gates every stage.
  const actions = [];
  // Attendance-sourced rows have no hours_id and no approval state to
  // mutate — leave the actions column empty so admins know to edit them
  // from the attendance tab.
  if (!isAttendanceRow) {
    if (status === 'Draft' && ownsCommittee) {
      actions.push(`<button class="btn-icon" title="${esc(t('ap.hrs.row_primary_title'))}" data-action="primaryApproveHours" data-id="${h.hours_id}">✅</button>`);
      actions.push(`<button class="btn-icon" title="${esc(t('ap.hrs.row_reject_title'))}" data-action="rejectHours" data-id="${h.hours_id}">❌</button>`);
    } else if (status === 'PrimaryApproved' && ownsCommittee) {
      actions.push(`<button class="btn-icon" title="${esc(t('ap.hrs.row_final_title'))}" data-action="finalApproveHours" data-id="${h.hours_id}">✅</button>`);
      actions.push(`<button class="btn-icon" title="${esc(t('ap.hrs.row_reject_title'))}" data-action="rejectHours" data-id="${h.hours_id}">❌</button>`);
    } else if (status === 'FinalApproved' && ownsCommittee) {
      actions.push(`<button class="btn-icon" title="${esc(t('ap.hrs.row_rollback_title'))}" data-action="rejectHours" data-id="${h.hours_id}">↩️</button>`);
    }
    actions.push(`<button class="btn-icon del" data-action="confirmDelete" data-type="hours" data-id="${h.hours_id}" data-name="${esc(t('ap.hrs.delete_target_name'))}">🗑️</button>`);
  }

  const approverHint = h.primary_approver_name
    ? `<div style="font-size:.65rem;color:var(--tm);margin-top:.15rem">${esc(t('ap.hrs.approver_primary_label'))} ${esc(h.primary_approver_name)}${h.final_approver_name ? ` · ${esc(t('ap.hrs.approver_final_label'))} ${esc(h.final_approver_name)}` : ''}</div>`
    : '';
  const rejectHint = h.rejected_reason
    ? `<div style="font-size:.65rem;color:var(--rd);margin-top:.15rem">${esc(t('ap.hrs.reject_reason_prefix'))} ${esc(h.rejected_reason)}</div>`
    : '';

  return `<tr>
    <td><strong>${name}</strong></td>
    <td style="font-size:.78rem">${projectCell}</td>
    <td>${h.hours_before || 0}</td>
    <td>${h.hours_during || 0}</td>
    <td>${h.hours_after || 0}</td>
    <td><strong style="color:var(--g)">${h.total_hours || 0}</strong></td>
    <td>${tag(statusLabel, STATUS_COLORS[status] || 't-gr')}${approverHint}${rejectHint}</td>
    <td>${actions.join('')}</td>
  </tr>`;
}

export async function primaryApproveHours(id) {
  const res = await api('hours.primaryApprove', { id });
  if (res && res.success) { toast(t('ap.hrs.success_primary')); loadHours(gv('hours-project-filter') || ''); }
}
export async function finalApproveHours(id) {
  const res = await api('hours.finalApprove', { id });
  if (res && res.success) { toast(t('ap.hrs.success_final')); loadHours(gv('hours-project-filter') || ''); loadDashboard(); }
}
export async function rejectHours(id) {
  const reason = prompt(t('ap.hrs.prompt_reject'));
  if (reason === null) return;
  const res = await api('hours.reject', { id, reason });
  if (res && res.success) { toast(t('ap.hrs.success_reject')); loadHours(gv('hours-project-filter') || ''); loadDashboard(); }
}

export async function saveHours() {
  const before = parseFloat(gv('hrs-before') || 0);
  const during = parseFloat(gv('hrs-during') || 0);
  const after  = parseFloat(gv('hrs-after')  || 0);
  const assignmentId = gv('hrs-assignment-id');
  // Renamed from `t` so it doesn't shadow the imported i18n `t()` —
  // every t(...) call inside this function reaches the helper now.
  const ptype = gv('hrs-type');
  // Phase D — pick the right participant identifier based on the type.
  // Exactly one is sent; the Edge Function rejects rows with more than
  // one identifier set.
  const body = {
    assignment_id:        assignmentId ? parseInt(assignmentId, 10) : null,
    project_id:           gv('hrs-project'),
    participant_type:     ptype,
    member_id:            ptype === 'Member'    ? gv('hrs-member')   : null,
    volunteer_email:      ptype === 'Volunteer' ? gv('hrs-vol-email') : null,
    advisor_id:           ptype === 'Advisor'   ? (parseInt(gv('hrs-advisor'), 10) || null) : null,
    hours_before:         before,
    hours_during:         during,
    hours_after:          after,
    recorded_by_member_id:gv('hrs-recorder'),
    notes:                gv('hrs-notes'),
  };
  if (!body.project_id) { toast(t('ap.hrs.err_pick_project'), 'twarn'); return; }
  if (before + during + after <= 0) { toast(t('ap.hrs.err_zero'), 'twarn'); return; }
  if (ptype === 'Advisor' && !body.advisor_id) { toast(t('ap.hrs.err_pick_advisor'), 'twarn'); return; }
  if (ptype === 'Member'  && !body.member_id)  { toast(t('ap.hrs.err_pick_member'), 'twarn');   return; }
  const res = await api('recordHours', body);
  if (res && res.success) {
    toast(t('ap.hrs.success_save', { n: res.total_hours }));
    closeModal('hours'); clearForm('hours');
    loadHours(gv('hours-project-filter') || '');
  }
}

// ─── Hours via Opportunity (Principle 2) ─────────────────────────────
let _hrsOpportunityCache = null;
let _hrsAssignmentsCache = [];

export async function populateHrsOpportunitySelect() {
  const sel = document.getElementById('hrs-opportunity');
  if (!sel) return;
  sv('hrs-assignment-id', '');
  // Use the cache from the Opportunities tab if it's already loaded; otherwise fetch.
  if (DB.opportunities && DB.opportunities.length) {
    _hrsOpportunityCache = DB.opportunities;
  } else {
    const r = await api('opportunities.list', {});
    _hrsOpportunityCache = (r && r.success ? r.data : []) || [];
  }
  sel.innerHTML = '<option value="">— تسجيل مباشر بدون فرصة —</option>'
    + _hrsOpportunityCache.map(o => {
        const proj = DB.projects.find(p => p.project_id === o.project_id);
        const projName = proj ? proj.project_name : o.project_id;
        return `<option value="${o.opportunity_id}">${esc(projName)} — ${esc(o.role_name)}</option>`;
      }).join('');
  // Reset assignment select
  document.getElementById('hrs-assignment').innerHTML =
    '<option value="">— اختر بعد اختيار الفرصة —</option>';
}

export async function onHrsOpportunityChange() {
  sv('hrs-assignment-id', '');
  const oid = gv('hrs-opportunity');
  const assignSel = document.getElementById('hrs-assignment');
  if (!oid) {
    assignSel.innerHTML = '<option value="">— اختر بعد اختيار الفرصة —</option>';
    _hrsAssignmentsCache = [];
    return;
  }
  const r = await api('assignments.list', { opportunity_id: oid });
  _hrsAssignmentsCache = (r && r.success ? r.data : []) || [];
  // Only show assignments marked Attended — Principle 2.
  const attended = _hrsAssignmentsCache.filter(a => a.attendance_status === 'Attended');
  if (!attended.length) {
    assignSel.innerHTML = '<option value="">لا يوجد حضور مؤكَّد لهذه الفرصة</option>';
    return;
  }
  assignSel.innerHTML = '<option value="">— اختر —</option>' + attended.map(a => {
    const member = DB.members.find(m => m.member_id === a.member_id);
    const name = a.member_id
      ? (member ? (member.preferred_name || member.full_name) : a.member_id)
      : (a.volunteer_name + (a.volunteer_email ? ` — ${a.volunteer_email}` : ''));
    return `<option value="${a.assignment_id}">${esc(name)}</option>`;
  }).join('');
}

export function onHrsAssignmentChange() {
  const aid = gv('hrs-assignment');
  if (!aid) { sv('hrs-assignment-id', ''); return; }
  sv('hrs-assignment-id', aid);
  const a = _hrsAssignmentsCache.find(x => String(x.assignment_id) === String(aid));
  if (!a) return;
  // Auto-fill project, participant type, and member from the assignment.
  sv('hrs-project', a.project_id || '');
  if (a.member_id) {
    sv('hrs-type', 'Member'); toggleHrsFields(); sv('hrs-member', a.member_id);
  } else {
    sv('hrs-type', 'Volunteer'); toggleHrsFields(); sv('hrs-vol-email', a.volunteer_email || '');
  }
  // Default during-hours to the opportunity's estimated_hours if currently zero.
  if (parseFloat(gv('hrs-during') || 0) === 0 && a.estimated_hours) {
    sv('hrs-during', a.estimated_hours);
    document.getElementById('hrs-total').textContent = a.estimated_hours;
  }
}

export function toggleHrsFields() {
  // Renamed from `t` so it doesn't shadow the imported i18n `t()`.
  const ptype = gv('hrs-type');
  document.getElementById('hrs-member-section').style.display  = ptype === 'Member'    ? '' : 'none';
  document.getElementById('hrs-vol-section').style.display     = ptype === 'Volunteer' ? '' : 'none';
  // Phase D — advisor section. Mutually exclusive with member/volunteer.
  const advSection = document.getElementById('hrs-advisor-section');
  if (advSection) advSection.style.display = ptype === 'Advisor' ? '' : 'none';
}

// Live hours total preview — wired at import time, matching the original
// module-top-level code in main.js. The inputs already exist in admin.html
// when this module is first imported (the HTML is fully parsed before the
// admin/main.js entry module starts importing tabs).
['hrs-before','hrs-during','hrs-after'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => {
    const b = parseFloat(gv('hrs-before')||0);
    const d = parseFloat(gv('hrs-during')||0);
    const a = parseFloat(gv('hrs-after') ||0);
    document.getElementById('hrs-total').textContent = (b+d+a).toFixed(1);
  });
});
