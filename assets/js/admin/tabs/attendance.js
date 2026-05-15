// Attendance tab — both the single-row attendance form and the bulk-att
// modal (grid of avatar cards you click to cycle Present/Absent/Late/Excused).
//
// The bulk grid is intentionally kept in this file even though its modal is
// opened from the project-detail page (via projects.js → openModalWithPrj),
// because all its state and DOM lives in #ov-bulk-att and #bulk-att-grid.

import { DB, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, tag, fmtDate } from '../../lib/format.js';
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
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(t('ap.att.empty'))}</td></tr>`;
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
    const name = isMember
      ? (member ? esc(member.preferred_name || member.full_name) : esc(a.member_id))
      : esc(a.volunteer_email || '—');
    const typeLabel = isMember ? t(TYPE_KEY.Member) : t(TYPE_KEY.Volunteer);
    const statusLabel = ATT_STATUS_KEY[a.attendance_status]
      ? t(ATT_STATUS_KEY[a.attendance_status])
      : a.attendance_status;
    const checker = DB.members.find(m => m.member_id === a.checked_by_member_id);
    const projectCell = project
      ? `<div style="font-weight:600">${esc(project.project_name)}</div>
         <div style="font-size:.7rem;color:var(--tm)">${fmtDate(project.event_date)}</div>`
      : `<span style="color:var(--tm)">${esc(a.project_id)}</span>`;
    return `<tr>
      <td><strong>${name}</strong></td>
      <td>${projectCell}</td>
      <td>${tag(typeLabel, isMember ? 't-b' : 't-p')}</td>
      <td>${tag(statusLabel, STATUS_COLORS[a.attendance_status] || 't-gr')}</td>
      <td>${fmtDate(a.attendance_date) || '—'}</td>
      <td>${checker ? esc(checker.preferred_name || checker.full_name) : '—'}</td>
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
    return `<div class="att-card ${cls}"
      data-mid="${p.member_id || ''}" data-ve="${p.volunteer_email || ''}" data-tp="${p.participant_type}"
      data-st="${cs}"
      data-action="cycleAttStatus">
      <div class="att-av">${nm.charAt(0)}</div>
      <div><div class="att-nm">${nm}</div><div class="att-st">${esc(stLabel)}</div></div>
    </div>`;
  }).join('')}</div>`;
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
      records.push({
        member_id:       c.dataset.mid,
        volunteer_email: c.dataset.ve,
        participant_type:c.dataset.tp,
        attendance_status: st,
        attendance_date: new Date().toISOString().split('T')[0],
      });
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
