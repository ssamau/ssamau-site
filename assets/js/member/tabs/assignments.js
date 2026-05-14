// Assignments tab — member portal (Phase 5c of Branch 4).
//
// Calls assignments.listOwn (added in 5a). Splits the rows into
// Upcoming (event_date >= today OR event_date is null) and Past
// (event_date < today) so the member sees what's coming first.
// Cross-midnight precision doesn't matter here — events run for a
// day or more, so an event "today" is upcoming until it ends.

import { api } from '../../lib/ui.js';
import { esc, fmtDate } from '../../lib/format.js';

const ATTENDANCE_LABEL_AR = {
  Pending:  'قيد الانتظار',
  Attended: 'حضرت',
  Absent:   'غبت',
  Excused:  'معذور',
};

export async function loadAssignments() {
  const upBody = document.getElementById('assignments-upcoming-tbody');
  const paBody = document.getElementById('assignments-past-tbody');
  if (!upBody || !paBody) return;
  upBody.innerHTML = '<tr class="empty-row"><td colspan="5">جاري التحميل...</td></tr>';
  paBody.innerHTML = '<tr class="empty-row"><td colspan="5">—</td></tr>';

  const res = await api('assignments.listOwn');
  if (!res || !res.success) {
    upBody.innerHTML = '<tr class="empty-row"><td colspan="5" style="color:var(--dn)">تعذّر التحميل</td></tr>';
    paBody.innerHTML = '<tr class="empty-row"><td colspan="5">—</td></tr>';
    return;
  }
  const rows = res.data || [];

  // Split by event_date. Today (UTC date) counts as Upcoming because
  // the event is happening or about to happen. Past = event_date is
  // strictly older. event_date NULL = Upcoming (assumed unscheduled,
  // shouldn't drop off the radar).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const upcoming = [];
  const past     = [];
  for (const r of rows) {
    if (!r.event_date) { upcoming.push(r); continue; }
    const ev = new Date(r.event_date);
    if (ev >= today) upcoming.push(r); else past.push(r);
  }

  upBody.innerHTML = upcoming.length
    ? upcoming.map(renderRow).join('')
    : '<tr class="empty-row"><td colspan="5" style="color:var(--tm)">لا توجد مهام قادمة</td></tr>';

  paBody.innerHTML = past.length
    ? past.map(renderRow).join('')
    : '<tr class="empty-row"><td colspan="5" style="color:var(--tm)">لا توجد مهام سابقة</td></tr>';
}

function renderRow(a) {
  return `
    <tr>
      <td><strong>${esc(a.role_name) || '—'}</strong></td>
      <td>${esc(a.project_name) || '—'}</td>
      <td>${fmtDate(a.event_date) || '—'}</td>
      <td>${esc(a.location) || '—'}</td>
      <td>${ATTENDANCE_LABEL_AR[a.attendance_status] || esc(a.attendance_status) || '—'}</td>
    </tr>
  `;
}
