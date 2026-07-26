// Member "My attendance" tab (2026-07-27).
//
// Members self-record attendance for a project they took part in. The
// row lands as confirmation_status='Pending' with meeting_hours NULL
// (hours held in proposed_hours) so it credits nothing until a head or
// admin confirms it — see supabase/functions/api/actions/attendance.ts.

import { esc, gv, sv, fmtDate, tag } from '../../lib/format.js';
import { api, toast } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

const CONF_KEY = {
  Pending:   'mp.att.status_pending',
  Confirmed: 'mp.att.status_confirmed',
  Rejected:  'mp.att.status_rejected',
};
const CONF_CLS = { Pending: 't-y', Confirmed: 'tok', Rejected: 't-r' };

export async function loadSelfAttendance() {
  const [pRes, lRes] = await Promise.all([
    api('getProjects'),
    api('attendance.listOwn'),
  ]);

  const projects = ((pRes && pRes.success ? pRes.data : []) || [])
    .slice()
    .sort((a, b) => String(b.event_date || '').localeCompare(String(a.event_date || '')));
  const sel = document.getElementById('mp-att-project');
  if (sel) {
    sel.innerHTML = `<option value="">${esc(t('mp.att.pick_project'))}</option>` +
      projects.map(p => {
        const date = p.event_date ? ` (${fmtDate(p.event_date).replace(/<[^>]+>/g, '')})` : '';
        return `<option value="${esc(p.project_id)}">${esc(p.project_name)}${esc(date)}</option>`;
      }).join('');
  }

  _renderList((lRes && lRes.success ? lRes.data : []) || []);
}

function _renderList(rows) {
  const tb = document.getElementById('mp-att-tbody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = `<tr class="empty-row"><td colspan="4">${esc(t('mp.att.empty'))}</td></tr>`;
    return;
  }
  tb.innerHTML = rows.map(r => {
    const cs = r.confirmation_status || 'Pending';
    const label = CONF_KEY[cs] ? t(CONF_KEY[cs]) : cs;
    // Confirmed rows credit meeting_hours; pending/rejected show the claim.
    const hrs = cs === 'Confirmed' ? (r.meeting_hours ?? 0) : (r.proposed_hours ?? 0);
    const dateCell = String(r.recorded_at || '').split('T')[0] || '—';
    const reason = (cs === 'Rejected' && r.rejected_reason)
      ? `<div style="font-size:.68rem;color:var(--dn)">${esc(r.rejected_reason)}</div>` : '';
    return `<tr>
      <td><strong>${esc(r.project_name || r.project_id || '—')}</strong></td>
      <td>${esc(String(hrs))} <span style="color:var(--tm);font-size:.72rem">${esc(t('mp.hours.hours_unit'))}</span></td>
      <td>${tag(label, CONF_CLS[cs] || 't-gr')}</td>
      <td style="font-size:.72rem;color:var(--tm)">${esc(dateCell)}${reason}</td>
    </tr>`;
  }).join('');
}

export async function submitSelfAttendance() {
  const project_id = gv('mp-att-project');
  const hoursRaw = (gv('mp-att-hours') || '').trim();
  const notes = gv('mp-att-notes');
  if (!project_id) { toast(t('mp.att.err_pick_project'), 'twarn'); return; }

  const res = await api('attendance.recordOwn', {
    project_id,
    hours: hoursRaw === '' ? undefined : Number(hoursRaw),
    notes: notes || null,
  });
  if (!res || !res.success) {
    toast(localizeError(res?.error, res?.errorParams) || t('common.generic_error'), 'twarn');
    return;
  }
  toast(t('mp.att.success'), 'tok');
  sv('mp-att-project', '');
  sv('mp-att-hours', '');
  sv('mp-att-notes', '');
  loadSelfAttendance();
}
