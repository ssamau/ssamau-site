// Head portal — attendance tab (2026-05-16).
//
// Two responsibilities:
//   1. Render the committee's attendance log (project-linked + ad-hoc
//      meeting rows mixed, sorted by most recent).
//   2. Open + handle the "record attendance" modal which supports both
//      modes (existing project OR meeting). For ad-hoc meetings the
//      head can attribute hours directly — those count toward the
//      member's total via the server-side recompute that now reads
//      both `hours` (FinalApproved) and `attendance.meeting_hours`.
//
// The form has two top-level branches keyed off the `mode` radio:
//   - 'project'  → project picker, no meeting metadata.
//   - 'meeting'  → meeting title + type + date + time + optional location.
// And a parallel branch keyed off the `attendeeType` radio:
//   - 'member'    → member dropdown (committee-scoped server-side too).
//   - 'volunteer' → free-text name + optional email.

import { api } from '../../lib/ui.js';
import { esc, gv, sv, fmtDate, tag } from '../../lib/format.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

// Status enum (canonical English from DB) → translation key.
const ATT_STATUS_KEY = {
  Present: 'hp.att.status_present',
  Absent:  'hp.att.status_absent',
  Late:    'hp.att.status_late',
  Excused: 'hp.att.status_excused',
};
const ATT_STATUS_TAG = {
  Present: 't-g',
  Absent:  't-r',
  Late:    't-y',
  Excused: 't-b',
};
const MEETING_TYPE_KEY = {
  Online:   'hp.att.meeting_type_online',
  InPerson: 'hp.att.meeting_type_inperson',
};

// Re-fetched at modal-open time so the project + member dropdowns
// stay fresh without rebuilding the modal markup on every render.
let _committeeMembers = [];
let _committeeProjects = [];

// gv() reads element.value by id. The mode + attendee-type radios in
// the modal share a `name` but have distinct ids — gv() against the
// shared name returns '' (no element with that id). These helpers
// read the currently-checked radio in a named group instead.
function _radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || '';
}

export async function loadHeadAttendance() {
  const tbody = document.getElementById('hd-att-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('common.loading'))}</td></tr>`;

  const res = await api('head.attendance.list');
  if (!res || !res.success) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('hp.att.err_load'))}</td></tr>`;
    return;
  }
  const rows = res.data || [];
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('hp.att.empty'))}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(renderRow).join('');
}

function renderRow(a) {
  // Attendee cell — member-name when present, otherwise volunteer-name
  // / email. The server already joined the member row so we don't have
  // to do a client-side lookup.
  const attendee = a.member_id
    ? esc(a.member_preferred_name || a.member_full_name || a.member_id)
    : (a.volunteer_name
        ? esc(a.volunteer_name)
        : esc(a.volunteer_email || '—'));

  // Context cell — either the project name + date, or the meeting
  // title + type/location. Two short lines so the table stays compact.
  let context;
  if (a.meeting_title) {
    const typeKey = MEETING_TYPE_KEY[a.meeting_type];
    const typeLbl = typeKey ? t(typeKey) : (a.meeting_type || '');
    context = `<div style="font-weight:600">${esc(a.meeting_title)}</div>
      <div style="font-size:.7rem;color:var(--tm)">${esc(t('hp.att.context_meeting'))} · ${esc(typeLbl)}${a.meeting_location ? ' · ' + esc(a.meeting_location) : ''}</div>`;
  } else if (a.project_name) {
    context = `<div style="font-weight:600">${esc(a.project_name)}</div>
      ${a.project_event_date ? `<div style="font-size:.7rem;color:var(--tm)">${fmtDate(a.project_event_date)}</div>` : ''}`;
  } else {
    context = `<span style="color:var(--tm)">${esc(a.project_id || '—')}</span>`;
  }

  // Date cell — meeting_date wins, else recorded_at fallback.
  const when = a.meeting_date ? fmtDate(a.meeting_date) : fmtDate(a.recorded_at);

  // Status tag with translated label.
  const statusKey = ATT_STATUS_KEY[a.attendance_status];
  const statusLbl = statusKey ? t(statusKey) : (a.attendance_status || '—');
  const statusTag = tag(statusLbl, ATT_STATUS_TAG[a.attendance_status] || 't-gr');

  // Hours cell — meeting_hours when set, otherwise em-dash. (Project-
  // linked rows don't have inline hours — those live on the hours
  // table via the opportunity flow.)
  const hoursCell = (a.meeting_hours != null && Number(a.meeting_hours) > 0)
    ? `<strong style="color:var(--g)">${Number(a.meeting_hours)}</strong> <span style="color:var(--tm);font-size:.72rem">${esc(t('hp.att.hours_suffix'))}</span>`
    : '<span style="color:var(--tm)">—</span>';

  return `<tr>
    <td><strong>${attendee}</strong></td>
    <td>${context}</td>
    <td style="font-size:.78rem">${when || '—'}</td>
    <td>${statusTag}</td>
    <td>${hoursCell}</td>
    <td>—</td>
  </tr>`;
}

// ─── Modal: record attendance ───────────────────────────────────────

export async function openHeadAttendanceModal() {
  // Reset the form. Each open re-fetches members + the committee's
  // projects so the dropdowns are fresh (heads occasionally add a new
  // project mid-session via the admin portal).
  // Radios reset by checking the default option directly (sv() targets
  // an element id, but `hd-att-mode` isn't an id — it's the radio
  // group's name).
  const modeProj = document.getElementById('hd-att-mode-project');
  if (modeProj) modeProj.checked = true;
  const attMem  = document.getElementById('hd-att-attendee-member');
  if (attMem)  attMem.checked = true;
  sv('hd-att-project', '');
  sv('hd-att-meeting-title', '');
  sv('hd-att-meeting-type', 'Online');
  sv('hd-att-meeting-date', '');
  sv('hd-att-meeting-time', '');
  sv('hd-att-meeting-location', '');
  sv('hd-att-member', '');
  sv('hd-att-vol-name', '');
  sv('hd-att-vol-email', '');
  sv('hd-att-status', 'Present');
  sv('hd-att-hours', '');
  sv('hd-att-notes', '');
  _syncAttModeUi();
  _syncAttAttendeeUi();
  // Side-effect: also clear the meeting-type default since sv()
  // doesn't apply to <select>'s first option without an explicit set.
  sv('hd-att-meeting-type', 'Online');

  // Parallel fetches — the modal opens instantly with empty dropdowns
  // and they hydrate as the data lands.
  document.getElementById('ov-hd-att')?.classList.add('open');
  const [pRes, mRes] = await Promise.all([
    api('getProjects'),
    api('getMembers'),
  ]);
  _committeeProjects = (pRes && pRes.success ? pRes.data : []) || [];
  // Members from the head's committee only — the server enforces this
  // again at record time, but the dropdown should match.
  const myCommittee = window.CURRENT_USER?.committee_id;
  _committeeMembers = ((mRes && mRes.success ? mRes.data : []) || [])
    .filter(m => m.status !== 'Inactive')
    .filter(m => myCommittee ? m.committee_id === myCommittee : true);
  _populateAttDropdowns();
}

export function closeHeadAttendanceModal() {
  document.getElementById('ov-hd-att')?.classList.remove('open');
}

function _populateAttDropdowns() {
  const proj = document.getElementById('hd-att-project');
  if (proj) {
    proj.innerHTML = `<option value="">${esc(t('hp.att.project_pick'))}</option>` +
      _committeeProjects.map(p =>
        `<option value="${esc(p.project_id)}">${esc(p.project_name)}${p.event_date ? ` (${fmtDate(p.event_date).replace(/<[^>]+>/g, '')})` : ''}</option>`
      ).join('');
  }
  const mem = document.getElementById('hd-att-member');
  if (mem) {
    mem.innerHTML = `<option value="">${esc(t('hp.att.member_pick'))}</option>` +
      _committeeMembers.map(m =>
        `<option value="${esc(m.member_id)}">${esc(m.preferred_name || m.full_name)}</option>`
      ).join('');
  }
}

// Wired to the .mode radios + .attendee-type radios via data-action.
// Toggles which sub-section is visible. Exported so the dispatcher in
// head/main.js can call them by name.
export function onHeadAttModeChange() { _syncAttModeUi(); }
export function onHeadAttAttendeeChange() { _syncAttAttendeeUi(); }

function _syncAttModeUi() {
  const mode = _radioValue('hd-att-mode') || 'project';
  const proj = document.getElementById('hd-att-project-section');
  const meet = document.getElementById('hd-att-meeting-section');
  if (proj) proj.style.display = mode === 'project' ? '' : 'none';
  if (meet) meet.style.display = mode === 'meeting' ? '' : 'none';
  // Hours field only makes sense for ad-hoc meetings — project-linked
  // attendance gets its hours via the opportunity+hours flow, not here.
  const hoursWrap = document.getElementById('hd-att-hours-wrap');
  if (hoursWrap) hoursWrap.style.display = mode === 'meeting' ? '' : 'none';
}
function _syncAttAttendeeUi() {
  const ty = _radioValue('hd-att-attendee-type') || 'member';
  const mem = document.getElementById('hd-att-member-section');
  const vol = document.getElementById('hd-att-volunteer-section');
  if (mem) mem.style.display = ty === 'member'    ? '' : 'none';
  if (vol) vol.style.display = ty === 'volunteer' ? '' : 'none';
}

export async function saveHeadAttendance() {
  const { toast } = await import('../../lib/ui.js');
  const mode = _radioValue('hd-att-mode') || 'project';
  const attType = _radioValue('hd-att-attendee-type') || 'member';

  // Build body conditionally so we never send mutually-exclusive fields.
  const body = {
    attendance_status: gv('hd-att-status') || 'Present',
    notes:             gv('hd-att-notes')  || null,
  };

  if (mode === 'project') {
    const pid = gv('hd-att-project');
    if (!pid) { toast(t('hp.att.err_pick_project'), 'twarn'); return; }
    body.project_id = pid;
  } else {
    const title = (gv('hd-att-meeting-title') || '').trim();
    if (!title) { toast(t('hp.att.err_meeting_title'), 'twarn'); return; }
    const mtype = gv('hd-att-meeting-type');
    const mdate = gv('hd-att-meeting-date');
    const mtime = gv('hd-att-meeting-time');
    if (!mtype || !mdate || !mtime) {
      toast(t('hp.att.err_meeting_meta'), 'twarn');
      return;
    }
    body.meeting_title      = title;
    body.meeting_type       = mtype;
    body.meeting_date       = mdate;
    body.meeting_start_time = mtime;
    body.meeting_location   = gv('hd-att-meeting-location') || null;
    const hrs = (gv('hd-att-hours') || '').trim();
    if (hrs !== '') body.meeting_hours = Number(hrs);
  }

  if (attType === 'member') {
    const mid = gv('hd-att-member');
    if (!mid) { toast(t('hp.att.err_pick_member'), 'twarn'); return; }
    body.member_id = mid;
  } else {
    const vname = (gv('hd-att-vol-name') || '').trim();
    if (!vname) { toast(t('hp.att.err_vol_name'), 'twarn'); return; }
    body.volunteer_name  = vname;
    body.volunteer_email = (gv('hd-att-vol-email') || '').trim() || null;
  }

  const btn = document.getElementById('hd-att-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('common.loading'); }
  try {
    const res = await api('head.attendance.record', { data: body });
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t('common.generic_error'), 'twarn');
      return;
    }
    toast(t('hp.att.success_record'), 'tok');
    closeHeadAttendanceModal();
    await loadHeadAttendance();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('hp.att.save_btn'); }
  }
}
