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
import { t } from '../../lib/i18n.js';

// ══════════════════════════════════════════
// OPPORTUNITIES (§4, §12) + ASSIGNMENTS
// ══════════════════════════════════════════
// Attendance + status enums use translation keys; the canonical English
// value stays in ATTENDANCE_OPTIONS for the assignment dropdown's value=.
export const ATTENDANCE_OPTIONS = ['Pending', 'Attended', 'Absent', 'Excused'];
export const ATTENDANCE_KEY = {
  Pending:  'ap.att.pending',
  Attended: 'ap.att.attended',
  Absent:   'ap.att.absent',
  Excused:  'ap.att.excused',
};
export const OPP_STATUS_KEY = {
  Open:      'ap.opp.status_open',
  Filled:    'ap.opp.status_filled',
  NeedsHelp: 'ap.opp.status_needs_help',
  Cancelled: 'ap.opp.status_cancelled',
  Done:      'ap.opp.status_done',
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
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${esc(t('ap.opp.empty'))}</td></tr>`;
    return;
  }
  const hoursShort = t('ap.opp.hours_short');
  const assignTitle = t('ap.opp.row_assign_title');
  const notifyTitle = t('ap.opp.row_notify_title');
  tbody.innerHTML = items.map(o => {
    const project = DB.projects.find(p => p.project_id === o.project_id);
    const com = DB.committees.find(c => c.committee_id === o.owning_committee_id);
    const projectCell = project
      ? `<div style="font-weight:600">${esc(project.project_name)}</div>
         <div style="font-size:.7rem;color:var(--tm)">${fmtDate(project.event_date)}</div>`
      : esc(o.project_id);
    // Multi-role display. With one role → render the role name verbatim
    // (identical to the pre-multi-role layout). With ≥2 roles → render
    // "FirstRole (+N more)" so the list stays scannable; the full list
    // is one click away in the edit modal. Totals (hours + headcount)
    // sum across roles so the fill-bar reflects the whole opportunity.
    const roles = Array.isArray(o.roles) ? o.roles : [];
    const totalNeed = roles.length
      ? roles.reduce((n, r) => n + (Number(r.headcount_needed) || 0), 0)
      : (o.headcount_needed || 1);
    const totalHours = roles.length
      ? roles.reduce((n, r) => n + (Number(r.estimated_hours) || 0), 0)
      : (o.estimated_hours || 0);
    const filled = (o.assigned_count || 0);
    const need   = totalNeed || 1;
    const fillBar = `${filled} / ${need}` + (filled >= need ? ' ✅' : '');
    const att = t('ap.opp.attended_count', { n: o.attended_count || 0 });
    const statusLabel = OPP_STATUS_KEY[o.status] ? t(OPP_STATUS_KEY[o.status]) : o.status;
    const roleCell = roles.length > 1
      ? `<div><strong>${esc(roles[0].role_name)}</strong></div>
         <div style="font-size:.7rem;color:var(--tm)">${esc(t('ap.opp.plus_n_more', { n: roles.length - 1 }))}</div>`
      : `<strong>${esc((roles[0] && roles[0].role_name) || o.role_name)}</strong>`;
    return `<tr>
      <td>${projectCell}</td>
      <td>${roleCell}</td>
      <td>${com ? esc(com.committee_name) : '<span style="color:var(--tm)">—</span>'}</td>
      <td>${totalHours} ${esc(hoursShort)}</td>
      <td>${fillBar}</td>
      <td style="font-size:.8rem">${esc(att)}</td>
      <td>${tag(statusLabel, STATUS_COLORS[o.status] || 't-gr')}</td>
      <td>
        <button class="btn-icon" title="${esc(assignTitle)}" data-action="openOpportunityAssignments" data-id="${o.opportunity_id}">👥</button>
        <button class="btn-icon" title="${esc(notifyTitle)}" data-action="openOpportunityNotify" data-id="${o.opportunity_id}" data-role="${esc(o.role_name)}">📧</button>
        <button class="btn-icon edit" data-action="editOpportunity" data-id="${o.opportunity_id}">✏️</button>
        <button class="btn-icon del" data-action="confirmDeleteOpportunity" data-id="${o.opportunity_id}" data-role="${esc(o.role_name)}">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

// Multi-role role-row management (president's spec 2026-05-18).
// addOppRoleRow() is wired to the "+ إضافة دور" button and also called
// from openOpportunityForCreate / editOpportunity to seed initial rows.
// Rows are class-based (`.opp-role-row`) so collectOppRoles() can iterate
// without needing per-row IDs.
export function addOppRoleRow(seed) {
  const list = document.getElementById('opp-roles-list');
  if (!list) return;
  const idx = list.children.length;
  const wrap = document.createElement('div');
  wrap.className = 'opp-role-row';
  wrap.style.cssText = 'border:1px solid var(--c-soft);border-radius:8px;padding:.7rem;margin-bottom:.5rem;background:#fafafa';
  wrap.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem">
      <div style="font-size:.78rem;color:var(--tm)" class="opp-role-row-label">${esc(t('ap.opp.role_n', { n: idx + 1 }))}</div>
      <button type="button" class="btn-icon del" data-action="removeOppRoleRow" title="${esc(t('ap.opp.remove_role') || 'حذف الدور')}">🗑️</button>
    </div>
    <div class="fg-row">
      <div class="fg">
        <label><span data-i18n="ap.opp.lbl_role_preset">الدور</span></label>
        <select class="opp-role-key" data-action="onOppRoleRowPreset">
          <option value="" data-i18n="ap.opp.role_preset_choose">— اختر دور قياسي —</option>
        </select>
      </div>
      <div class="fg">
        <label><span data-i18n="ap.opp.lbl_role_name">اسم الدور</span> <span class="required">*</span></label>
        <input class="opp-role-name" data-i18n-placeholder="ap.opp.ph_role_name" placeholder="مثل: منسق استقبال"/>
      </div>
    </div>
    <div class="fg-row">
      <div class="fg"><label data-i18n="ap.opp.lbl_est_hours">الساعات المقدّرة</label><input class="opp-est-hours" type="number" step="0.5" min="0" value="2"/></div>
      <div class="fg"><label data-i18n="ap.opp.lbl_headcount">عدد المتطوعين المطلوب</label><input class="opp-headcount" type="number" min="1" value="1"/></div>
    </div>
    <div class="fg"><label data-i18n="ap.opp.lbl_role_notes">ملاحظات الدور</label><input class="opp-role-notes" data-i18n-placeholder="ap.opp.ph_role_notes" placeholder="اختياري — تفاصيل تخص هذا الدور"/></div>`;
  list.appendChild(wrap);
  // Populate preset dropdown for this row from STANDARD_ROLES.
  const sel = wrap.querySelector('.opp-role-key');
  for (const r of STANDARD_ROLES) {
    const opt = document.createElement('option');
    opt.value = r.key;
    opt.textContent = r.hours
      ? t('ap.opp.role_preset_label',      { name: r.name, hours: r.hours })
      : t('ap.opp.role_preset_label_dash', { name: r.name });
    sel.appendChild(opt);
  }
  // Seed from passed-in data (used by editOpportunity to pre-fill).
  if (seed) {
    if (seed.role_key) sel.value = seed.role_key;
    wrap.querySelector('.opp-role-name').value  = seed.role_name || '';
    wrap.querySelector('.opp-est-hours').value  = seed.estimated_hours ?? 2;
    wrap.querySelector('.opp-headcount').value  = seed.headcount_needed ?? 1;
    wrap.querySelector('.opp-role-notes').value = seed.notes || '';
  }
  refreshRoleRowLabels();
}

export function removeOppRoleRow(el) {
  const list = document.getElementById('opp-roles-list');
  if (!list) return;
  const row  = el?.closest('.opp-role-row');
  if (!row) return;
  // A safety net: never let the admin save zero roles. Server enforces
  // it anyway but a UI guard avoids the round-trip + toast spam.
  if (list.children.length <= 1) {
    toast(t('ap.opp.err_min_one_role') || 'لا يمكن حذف آخر دور — يجب وجود دور واحد على الأقل', 'twarn');
    return;
  }
  row.remove();
  refreshRoleRowLabels();
}

function refreshRoleRowLabels() {
  const rows = document.querySelectorAll('#opp-roles-list .opp-role-row');
  rows.forEach((row, i) => {
    const lbl = row.querySelector('.opp-role-row-label');
    if (lbl) lbl.textContent = t('ap.opp.role_n', { n: i + 1 });
  });
}

export function onOppRoleRowPreset(el) {
  const sel = el;
  const key = sel.value;
  if (!key) return;
  const r = STANDARD_ROLES.find(x => x.key === key);
  if (!r) return;
  const row = sel.closest('.opp-role-row');
  if (!row) return;
  const nameEl  = row.querySelector('.opp-role-name');
  const hoursEl = row.querySelector('.opp-est-hours');
  // Only fill empty / default values — don't clobber what the admin typed.
  if (nameEl && !nameEl.value) nameEl.value = r.name;
  if (hoursEl && r.hours && parseFloat(hoursEl.value || 0) === 2) hoursEl.value = r.hours;
}

// Reset roles list to a single empty row (for the create flow). Called
// from admin/main.js openModal hook when the form is being opened for
// a brand-new opportunity.
export function resetOppRolesList() {
  const list = document.getElementById('opp-roles-list');
  if (!list) return;
  list.innerHTML = '';
  addOppRoleRow();
}

function collectOppRoles() {
  const rows = document.querySelectorAll('#opp-roles-list .opp-role-row');
  const out = [];
  for (const row of rows) {
    const role_name = (row.querySelector('.opp-role-name')?.value || '').trim();
    if (!role_name) continue;       // skip rows the admin didn't fill
    out.push({
      role_name,
      role_key:         row.querySelector('.opp-role-key')?.value || null,
      estimated_hours:  parseFloat(row.querySelector('.opp-est-hours')?.value) || 0,
      headcount_needed: parseInt(row.querySelector('.opp-headcount')?.value, 10) || 1,
      notes:            (row.querySelector('.opp-role-notes')?.value || '').trim() || null,
    });
  }
  return out;
}

export async function saveOpportunity() {
  const id = gv('opp-edit-id');
  const notifyAfterSave = !!document.getElementById('opp-notify-after-save')?.checked;
  const roles = collectOppRoles();
  if (!gv('opp-project')) {
    toast(t('ap.opp.err_required'), 'twarn'); return;
  }
  if (!roles.length) {
    toast(t('ap.opp.err_min_one_role') || 'أضف دوراً واحداً على الأقل', 'twarn');
    return;
  }
  const body = {
    project_id:          gv('opp-project'),
    // Mirror the first role into the legacy single-role fields so older
    // server paths (and any old subscribers reading the row directly)
    // see something coherent. The server keeps these in sync too.
    role_name:           roles[0].role_name,
    role_key:            roles[0].role_key,
    estimated_hours:     roles[0].estimated_hours,
    headcount_needed:    roles[0].headcount_needed,
    roles,
    owning_committee_id: gv('opp-committee') || null,
    status:              gv('opp-status'),
    notes:               gv('opp-notes'),
  };
  const res = id
    ? await api('opportunities.update', { id, data: body })
    : await api('opportunities.create', body);
  if (res && res.success) {
    toast(t('ap.opp.success_save'));
    closeModal('opportunity');
    clearForm('opportunity');
    await loadOpportunities();
    // Auto-open the notify modal when the admin opted into broadcasting.
    // For a new opportunity the server returns its id; for an edit we
    // already have it. loadOpportunities() above refreshed DB.opportunities
    // so the find() below sees the freshly-saved row.
    if (notifyAfterSave) {
      const oppId = id || res.data?.opportunity_id || res.opportunity_id;
      const opp   = DB.opportunities.find(o => o.opportunity_id === oppId);
      if (opp) {
        const fakeEl = document.createElement('div');
        fakeEl.dataset.id   = opp.opportunity_id;
        fakeEl.dataset.role = opp.role_name || '';
        openOpportunityNotify(fakeEl);
      } else {
        toast(t('ap.opp.notify_after_hint'), 'twarn');
      }
    }
  }
}

export function editOpportunity(id) {
  const o = DB.opportunities.find(x => x.opportunity_id === id);
  if (!o) return;
  sv('opp-edit-id', id);
  sv('opp-project', o.project_id);
  sv('opp-committee', o.owning_committee_id || '');
  sv('opp-status', o.status || 'Open');
  sv('opp-notes', o.notes || '');
  // Rebuild the roles list from the saved opportunity_roles array. Fall
  // back to a single seeded row built from the legacy single-role
  // columns so very old opportunities (pre-backfill) still load
  // gracefully — the backfill should have covered everything but
  // belt-and-braces.
  const list = document.getElementById('opp-roles-list');
  if (list) list.innerHTML = '';
  const rolesSeed = (Array.isArray(o.roles) && o.roles.length)
    ? o.roles
    : [{
        role_name:        o.role_name,
        role_key:         o.role_key,
        estimated_hours:  o.estimated_hours,
        headcount_needed: o.headcount_needed,
      }];
  rolesSeed.forEach(r => addOppRoleRow(r));
  // Don't re-broadcast an existing opportunity by default when the admin
  // is just tweaking notes / role / hours. They can still tick the box
  // explicitly if they do want to re-blast.
  const notify = document.getElementById('opp-notify-after-save');
  if (notify) notify.checked = false;
  openModal('opportunity');
}

// Called by openModal('opportunity') via setModalHooks. When opening
// for create (no edit-id), reset the roles list to a single empty row
// so a stale roles list from the previous open doesn't leak in. The
// edit flow's editOpportunity() pre-populates rows BEFORE opening the
// modal, so the edit-id check below correctly skips the reset.
export function populateRolePresets() {
  const editId = gv('opp-edit-id');
  if (editId) return;
  const list = document.getElementById('opp-roles-list');
  if (!list) return;
  list.innerHTML = '';
  addOppRoleRow();
}

// Backwards-compat shim for the old single-role preset flow. Old
// callers (no remaining ones in the codebase, but admin/main.js still
// imports it) get a no-op so the import doesn't fail at startup.
export function onOppRolePreset() {}

export function confirmDeleteOpportunity(id, name) {
  document.getElementById('confirm-msg').textContent = t('ap.opp.delete_confirm', { name });
  document.getElementById('confirm-btn').onclick = async () => {
    const res = await api('opportunities.delete', { id });
    if (res && res.success) {
      toast(t('ap.delete.success'));
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
      ${project ? esc(project.project_name) : ''} · ${o.estimated_hours} ${esc(t('ap.opp.hours_short'))} ·
      ${com ? esc(com.committee_name) : '—'}
    </div>`;

  // Role picker — same shape as the head's modal. roles[] comes from
  // opportunities.list with a `taken` counter for each role. Full
  // roles get disabled options + a fullness suffix in the label so
  // the admin sees capacity at a glance. First non-full role is
  // auto-selected. Hidden entirely if the opp pre-dates the multi-
  // role refactor and has no roles[].
  const roleSel = document.getElementById('opp-assign-role');
  const roles   = Array.isArray(o.roles) ? o.roles : [];
  if (roleSel) {
    if (!roles.length) {
      roleSel.innerHTML = `<option value="">—</option>`;
      roleSel.parentElement.style.display = 'none';
    } else {
      roleSel.parentElement.style.display = '';
      const fullLabel = t('mp.opps.role_full_badge') || 'ممتلئ';
      let firstAvailable = null;
      roleSel.innerHTML = roles.map(r => {
        const taken     = Number(r.taken) || 0;
        const needed    = Number(r.headcount_needed) || 1;
        const remaining = Math.max(0, needed - taken);
        const isFull    = remaining === 0;
        if (!isFull && firstAvailable === null) firstAvailable = String(r.id);
        const suffix = isFull ? ` — ${fullLabel}` : ` (${remaining}/${needed})`;
        return `<option value="${esc(String(r.id))}" ${isFull ? 'disabled' : ''}>${esc(r.role_name)}${suffix}</option>`;
      }).join('');
      if (firstAvailable !== null) roleSel.value = firstAvailable;
    }
  }

  // Fill member-picker with members not yet assigned to this opportunity
  const memberSel = document.getElementById('opp-assign-member');
  memberSel.innerHTML = `<option value="">${esc(t('ap.prj.choose'))}</option>`;
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
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">${esc(t('ap.opp.assign.empty'))}</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map(a => {
    const member = DB.members.find(m => m.member_id === a.member_id);
    const name = a.member_id
      ? (member ? esc(member.preferred_name || member.full_name) : a.member_id)
      : `${esc(a.volunteer_name)}${a.volunteer_email ? ` <span style="color:var(--tm);font-size:.72rem;direction:ltr">(${esc(a.volunteer_email)})</span>` : ''}`;
    const opts = ATTENDANCE_OPTIONS.map(s =>
      `<option value="${s}" ${a.attendance_status === s ? 'selected' : ''}>${esc(t(ATTENDANCE_KEY[s]))}</option>`
    ).join('');
    // Role column — `assigned_role_name` is the JOIN result from
    // assignments.role_id → opportunity_roles.role_name. NULL on
    // legacy / opportunity-level assignments → em-dash.
    const roleCell = a.assigned_role_name
      ? esc(a.assigned_role_name)
      : `<span style="color:var(--tm)">—</span>`;
    return `<tr>
      <td>${name}</td>
      <td>${roleCell}</td>
      <td><select data-action="markAttendance" data-id="${a.assignment_id}">${opts}</select></td>
      <td><button class="btn-icon del" data-action="removeAssignment" data-id="${a.assignment_id}">🗑️</button></td>
    </tr>`;
  }).join('');
}

// Read the role_id from the admin's role-picker dropdown. Same
// contract as the head's _selectedRoleId(): empty → null (legacy
// single-role opps where the dropdown is hidden), otherwise Number().
function _adminSelectedRoleId() {
  const raw = gv('opp-assign-role');
  return (!raw || raw === '') ? null : Number(raw);
}

export async function addAssignmentMember() {
  const memberId = gv('opp-assign-member');
  if (!memberId || !_activeOpportunity) return;
  const role_id = _adminSelectedRoleId();
  const res = await api('assignments.add', {
    opportunity_id: _activeOpportunity.opportunity_id,
    member_id:      memberId,
    role_id,
  });
  if (res && res.success) {
    toast(t('ap.opp.assign.success_add'));
    openOpportunityAssignments(_activeOpportunity.opportunity_id);
    loadOpportunities();
  }
}

export async function addAssignmentVolunteer() {
  const name  = gv('opp-assign-vol-name');
  const email = gv('opp-assign-vol-email');
  if (!name || !_activeOpportunity) { toast(t('ap.opp.assign.err_vol_name'), 'twarn'); return; }
  const role_id = _adminSelectedRoleId();
  const res = await api('assignments.add', {
    opportunity_id:  _activeOpportunity.opportunity_id,
    volunteer_name:  name,
    volunteer_email: email || null,
    role_id,
  });
  if (res && res.success) {
    toast(t('ap.opp.assign.success_add'));
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
    toast(t('ap.opp.assign.success_update'));
    if (_activeOpportunity) loadOpportunities();
  }
}

export async function removeAssignment(assignmentId) {
  if (!confirm(t('ap.opp.assign.remove_confirm'))) return;
  const res = await api('assignments.remove', { id: assignmentId });
  if (res && res.success) {
    toast(t('ap.opp.assign.success_remove'));
    if (_activeOpportunity) openOpportunityAssignments(_activeOpportunity.opportunity_id);
    loadOpportunities();
  }
}


// ─── Opportunity announcement notifier (Phase 2 of post-beta) ────────
// 3 modes: send to all Active members / specific members / ad-hoc BCC
// emails. Each mode reuses the same #ov-opp-notify modal; the mode
// radio toggles which input is visible.

let _notifyContext = null;

export function openOpportunityNotify(el) {
  const opportunity_id = el.dataset.id;
  const role           = el.dataset.role || '';
  const opp            = (DB.opportunities || []).find(o => o.opportunity_id === opportunity_id);
  const project        = opp ? DB.projects.find(p => p.project_id === opp.project_id) : null;
  _notifyContext = { opportunity_id, role, project_name: project?.project_name || '' };

  // Pre-fill the header info block
  document.getElementById('oppn-role').textContent    = role || '—';
  document.getElementById('oppn-project').textContent = project?.project_name || '—';

  // Populate the per-member checkbox list with all Active members.
  const membersList = document.getElementById('oppn-members-list');
  if (membersList) {
    const actives = (DB.members || []).filter(m => m.status === 'Active' && m.email);
    membersList.innerHTML = actives.map(m =>
      `<label class="fg-check oppn-member-row">
        <input type="checkbox" value="${esc(m.member_id)}" data-email="${esc(m.email)}"/>
        <span>${esc(m.preferred_name || m.full_name)} <span style="color:var(--tm);font-size:.72rem;direction:ltr">${esc(m.email)}</span></span>
      </label>`
    ).join('');
  }

  // Reset mode radios to 'all' + custom message + emails textarea
  const allRadio = document.querySelector('input[name="oppn-mode"][value="all"]');
  if (allRadio) allRadio.checked = true;
  toggleNotifyMode();
  const msg   = document.getElementById('oppn-message');
  if (msg) msg.value = '';
  const ems   = document.getElementById('oppn-emails');
  if (ems) ems.value = '';

  document.getElementById('ov-opp-notify').classList.add('open');
}

// Wired to the mode radios; shows the relevant input chunk and hides
// the other two. Called both from openOpportunityNotify (initial state)
// and from a change-handler in admin/main.js.
export function toggleNotifyMode() {
  const mode = document.querySelector('input[name="oppn-mode"]:checked')?.value || 'all';
  document.getElementById('oppn-mode-all').style.display     = mode === 'all'     ? '' : 'none';
  document.getElementById('oppn-mode-members').style.display = mode === 'members' ? '' : 'none';
  document.getElementById('oppn-mode-emails').style.display  = mode === 'emails'  ? '' : 'none';
}

export async function sendOpportunityNotify() {
  if (!_notifyContext) return;
  const mode = document.querySelector('input[name="oppn-mode"]:checked')?.value || 'all';
  const custom_message = (document.getElementById('oppn-message')?.value || '').trim();

  const body = { opportunity_id: _notifyContext.opportunity_id, mode, custom_message };
  if (mode === 'members') {
    const checked = Array.from(document.querySelectorAll('#oppn-members-list input:checked'))
                         .map(cb => cb.value);
    if (!checked.length) { toast(t('ap.opp.notify.err_pick_member'), 'twarn'); return; }
    body.recipients = checked;
  } else if (mode === 'emails') {
    const raw = (document.getElementById('oppn-emails')?.value || '').trim();
    const emails = raw.split(/[\s,;\n]+/).map(s => s.trim()).filter(Boolean);
    if (!emails.length) { toast(t('ap.opp.notify.err_pick_email'), 'twarn'); return; }
    body.recipients = emails;
  }

  const btn = document.getElementById('oppn-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('ap.opp.notify.sending_btn'); }
  try {
    const r = await api('opportunities.notify', body);
    if (r && r.success && r.data) {
      const { sent = 0, failed = 0, count = 0 } = r.data;
      toast(t('ap.opp.notify.result', { sent, count, failed }), failed === 0 ? 'tok' : 'twarn');
      closeModal('opp-notify');
      _notifyContext = null;
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('ap.opp.notify.send_btn'); }
  }
}
