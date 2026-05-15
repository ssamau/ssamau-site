// Assignments tab — member portal (Phase 5c/5e of Branch 4).
//
// Calls assignments.listOwn (added in 5a). Splits the rows into
// Upcoming (event_date >= today OR event_date is null) and Past
// (event_date < today) so the member sees what's coming first.
//
// Phase 5e adds a self-service "log hours" button on every row where
// attendance_status === 'Attended' AND no hours row already exists.
// Clicking opens the #ov-log-hours modal; submitting calls the
// hours.recordOwn action which inserts at approval_status='Draft' so
// the row flows through the §7 two-stage chain (head → presidency).

import { api, toast } from '../../lib/ui.js';
import { esc, fmtDate, gv, sv } from '../../lib/format.js';

const ATTENDANCE_LABEL_AR = {
  Pending:  'قيد الانتظار',
  Attended: 'حضرت',
  Absent:   'غبت',
  Excused:  'معذور',
};

// Set of assignment_ids the member has ALREADY logged hours for (any
// status — Draft / PrimaryApproved / FinalApproved / Rejected). Used
// to decide whether the row gets a "log hours" button or a "submitted"
// badge. Refreshed every loadAssignments() call.
const _hoursLogged = new Set();
// Per-modal-open state: stash the assignment we're logging hours for.
let _activeLogContext = null;

export async function loadAssignments() {
  const upBody = document.getElementById('assignments-upcoming-tbody');
  const paBody = document.getElementById('assignments-past-tbody');
  if (!upBody || !paBody) return;
  upBody.innerHTML = '<tr class="empty-row"><td colspan="6">جاري التحميل...</td></tr>';
  paBody.innerHTML = '<tr class="empty-row"><td colspan="6">—</td></tr>';

  // Two fetches in parallel: assignments + own hours. The hours fetch
  // is what tells us which assignments are already logged. Both are
  // small queries scoped to one member.
  const [assignmentsRes, hoursRes] = await Promise.all([
    api('assignments.listOwn'),
    api('hours.listOwn'),
  ]);
  if (!assignmentsRes || !assignmentsRes.success) {
    upBody.innerHTML = '<tr class="empty-row"><td colspan="6" style="color:var(--dn)">تعذّر التحميل</td></tr>';
    paBody.innerHTML = '<tr class="empty-row"><td colspan="6">—</td></tr>';
    return;
  }
  const rows = assignmentsRes.data || [];

  // Build the set of logged assignment_ids. Failure on the hours
  // fetch is non-fatal — we just leave the set empty and every
  // attended row shows a fresh button. The server will 409 if they
  // actually try to double-submit.
  _hoursLogged.clear();
  if (hoursRes && hoursRes.success) {
    for (const h of (hoursRes.data || [])) {
      if (h.assignment_id) _hoursLogged.add(h.assignment_id);
    }
  }

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
    : '<tr class="empty-row"><td colspan="6" style="color:var(--tm)">لا توجد مهام قادمة</td></tr>';

  paBody.innerHTML = past.length
    ? past.map(renderRow).join('')
    : '<tr class="empty-row"><td colspan="6" style="color:var(--tm)">لا توجد مهام سابقة</td></tr>';
}

function renderRow(a) {
  return `
    <tr>
      <td><strong>${esc(a.role_name) || '—'}</strong></td>
      <td>${esc(a.project_name) || '—'}</td>
      <td>${fmtDate(a.event_date) || '—'}</td>
      <td>${esc(a.location) || '—'}</td>
      <td>${ATTENDANCE_LABEL_AR[a.attendance_status] || esc(a.attendance_status) || '—'}</td>
      <td>${renderHoursCell(a)}</td>
    </tr>
  `;
}

// Hours cell logic — one of three states per row:
//   1. Not attended yet (Pending / Absent / Excused / no status) →
//      em-dash, nothing to log.
//   2. Attended + already submitted hours → green "✓ مسجَّلة" badge.
//   3. Attended + no hours yet → button that opens the log modal.
function renderHoursCell(a) {
  if (a.attendance_status !== 'Attended') {
    return '<span style="color:var(--tm)">—</span>';
  }
  if (_hoursLogged.has(a.assignment_id)) {
    return '<span class="hs-badge hs-finalapproved">✓ مسجَّلة</span>';
  }
  // Encode the assignment_id + role + estimated_hours into data-*
  // attrs so the dispatcher can pop the modal without an array index
  // lookup. JSON.stringify would also work but data-* keys are
  // cheaper to read.
  return `
    <button class="btn btn-g btn-sm"
            data-action="openLogHours"
            data-assignment="${esc(a.assignment_id)}"
            data-role="${esc(a.role_name || '')}"
            data-project="${esc(a.project_name || '')}"
            data-estimated="${a.estimated_hours || 0}"
            style="font-size:.72rem;padding:.3rem .7rem">
      📝 سجّل
    </button>
  `;
}

// ─── Log-hours modal ────────────────────────────────────────────────

export function openLogHoursModal(assignmentId, role, project, estimated) {
  _activeLogContext = { assignment_id: assignmentId };
  // Header strip + estimated-hours hint
  document.getElementById('logh-role').textContent    = role || '—';
  document.getElementById('logh-project').textContent = project || '—';
  const est = parseFloat(estimated) || 0;
  const note = document.getElementById('logh-est-note');
  if (est > 0) {
    document.getElementById('logh-est').textContent = est;
    note.style.display = '';
    // Pre-fill hours_during with the estimated value as a starting
    // point — the member can edit. Common case: estimate was right
    // and they tap submit unchanged.
    sv('logh-during', est);
  } else {
    note.style.display = 'none';
    sv('logh-during', 0);
  }
  // Reset the other fields each open so a previous abandoned submit
  // doesn't leak values into the next event.
  sv('logh-before', 0);
  sv('logh-after',  0);
  sv('logh-notes',  '');
  const btn = document.getElementById('logh-submit-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'إرسال للموافقة'; }
  document.getElementById('ov-log-hours').classList.add('open');
}

export function closeLogHoursModal() {
  document.getElementById('ov-log-hours').classList.remove('open');
  _activeLogContext = null;
}

export async function submitLogHours() {
  if (!_activeLogContext) return;
  const before = parseFloat(gv('logh-before')) || 0;
  const during = parseFloat(gv('logh-during')) || 0;
  const after  = parseFloat(gv('logh-after'))  || 0;
  if (before + during + after <= 0) {
    toast('أدخل ساعات أكبر من صفر.', 'twarn');
    return;
  }
  const btn = document.getElementById('logh-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'جاري الإرسال...'; }
  try {
    const res = await api('hours.recordOwn', {
      data: {
        assignment_id: _activeLogContext.assignment_id,
        hours_before:  before,
        hours_during:  during,
        hours_after:   after,
        notes:         gv('logh-notes') || null,
      },
    });
    if (!res || !res.success) {
      toast(res?.error || 'فشل التسجيل.', 'twarn');
      if (btn) { btn.disabled = false; btn.textContent = 'إرسال للموافقة'; }
      return;
    }
    toast('تم إرسال ساعاتك. ستظهر في تبويب الساعات بانتظار موافقة رئيس اللجنة.', 'tok');
    closeLogHoursModal();
    // Mark logged in-memory + refresh the rendered tables so the
    // button flips to "✓ مسجَّلة" without a full reload.
    _hoursLogged.add(_activeLogContext?.assignment_id);
    await loadAssignments();
  } catch (err) {
    console.error('[submitLogHours]', err);
    if (btn) { btn.disabled = false; btn.textContent = 'إرسال للموافقة'; }
  }
}
