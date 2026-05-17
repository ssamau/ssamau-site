// Head's "الفرص التطوعية" tab — list opportunities owned by the head's
// committee, plus an inline form for creating new ones AND an "Assign"
// modal mirroring the admin one. The head's `owning_committee_id` is
// auto-applied on create so they can't (and don't need to) think about
// scope. The server enforces it via requireAdminScope on create + on
// every assignments.* call (ensureOpportunityScope / ensureAssignmentScope
// added 2026-05-17).

import { esc, fmtDate, gv, sv, tag } from '../../lib/format.js';
import { api, apiGet, toast, openModal, closeModal } from '../../lib/ui.js';
import { t, getLang } from '../../lib/i18n.js';

// Status enum (canonical English) → translation key + chip-class. Stored
// values stay English; the catalogs hold the localized display copy.
const STATUS_KEY = {
  Open:      'hp.opps.status_open',
  Filled:    'hp.opps.status_filled',
  NeedsHelp: 'hp.opps.status_needs_help',
  Cancelled: 'hp.opps.status_cancelled',
  Done:      'hp.opps.status_done',
};
const STATUS_CLS = {
  Open:      't-b',
  Filled:    't-g',
  NeedsHelp: 't-y',
  Cancelled: 't-gr',
  Done:      't-gr',
};

// Attendance enum mirrors admin's ATTENDANCE_OPTIONS — same values so
// the dropdown serialises to the same canonical English keys the
// existing hours-logging flow expects.
const ATTENDANCE_OPTIONS = ['Pending', 'Attended', 'Absent', 'Excused'];
const ATTENDANCE_KEY = {
  Pending:  'ap.att.pending',
  Attended: 'ap.att.attended',
  Absent:   'ap.att.absent',
  Excused:  'ap.att.excused',
};

// Module-level caches. _opps holds the current list (so the assign
// button can resolve role/project metadata without a re-fetch).
// _committeeMembers + _committeeProjects are committee-scoped rosters
// reused across the inline create form + assign modal's member picker.
let _opps             = [];
let _committeeMembers = [];
let _committeeProjects = [];
let _activeOpp        = null; // currently-open opportunity in assign modal

// ── LIST ─────────────────────────────────────────────────────────────
export async function loadHeadOpportunities() {
  const tbody = document.getElementById('hd-opps-tbody');
  if (!tbody) return;
  const params = {};
  const cid = window.CURRENT_USER?.committee_id;
  if (cid) params.committee_id = cid;
  const res = await api('opportunities.list', params);
  if (!res || !res.success) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('hp.opps.err_load'))}</td></tr>`;
    return;
  }
  _opps = res.data || [];
  if (!_opps.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('hp.opps.empty'))}</td></tr>`;
    return;
  }
  tbody.innerHTML = _opps.map(o => {
    const proj = o.project_name
      ? `<div>${esc(o.project_name)}</div>
         ${o.event_date ? `<div style="font-size:.7rem;color:var(--tm)">${fmtDate(o.event_date)}</div>` : ''}`
      : `<span style="color:var(--tm)">${esc(o.project_id || '—')}</span>`;
    const label = STATUS_KEY[o.status] ? t(STATUS_KEY[o.status]) : (o.status || '—');
    const status = tag(label, STATUS_CLS[o.status] || 't-gr');
    const filled = `${o.attended_count || 0}/${o.headcount_needed || 0}`;
    return `<tr>
      <td><strong>${esc(o.role_name || '—')}</strong></td>
      <td>${proj}</td>
      <td>${esc((o.estimated_hours || 0) + ' ' + t('mp.hours.hours_unit'))}</td>
      <td>${esc(filled)}</td>
      <td>${status}</td>
      <td>
        <button class="btn-icon" data-action="hd.opps.assign.open" data-id="${esc(o.opportunity_id)}" title="${esc(t('hp.opps.assign_title'))}">👥</button>
      </td>
    </tr>`;
  }).join('');
}

// ─── Inline create-opportunity flow ─────────────────────────────────
// Toggle the form panel; populate the project dropdown the first time
// it's opened. Filtered to the head's committee so a head can't (even
// by accident) attach an opportunity to another committee's project —
// the server still rejects that, but pre-filtering keeps the UI honest.
export async function toggleOpportunityCreateForm() {
  const form = document.getElementById('hd-opps-create-form');
  if (!form) return;
  const willOpen = form.style.display === 'none';
  form.style.display = willOpen ? '' : 'none';
  if (willOpen && !_committeeProjects.length) {
    await _ensureCommitteeRoster();
    _populateProjectsDropdown('hd-opp-project', false);
  }
}

async function _ensureCommitteeRoster() {
  const myCommittee = window.CURRENT_USER?.committee_id;
  const [mRes, pRes] = await Promise.all([
    apiGet('getMembers'),
    apiGet('getProjects'),
  ]);
  _committeeMembers  = (mRes?.data || []).filter(m => m.status !== 'Inactive' && (!myCommittee || m.committee_id === myCommittee));
  _committeeProjects = (pRes?.data || []).filter(p => !myCommittee || p.owning_committee_id === myCommittee);
}

function _populateProjectsDropdown(id, _includeAll) {
  const sel = document.getElementById(id);
  if (!sel) return;
  // Sort by event_date desc (recent + upcoming first), then by name.
  const sortLang = getLang() === 'en' ? 'en' : 'ar';
  const projects = _committeeProjects.slice().sort((a, b) => {
    const da = a.event_date || '0';
    const db = b.event_date || '0';
    if (da !== db) return db.localeCompare(da);
    return (a.project_name || '').localeCompare(b.project_name || '', sortLang);
  });
  sel.innerHTML = `<option value="">${esc(t('hp.opps.form_project_placeholder'))}</option>`
    + projects.map(p => {
        const date = p.event_date ? ` (${fmtDate(p.event_date).replace(/<[^>]+>/g, '')})` : '';
        return `<option value="${esc(p.project_id)}">${esc(p.project_name)}${esc(date)}</option>`;
      }).join('');
}

export async function createOpportunity() {
  const project_id     = gv('hd-opp-project');
  const role_name      = gv('hd-opp-role');
  const estimated_hours= Number(gv('hd-opp-hours') || 0);
  const headcount_needed = Number(gv('hd-opp-headcount') || 1);
  const notes          = gv('hd-opp-notes');
  if (!project_id) { toast(t('hp.opps.err_pick_project'), 'terr'); return; }
  if (!role_name)  { toast(t('hp.opps.err_role_required'),  'terr'); return; }
  if (headcount_needed < 1) { toast(t('hp.opps.err_headcount'), 'terr'); return; }

  const owning_committee_id = window.CURRENT_USER?.committee_id;
  if (!owning_committee_id) { toast(t('hp.opps.err_no_committee'), 'terr'); return; }

  const res = await api('opportunities.create', {
    data: {
      project_id, role_name,
      estimated_hours, headcount_needed,
      owning_committee_id,
      notes: notes || null,
    },
  });
  if (!res || !res.success) return;
  toast(t('hp.opps.success_created'));
  // Reset + collapse form, refresh list.
  sv('hd-opp-role', '');
  sv('hd-opp-hours', '0');
  sv('hd-opp-headcount', '1');
  sv('hd-opp-notes', '');
  sv('hd-opp-project', '');
  document.getElementById('hd-opps-create-form').style.display = 'none';
  loadHeadOpportunities();
}


// ═════════════════════════════════════════════════════════════════════
// ASSIGN MODAL
// ═════════════════════════════════════════════════════════════════════
// openHeadOpportunityAssignments — entry point from the 👥 button on a
// row. Resolves the opportunity from _opps (so we don't refetch), then
// fills the modal header, member picker, and assignments table.

export async function openHeadOpportunityAssignments(opportunityId) {
  _activeOpp = _opps.find(o => o.opportunity_id === opportunityId);
  if (!_activeOpp) return;
  if (!_committeeMembers.length) await _ensureCommitteeRoster();

  // Header — role · project · hours. No committee name since heads only
  // see their own committee.
  const header = document.getElementById('hd-opp-assign-header');
  if (header) {
    header.innerHTML = `
      <div style="font-weight:700">${esc(_activeOpp.role_name || '—')}</div>
      <div style="font-size:.78rem;color:var(--tm);margin-top:.25rem">
        ${esc(_activeOpp.project_name || _activeOpp.project_id || '—')} ·
        ${_activeOpp.estimated_hours || 0} ${esc(t('ap.opp.hours_short'))}
      </div>`;
  }

  // Member picker: list members not yet assigned.
  const memberSel = document.getElementById('hd-opp-assign-member');
  if (memberSel) memberSel.innerHTML = `<option value="">${esc(t('ap.prj.choose'))}</option>`;
  const r = await api('assignments.list', { opportunity_id: opportunityId });
  const assigned = (r && r.success ? r.data : []) || [];
  const assignedIds = new Set(assigned.map(a => a.member_id).filter(Boolean));
  if (memberSel) {
    for (const m of _committeeMembers) {
      if (assignedIds.has(m.member_id)) continue;
      const opt = document.createElement('option');
      opt.value = m.member_id;
      opt.textContent = m.preferred_name || m.full_name;
      memberSel.appendChild(opt);
    }
  }
  _renderAssignments(assigned);
  openModal('hd-opp-assign');
}

function _renderAssignments(items) {
  const tbody = document.getElementById('hd-opp-assign-tbody');
  if (!tbody) return;
  if (!items.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="3">${esc(t('ap.opp.assign.empty'))}</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map(a => {
    const memberRow = _committeeMembers.find(m => m.member_id === a.member_id);
    const name = a.member_id
      ? (memberRow ? esc(memberRow.preferred_name || memberRow.full_name) : esc(a.member_preferred_name || a.member_full_name || a.member_id))
      : `${esc(a.volunteer_name)}${a.volunteer_email ? ` <span style="color:var(--tm);font-size:.72rem;direction:ltr">(${esc(a.volunteer_email)})</span>` : ''}`;
    const opts = ATTENDANCE_OPTIONS.map(s =>
      `<option value="${s}" ${a.attendance_status === s ? 'selected' : ''}>${esc(t(ATTENDANCE_KEY[s]))}</option>`
    ).join('');
    return `<tr>
      <td>${name}</td>
      <td><select data-action="hd.opps.assign.markAttendance" data-id="${esc(a.assignment_id)}">${opts}</select></td>
      <td><button class="btn-icon del" data-action="hd.opps.assign.remove" data-id="${esc(a.assignment_id)}">🗑️</button></td>
    </tr>`;
  }).join('');
}

export async function addHeadAssignmentMember() {
  const memberId = gv('hd-opp-assign-member');
  if (!memberId || !_activeOpp) return;
  const res = await api('assignments.add', {
    data: {
      opportunity_id: _activeOpp.opportunity_id,
      member_id:      memberId,
    },
  });
  if (res && res.success) {
    toast(t('ap.opp.assign.success_add'));
    openHeadOpportunityAssignments(_activeOpp.opportunity_id);
    loadHeadOpportunities();
  }
}

export async function addHeadAssignmentVolunteer() {
  const name  = gv('hd-opp-assign-vol-name');
  const email = gv('hd-opp-assign-vol-email');
  if (!name || !_activeOpp) { toast(t('ap.opp.assign.err_vol_name'), 'twarn'); return; }
  const res = await api('assignments.add', {
    data: {
      opportunity_id:  _activeOpp.opportunity_id,
      volunteer_name:  name,
      volunteer_email: email || null,
    },
  });
  if (res && res.success) {
    toast(t('ap.opp.assign.success_add'));
    sv('hd-opp-assign-vol-name', '');
    sv('hd-opp-assign-vol-email', '');
    openHeadOpportunityAssignments(_activeOpp.opportunity_id);
    loadHeadOpportunities();
  }
}

export async function markHeadAssignmentAttendance(assignmentId, status) {
  const res = await api('assignments.markAttendance', {
    data: { assignment_id: assignmentId, attendance_status: status },
  });
  if (res && res.success) {
    toast(t('ap.opp.assign.success_update'));
    if (_activeOpp) loadHeadOpportunities();
  }
}

export async function removeHeadAssignment(assignmentId) {
  if (!confirm(t('ap.opp.assign.remove_confirm'))) return;
  const res = await api('assignments.remove', { id: assignmentId });
  if (res && res.success) {
    toast(t('ap.opp.assign.success_remove'));
    if (_activeOpp) openHeadOpportunityAssignments(_activeOpp.opportunity_id);
    loadHeadOpportunities();
  }
}
