// Emails / Thanks tab — single-send + bulk-send thank-you emails per project.
//
// "saveThanks" sends one targeted email for one (project, participant) pair.
// "saveBulkThanks" hits thanks.bulkSend which iterates over everyone in the
// project and sends them all (the server is the one that loops to avoid a
// chatty client). Both write back via toast — bulk shows sent/skipped/failed
// counts since partial failures are normal at that scale.

import { DB } from '../../lib/state.js';
import { esc, gv, tag, setEl, fmtDateTime } from '../../lib/format.js';
import { api, toast, closeModal, withBusyButton } from '../../lib/ui.js';
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
// Field names below match thanks_emails columns directly (status,
// subject, recipient_email, sent_at). An earlier port from Apps Script
// left this file reading sent_status / email_subject / participant_type
// / volunteer_email / hours_included — none of which exist on the
// table — so every row rendered as em-dashes regardless of actual data.
// 2026-05-20 fix.
export async function loadThanks(pid) {
  const d = await api('thanks.list', { project_id: pid });
  if (!d) return;
  const list = d.data || [];
  renderThanks(list);
  setEl('thx-total',   list.length);
  setEl('thx-sent',    list.filter(row => row.status === 'Sent').length);
  setEl('thx-pending', list.filter(row => row.status === 'Pending').length);
  setEl('thx-failed',  list.filter(row => row.status === 'Failed').length);
}

export function renderThanks(list) {
  const tb = document.getElementById('tb-thanks');
  if (!tb) return;
  if (!list.length) { tb.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('ap.eml.empty'))}</td></tr>`; return; }
  // Local var name `row` (not `t`) so we don't shadow the imported i18n
  // helper inside the map callback.
  tb.innerHTML = list.map(row => {
    // Resolve display name in this order: joined member (server returns
    // preferred_name / full_name), then DB.members lookup (covers
    // members not in the current page's cache), then recipient_email,
    // then em-dash. Always works for both member and external-email
    // recipients without a synthetic participant_type flag.
    const m  = DB.members.find(mb => mb.member_id === row.member_id);
    const p  = DB.projects.find(pr => pr.project_id === row.project_id);
    const memberName = row.preferred_name || row.full_name
                     || (m ? (m.preferred_name || m.full_name) : '');
    const nm = memberName
      ? `<strong>${esc(memberName)}</strong>${row.recipient_email ? `<div style="font-size:.66rem;color:var(--tm);direction:ltr">${esc(row.recipient_email)}</div>` : ''}`
      : (row.recipient_email
          ? `<span dir="ltr">${esc(row.recipient_email)}</span>`
          : '—');
    const stCls   = row.status === 'Sent' ? 't-g' : row.status === 'Failed' ? 't-r' : 't-y';
    const stLabel = THX_STATUS_KEY[row.status] ? t(THX_STATUS_KEY[row.status]) : (row.status || '—');
    const hrs = (row.recorded_hours != null && Number(row.recorded_hours) > 0)
      ? `<strong style="color:var(--g)">${Number(row.recorded_hours)}</strong>`
      : '—';
    const projectName = row.project_name || (p ? p.project_name : row.project_id) || '—';
    const sentBy = row.sent_by_username ? esc(row.sent_by_username) : '—';
    const sentAt = row.sent_at ? fmtDateTime(row.sent_at) : '';
    return `<tr>
      <td>${nm}</td>
      <td style="font-size:.76rem">${esc(projectName)}</td>
      <td style="font-size:.75rem;max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(row.subject || '—')}</td>
      <td>${hrs}</td>
      <td>${tag(stLabel, stCls)}</td>
      <td style="font-size:.71rem;color:var(--tm);line-height:1.4">
        ${sentAt ? `<div>${sentAt}</div>` : '<div>—</div>'}
        <div>${esc(t('ap.eml.sent_by_lbl'))}: ${sentBy}</div>
      </td>
    </tr>`;
  }).join('');
}

// `el` is the button the dispatcher called us from. withBusyButton
// disables it for the duration of the request — the duplicate-send fix
// reported 2026-05-20 (rapid double-tap was firing two thanks.send
// calls before the modal closed). Single source of truth for "is this
// button still in flight" lives on btn.dataset.busy.
export async function saveThanks(el) {
  return withBusyButton(el, '⏳ ' + t('common.sending'), async () => {
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
  });
}

export async function saveBulkThanks(el) {
  return withBusyButton(el, '⏳ ' + t('common.sending'), async () => {
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
  });
}
