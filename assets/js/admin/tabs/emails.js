// Emails / Thanks tab — single-send + bulk-send thank-you emails per project.
//
// "saveThanks" sends one targeted email for one (project, participant) pair.
// "saveBulkThanks" hits thanks.bulkSend which iterates over everyone in the
// project and sends them all (the server is the one that loops to avoid a
// chatty client). Both write back via toast — bulk shows sent/skipped/failed
// counts since partial failures are normal at that scale.

import { DB } from '../../lib/state.js';
import { esc, gv, tag, setEl } from '../../lib/format.js';
import { api, toast, closeModal } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';

// Thanks delivery-status enum → translation key. STATUS_COLORS isn't
// used here because the chip colour rules are bespoke (Sent → green,
// Failed → red, Pending → yellow), so the class string is built
// inline below.
const THX_STATUS_KEY = {
  Sent:    'ap.eml.status_sent',
  Pending: 'ap.eml.status_pending',
  Failed:  'ap.eml.status_failed',
};

// ── EMAILS / THANKS ──────────────────────────────────────────
export async function loadThanks(pid) {
  const d = await api('thanks.list', { project_id: pid });
  if (!d) return;
  const list = d.data || [];
  renderThanks(list);
  setEl('thx-total',   list.length);
  setEl('thx-sent',    list.filter(row => row.sent_status === 'Sent').length);
  setEl('thx-pending', list.filter(row => row.sent_status === 'Pending').length);
  setEl('thx-failed',  list.filter(row => row.sent_status === 'Failed').length);
}

export function renderThanks(list) {
  const tb = document.getElementById('tb-thanks');
  if (!tb) return;
  if (!list.length) { tb.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('ap.eml.empty'))}</td></tr>`; return; }
  // Local var name `row` (not `t`) so we don't shadow the imported i18n
  // helper inside the map callback.
  tb.innerHTML = list.map(row => {
    const m  = DB.members.find(mb => mb.member_id === row.member_id);
    const p  = DB.projects.find(pr => pr.project_id === row.project_id);
    const nm = row.participant_type === 'Member'
      ? esc(m ? (m.preferred_name || m.full_name) : row.member_id)
      : esc(row.volunteer_email || '—');
    const stCls   = row.sent_status === 'Sent' ? 't-g' : row.sent_status === 'Failed' ? 't-r' : 't-y';
    const stLabel = THX_STATUS_KEY[row.sent_status] ? t(THX_STATUS_KEY[row.sent_status]) : row.sent_status;
    return `<tr>
      <td><strong>${nm}</strong></td>
      <td style="font-size:.76rem">${esc(p ? p.project_name : row.project_id)}</td>
      <td style="font-size:.75rem;max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(row.email_subject || '—')}</td>
      <td>${row.hours_included ? '✅' : '—'}</td>
      <td>${tag(stLabel, stCls)}</td>
      <td style="font-size:.71rem;color:var(--tm)">${String(row.sent_at || '').split('T')[0] || '—'}</td>
    </tr>`;
  }).join('');
}

export async function saveThanks() {
  // Edge Function `thanks.send` expects:
  //   { project_id, member_id, recipient_email, subject, message }
  // The admin form historically sent `email_subject` / `email_body` —
  // those names date back to the Apps Script port and were never
  // updated when SMTP delivery got wired in (PR #22). Result: the
  // server saw subject/message as undefined, used defaults, AND
  // recipient_email was always missing so sendEmail was skipped and
  // no row even reached the DB (the upsert chain bailed early).
  // Now sending the right names + looking up the member's email
  // from DB.members.
  const mid = gv('thx-mbr');
  const m   = DB.members.find(mb => mb.member_id === mid);
  const recipient_email = m ? (m.email || '') : '';
  const body = {
    project_id:       gv('thx-prj'),
    member_id:        mid,
    recipient_email,
    subject:          gv('thx-sb'),
    message:          gv('thx-bd'),
  };
  if (!body.project_id) { toast(t('ap.eml.err_pick_project'), 'twarn'); return; }
  if (!body.recipient_email && body.member_id) {
    toast(t('ap.eml.err_no_email'), 'twarn');
    return;
  }
  const r = await api('thanks.send', body);
  if (r && r.success && r.data) {
    const st = r.data.status;
    toast(st === 'Sent' ? t('ap.eml.success_sent') : t('ap.eml.fail_sent'), st === 'Sent' ? 'tok' : 'twarn');
    closeModal('thanks');
    ['thx-sb','thx-bd'].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
    loadThanks('');
  }
}

export async function saveBulkThanks() {
  const pid = gv('bthx-prj');
  if (!pid) { toast(t('ap.eml.err_pick_project'), 'twarn'); return; }
  toast(t('ap.eml.bulk_sending'), 'twarn');
  // bulkSend reads `subject` + `message` at top level, NOT inside an
  // `options` nest — that nesting was the older Apps-Script-era shape.
  const r = await api('thanks.bulkSend', {
    project_id: pid,
    subject:    gv('bthx-sb'),
    message:    gv('bthx-msg'),
  });
  if (r && r.success && r.data) {
    const { sent = 0, failed = 0, count = 0 } = r.data;
    toast(t('ap.eml.bulk_result', { sent, count, failed }), failed === 0 ? 'tok' : 'twarn');
    closeModal('bulk-thanks');
    loadThanks('');
  }
}
