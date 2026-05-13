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
  const body = {
    project_id:           gv('thx-prj'),
    participant_type:     gv('thx-tp'),
    member_id:            gv('thx-mbr'),
    email_subject:        gv('thx-sb'),
    email_body:           gv('thx-bd'),
    hours_included:       !!document.getElementById('thx-hi')?.checked,
    outstanding_included: !!document.getElementById('thx-oi')?.checked,
  };
  if (!body.project_id) { toast('اختر مشروعاً', 'twarn'); return; }
  const r = await api('thanks.send', body);
  if (r) {
    toast(`📧 ${r.sent_status}`);
    closeModal('thanks');
    ['thx-sb','thx-bd'].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
    loadThanks('');
  }
}

export async function saveBulkThanks() {
  const pid = gv('bthx-prj');
  if (!pid) { toast('اختر مشروعاً', 'twarn'); return; }
  toast('⏳ جاري الإرسال...', 'twarn');
  const r = await api('thanks.bulkSend', {
    project_id: pid,
    options: {
      subject:        gv('bthx-sb'),
      custom_message: gv('bthx-msg'),
      hours_included: !!document.getElementById('bthx-hi')?.checked,
      outstanding_included: !!document.getElementById('bthx-oi')?.checked,
    }
  });
  if (r) {
    toast(`✅ أُرسل: ${r.sent} | تخطي: ${r.skipped || 0} | فشل: ${r.failed || 0}`);
    closeModal('bulk-thanks');
    loadThanks('');
  }
}
