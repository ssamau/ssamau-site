// Attendance tab — both the single-row attendance form and the bulk-att
// modal (grid of avatar cards you click to cycle Present/Absent/Late/Excused).
//
// The bulk grid is intentionally kept in this file even though its modal is
// opened from the project-detail page (via projects.js → openModalWithPrj),
// because all its state and DOM lives in #ov-bulk-att and #bulk-att-grid.

import { DB, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, tag, fmtDate, fmtDateTime } from '../../lib/format.js';
import { api, toast, closeModal } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';

// Attendance-status enum (canonical English from DB) → translation key.
// Two distinct enums coexist in this codebase (assignment uses Pending/
// Attended; attendance rows use Present/Late) — the keys for Absent +
// Excused are shared. STATUS_COLORS still keys off the English values.
const ATT_STATUS_KEY = {
  Present: 'ap.att.status_present',
  Absent:  'ap.att.absent',
  Late:    'ap.att.late',
  Excused: 'ap.att.excused',
};
const TYPE_KEY = {
  Member:    'ap.att.type_member',
  Volunteer: 'ap.att.type_volunteer',
};

// ══════════════════════════════════════════
// ATTENDANCE
// ══════════════════════════════════════════
export async function loadAttendance(projectId) {
  const params = projectId ? { project_id: projectId } : {};
  const data = await api('getAttendance', params);
  if (!data || !data.success) return;
  const tbody = document.getElementById('attendance-tbody');
  const items = data.data || [];
  if (!items.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${esc(t('ap.att.empty'))}</td></tr>`;
    return;
  }
  const deleteTargetName = t('ap.att.delete_target_name');
  tbody.innerHTML = items.map(a => {
    const member  = DB.members.find(m  => m.member_id  === a.member_id);
    const project = DB.projects.find(x => x.project_id === a.project_id);
    // The `attendance` table has no participant_type column — derive it
    // from member_id presence. Same robustness fix as hours.js (where
    // older rows store the type in lowercase and the form sends capital).
    const isMember = !!a.member_id;
    const isMeeting = !a.project_id && !!a.meeting_title;
    const name = isMember
      ? (member ? esc(member.preferred_name || member.full_name) : esc(a.member_id))
      : esc(a.volunteer_email || '—');
    const typeLabel = isMember ? t(TYPE_KEY.Member) : t(TYPE_KEY.Volunteer);
    const statusLabel = ATT_STATUS_KEY[a.attendance_status]
      ? t(ATT_STATUS_KEY[a.attendance_status])
      : a.attendance_status;
    const checker = DB.members.find(m => m.member_id === a.checked_by_member_id);
    // Project/event cell — three cases:
    //   - meeting (project_id NULL, meeting_title set): show the title +
    //     a tinted "📅 لقاء" badge so admins know this is a meeting the
    //     head logged from the head portal, not a regular project/event.
    //   - regular project: project_name + event_date as before.
    //   - orphan (no project, no meeting title): em-dash.
    let projectCell;
    if (isMeeting) {
      const meta = [
        a.meeting_type ? esc(a.meeting_type) : null,
        a.meeting_location ? esc(a.meeting_location) : null,
      ].filter(Boolean).join(' • ');
      projectCell = `<div style="font-weight:600">${esc(a.meeting_title)}</div>
         <div style="font-size:.66rem;color:var(--bl);margin-top:.1rem">${esc(t('ap.att.badge_meeting'))}</div>
         ${meta ? `<div style="font-size:.66rem;color:var(--tm);margin-top:.1rem">${meta}</div>` : ''}`;
    } else if (project) {
      projectCell = `<div style="font-weight:600">${esc(project.project_name)}</div>
         <div style="font-size:.7rem;color:var(--tm)">${fmtDate(project.event_date)}</div>`;
    } else {
      projectCell = `<span style="color:var(--tm)">—</span>`;
    }
    // Date column — meeting rows store the date in `meeting_date`,
    // project rows borrow from the linked project's event_date. The old
    // code read a non-existent `attendance_date` column, which is why
    // this cell was always em-dash in the screenshot.
    const eventDate = a.meeting_date || a.project_event_date || project?.event_date;
    const dateCell = eventDate ? fmtDate(eventDate) : '—';
    const hoursCell = (a.meeting_hours != null && Number(a.meeting_hours) > 0)
      ? `<strong style="color:var(--g)">${Number(a.meeting_hours)}</strong>`
      : '—';
    // Recorder cell — combines checker (member who physically marked
    // attendance) with recorder (system user who saved the row) + the
    // timestamp. Both are useful for admin auditing; surfacing them in
    // the same cell keeps the column count manageable.
    const checkerName = checker ? esc(checker.preferred_name || checker.full_name) : '';
    // Prefer the recorder's linked-member display name; fall back to
    // username for system accounts that aren't linked.
    const recorderUser = a.recorded_by_member_name
      ? esc(a.recorded_by_member_name)
      : (a.recorded_by_username ? esc(a.recorded_by_username) : '—');
    const recordedAt = a.recorded_at ? fmtDateTime(a.recorded_at) : '';
    const recorderCell = `
      ${checkerName ? `<div style="font-size:.78rem;font-weight:600">${checkerName}</div>` : ''}
      <div style="font-size:.66rem;color:var(--tm);line-height:1.35">
        <span>${esc(t('ap.att.recorded_by_lbl'))}: ${recorderUser}</span>
        ${recordedAt ? `<br><span>${recordedAt}</span>` : ''}
      </div>`;
    return `<tr>
      <td><strong>${name}</strong></td>
      <td>${projectCell}</td>
      <td>${tag(typeLabel, isMember ? 't-b' : 't-p')}</td>
      <td>${tag(statusLabel, STATUS_COLORS[a.attendance_status] || 't-gr')}</td>
      <td>${dateCell}</td>
      <td>${hoursCell}</td>
      <td>${recorderCell}</td>
      <td>
        <button class="btn-icon del" data-action="confirmDelete" data-type="attendance" data-id="${a.attendance_id}" data-name="${esc(deleteTargetName)}">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

export async function saveAttendance() {
  const body = {
    project_id:         gv('att-project'),
    participant_type:   gv('att-type'),
    member_id:          gv('att-member'),
    volunteer_email:    gv('att-vol-email'),
    attendance_status:  gv('att-status'),
    attendance_date:    gv('att-date'),
    checked_by_member_id: gv('att-checker'),
    notes:              gv('att-notes'),
  };
  // Volunteer hours (2026-05-20 fix). Optional — empty = no hours
  // credited, matching the prior behaviour for fields that didn't carry
  // hours. Numeric range validated server-side too (0–24).
  const hrs = (gv('att-hours') || '').trim();
  if (hrs !== '') body.meeting_hours = Number(hrs);
  if (!body.project_id || !body.attendance_status) { toast(t('ap.att.err_required'), 'twarn'); return; }
  const res = await api('recordAttendance', body);
  if (res) {
    toast(t('ap.att.success_record'));
    closeModal('attendance');
    if (document.getElementById('attendance-project-filter').value === body.project_id) {
      loadAttendance(body.project_id);
    }
  }
}

export function toggleAttFields() {
  // Renamed from `t` so it doesn't shadow the imported i18n `t()`.
  const ptype = gv('att-type');
  document.getElementById('att-member-section').style.display = ptype === 'Member' ? '' : 'none';
  document.getElementById('att-vol-section').style.display    = ptype === 'Volunteer' ? '' : 'none';
}

// ── BULK ATTENDANCE ──────────────────────────────────────────
export async function loadBulkAttGrid(pid) {
  if (!pid) return;
  const grid = document.getElementById('bulk-att-grid');
  grid.innerHTML = `<div class="loading-spinner"><div class="spinner"></div>${esc(t('common.loading'))}</div>`;
  const [pRes, aRes] = await Promise.all([
    api('participants.list', { project_id: pid }),
    api('attendance.list',   { project_id: pid })
  ]);
  const pars     = pRes?.data || [];
  const existing = aRes?.data || [];
  if (!pars.length) {
    grid.innerHTML = `<p style="color:var(--tm);font-size:.82rem">${esc(t('ap.att.bulk_empty'))}</p>`;
    return;
  }
  // The per-card hours input (2026-05-20 fix) carries the value as a
  // `data-hr-default` so saveBulkAttendance can read it directly off the
  // card — keeps the save path unchanged (one querySelectorAll over .att-card).
  const hrPh = t('ap.att.bulk_hr_placeholder');
  grid.innerHTML = `<div class="att-grid">${pars.map(p => {
    const m   = DB.members.find(mb => mb.member_id === p.member_id);
    const nm  = p.participant_type === 'Member'
      ? esc(m ? (m.preferred_name || m.full_name) : p.member_id)
      : esc(p.volunteer_name || p.volunteer_email || '—');
    const key = p.participant_type === 'Member' ? p.member_id : p.volunteer_email;
    const cur = existing.find(a => a.member_id === key || a.volunteer_email === key);
    const cs  = cur ? cur.attendance_status : '';
    const cls = cs === 'Present' ? 'present' : cs === 'Absent' ? 'absent' : cs === 'Late' ? 'late' : cs === 'Excused' ? 'excused' : '';
    // Render the localized status label inside the card. Cards store
    // the canonical English value on a data-st attr so cycleAttStatus()
    // can keep working off it without re-mapping localized text.
    const stLabel = cs && ATT_STATUS_KEY[cs] ? t(ATT_STATUS_KEY[cs]) : (cs || '—');
    const hrVal = (cur && cur.meeting_hours != null) ? cur.meeting_hours : '';
    return `<div class="att-card ${cls}"
      data-mid="${p.member_id || ''}" data-ve="${p.volunteer_email || ''}" data-tp="${p.participant_type}"
      data-st="${cs}"
      data-action="cycleAttStatus">
      <div class="att-av">${nm.charAt(0)}</div>
      <div class="att-meta"><div class="att-nm">${nm}</div><div class="att-st">${esc(stLabel)}</div></div>
      <input class="att-hr" type="number" step="0.25" min="0" max="24" inputmode="decimal" dir="ltr" placeholder="${esc(hrPh)}" value="${hrVal}" aria-label="${esc(t('ap.att.lbl_hours'))}" />
    </div>`;
  }).join('')}</div>`;
  // Stop the hours input from triggering the card's cycleAttStatus
  // handler. Without this, every keystroke / click inside the input
  // bubbles up to the [data-action="cycleAttStatus"] ancestor.
  grid.querySelectorAll('input.att-hr').forEach(inp => {
    inp.addEventListener('click',    e => e.stopPropagation());
    inp.addEventListener('mousedown',e => e.stopPropagation());
    inp.addEventListener('keydown',  e => e.stopPropagation());
  });
}

// cycleAttStatus reads + writes the canonical English value via a
// data-st attr so the cycle stays language-independent. The displayed
// text in .att-st is the localized label.
export function cycleAttStatus(card) {
  const cycle = ['Present','Absent','Late','Excused',''];
  const stEl  = card.querySelector('.att-st');
  const curr  = card.dataset.st || '';
  const next  = cycle[(cycle.indexOf(curr) + 1) % cycle.length];
  card.dataset.st = next;
  stEl.textContent = next && ATT_STATUS_KEY[next] ? t(ATT_STATUS_KEY[next]) : '—';
  card.className = 'att-card' +
    (next === 'Present' ? ' present' : next === 'Absent' ? ' absent' : next === 'Late' ? ' late' : next === 'Excused' ? ' excused' : '');
}

export function markAllAtt(status) {
  document.querySelectorAll('#bulk-att-grid .att-card').forEach(c => {
    c.dataset.st = status;
    c.querySelector('.att-st').textContent = ATT_STATUS_KEY[status] ? t(ATT_STATUS_KEY[status]) : status;
    c.className = 'att-card ' + (status === 'Present' ? 'present' : status === 'Absent' ? 'absent' : 'late');
  });
}

export async function saveBulkAttendance() {
  const pid = gv('batt-prj');
  if (!pid) { toast(t('ap.par.err_pick_project'), 'twarn'); return; }
  const records = [];
  document.querySelectorAll('#bulk-att-grid .att-card').forEach(c => {
    // Read the canonical English value off data-st (not the visible
    // localized text in .att-st, which would change with the language).
    const st = c.dataset.st || '';
    if (st) {
      const rec = {
        member_id:       c.dataset.mid,
        volunteer_email: c.dataset.ve,
        participant_type:c.dataset.tp,
        attendance_status: st,
        attendance_date: new Date().toISOString().split('T')[0],
      };
      // Per-row hours — empty input means "no hours credited", same as
      // the prior behaviour. Sending an explicit empty/null lets the
      // server clear a previously-credited row when status changes.
      const hrEl = c.querySelector('input.att-hr');
      const hrRaw = (hrEl?.value || '').trim();
      rec.meeting_hours = hrRaw === '' ? null : Number(hrRaw);
      records.push(rec);
    }
  });
  if (!records.length) { toast(t('ap.att.bulk_err_no_changes'), 'twarn'); return; }
  const r = await api('attendance.bulkRecord', { project_id: pid, records });
  if (r) {
    toast(t('ap.att.bulk_success', { n: r.inserted || r.saved || records.length }));
    closeModal('bulk-att');
    const flt = document.getElementById('flt-att-prj');
    if (flt && flt.value === pid) loadAttendance(pid);
  }
}
