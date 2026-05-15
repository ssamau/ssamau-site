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

// ── EMAILS / THANKS ──────────────────────────────────────────
export async function loadThanks(pid) {
  const d = await api('thanks.list', { project_id: pid });
  if (!d) return;
  const list = d.data || [];
  renderThanks(list);
  setEl('thx-total',   list.length);
  setEl('thx-sent',    list.filter(t => t.sent_status === 'Sent').length);
  setEl('thx-pending', list.filter(t => t.sent_status === 'Pending').length);
  setEl('thx-failed',  list.filter(t => t.sent_status === 'Failed').length);
}

export function renderThanks(list) {
  const tb = document.getElementById('tb-thanks');
  if (!tb) return;
  if (!list.length) { tb.innerHTML = '<tr class="empty-row"><td colspan="6">لا توجد رسائل</td></tr>'; return; }
  tb.innerHTML = list.map(t => {
    const m  = DB.members.find(mb => mb.member_id === t.member_id);
    const p  = DB.projects.find(pr => pr.project_id === t.project_id);
    const nm = t.participant_type === 'Member'
      ? esc(m ? (m.preferred_name || m.full_name) : t.member_id)
      : esc(t.volunteer_email || '—');
    const stCls = t.sent_status === 'Sent' ? 't-g' : t.sent_status === 'Failed' ? 't-r' : 't-y';
    return `<tr>
      <td><strong>${nm}</strong></td>
      <td style="font-size:.76rem">${esc(p ? p.project_name : t.project_id)}</td>
      <td style="font-size:.75rem;max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(t.email_subject || '—')}</td>
      <td>${t.hours_included ? '✅' : '—'}</td>
      <td>${tag(t.sent_status, stCls)}</td>
      <td style="font-size:.71rem;color:var(--tm)">${String(t.sent_at || '').split('T')[0] || '—'}</td>
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
  if (!body.project_id) { toast('اختر مشروعاً', 'twarn'); return; }
  if (!body.recipient_email && body.member_id) {
    toast('⚠️ العضو المختار ليس له بريد إلكتروني مسجّل — تواصل معه يدوياً', 'twarn');
    return;
  }
  const r = await api('thanks.send', body);
  if (r && r.success && r.data) {
    const st = r.data.status;
    toast(st === 'Sent' ? '📧 أُرسل' : '⚠️ فشل الإرسال — تحقّق من البريد', st === 'Sent' ? 'tok' : 'twarn');
    closeModal('thanks');
    ['thx-sb','thx-bd'].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
    loadThanks('');
  }
}

export async function saveBulkThanks() {
  const pid = gv('bthx-prj');
  if (!pid) { toast('اختر مشروعاً', 'twarn'); return; }
  toast('⏳ جاري الإرسال...', 'twarn');
  // bulkSend reads `subject` + `message` at top level, NOT inside an
  // `options` nest — that nesting was the older Apps-Script-era shape.
  const r = await api('thanks.bulkSend', {
    project_id: pid,
    subject:    gv('bthx-sb'),
    message:    gv('bthx-msg'),
  });
  if (r && r.success && r.data) {
    const { sent = 0, failed = 0, count = 0 } = r.data;
    toast(`✅ أُرسل: ${sent} / ${count} | فشل: ${failed}`, failed === 0 ? 'tok' : 'twarn');
    closeModal('bulk-thanks');
    loadThanks('');
  }
}
