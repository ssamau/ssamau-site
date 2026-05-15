// Attendance tab — both the single-row attendance form and the bulk-att
// modal (grid of avatar cards you click to cycle Present/Absent/Late/Excused).
//
// The bulk grid is intentionally kept in this file even though its modal is
// opened from the project-detail page (via projects.js → openModalWithPrj),
// because all its state and DOM lives in #ov-bulk-att and #bulk-att-grid.

import { DB, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, tag, fmtDate } from '../../lib/format.js';
import { api, toast, closeModal } from '../../lib/ui.js';

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
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">لا يوجد حضور مسجّل بعد</td></tr>';
    return;
  }
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
    const typeLabel = isMember ? 'Member' : 'Volunteer';
    const checker = DB.members.find(m => m.member_id === a.checked_by_member_id);
    const projectCell = project
      ? `<div style="font-weight:600">${esc(project.project_name)}</div>
         <div style="font-size:.7rem;color:var(--tm)">${fmtDate(project.event_date)}</div>`
      : `<span style="color:var(--tm)">${esc(a.project_id)}</span>`;
    return `<tr>
      <td><strong>${name}</strong></td>
      <td>${projectCell}</td>
      <td>${tag(typeLabel, isMember ? 't-b' : 't-p')}</td>
      <td>${tag(a.attendance_status, STATUS_COLORS[a.attendance_status] || 't-gr')}</td>
      <td>${fmtDate(a.attendance_date) || '—'}</td>
      <td>${checker ? esc(checker.preferred_name || checker.full_name) : '—'}</td>
      <td>
        <button class="btn-icon del" data-action="confirmDelete" data-type="attendance" data-id="${a.attendance_id}" data-name="سجل الحضور هذا">🗑️</button>
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
  if (!body.project_id || !body.attendance_status) { toast('المشروع وحالة الحضور مطلوبان', 'twarn'); return; }
  const res = await api('recordAttendance', body);
  if (res) {
    toast('✅ تم تسجيل الحضور');
    closeModal('attendance');
    if (document.getElementById('attendance-project-filter').value === body.project_id) {
      loadAttendance(body.project_id);
    }
  }
}

export function toggleAttFields() {
  const t = gv('att-type');
  document.getElementById('att-member-section').style.display = t === 'Member' ? '' : 'none';
  document.getElementById('att-vol-section').style.display    = t === 'Volunteer' ? '' : 'none';
}

// ── BULK ATTENDANCE ──────────────────────────────────────────
export async function loadBulkAttGrid(pid) {
  if (!pid) return;
  const grid = document.getElementById('bulk-att-grid');
  grid.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>جاري التحميل...</div>';
  const [pRes, aRes] = await Promise.all([
    api('participants.list', { project_id: pid }),
    api('attendance.list',   { project_id: pid })
  ]);
  const pars     = pRes?.data || [];
  const existing = aRes?.data || [];
  if (!pars.length) {
    grid.innerHTML = '<p style="color:var(--tm);font-size:.82rem">لا يوجد مشاركون في هذه الفعالية</p>';
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
    return `<div class="att-card ${cls}"
      data-mid="${p.member_id || ''}" data-ve="${p.volunteer_email || ''}" data-tp="${p.participant_type}"
      data-action="cycleAttStatus">
      <div class="att-av">${nm.charAt(0)}</div>
      <div><div class="att-nm">${nm}</div><div class="att-st">${cs || '—'}</div></div>
    </div>`;
  }).join('')}</div>`;
}

export function cycleAttStatus(card) {
  const cycle = ['Present','Absent','Late','Excused',''];
  const stEl  = card.querySelector('.att-st');
  const curr  = stEl.textContent === '—' ? '' : stEl.textContent;
  const next  = cycle[(cycle.indexOf(curr) + 1) % cycle.length];
  stEl.textContent = next || '—';
  card.className = 'att-card' +
    (next === 'Present' ? ' present' : next === 'Absent' ? ' absent' : next === 'Late' ? ' late' : next === 'Excused' ? ' excused' : '');
}

export function markAllAtt(status) {
  document.querySelectorAll('#bulk-att-grid .att-card').forEach(c => {
    c.querySelector('.att-st').textContent = status;
    c.className = 'att-card ' + (status === 'Present' ? 'present' : status === 'Absent' ? 'absent' : 'late');
  });
}

export async function saveBulkAttendance() {
  const pid = gv('batt-prj');
  if (!pid) { toast('اختر مشروعاً', 'twarn'); return; }
  const records = [];
  document.querySelectorAll('#bulk-att-grid .att-card').forEach(c => {
    const st = c.querySelector('.att-st').textContent;
    if (st && st !== '—') {
      records.push({
        member_id:       c.dataset.mid,
        volunteer_email: c.dataset.ve,
        participant_type:c.dataset.tp,
        attendance_status: st,
        attendance_date: new Date().toISOString().split('T')[0],
      });
    }
  });
  if (!records.length) { toast('لا توجد تغييرات', 'twarn'); return; }
  const r = await api('attendance.bulkRecord', { project_id: pid, records });
  if (r) {
    toast(`✅ حُفظ ${r.inserted || r.saved || records.length} سجل حضور`);
    closeModal('bulk-att');
    const flt = document.getElementById('flt-att-prj');
    if (flt && flt.value === pid) loadAttendance(pid);
  }
}
