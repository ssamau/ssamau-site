// Head Emails / Thanks tab — single + bulk thank-you emails, scoped
// to projects owned by the head's committee.
//
// Server-side `thanks.list` auto-scopes for heads (no project_id given
// → narrows to owning_committee_id = head's committee). `thanks.send`
// and `thanks.bulkSend` enforce the same scope via ensureProjectScope
// + ensureMemberScope. Frontend filters the dropdowns to match so the
// UX never offers an option that will server-reject.

import { esc, gv, sv, tag, setEl } from '../../lib/format.js';
import { api, apiGet, toast, closeModal } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';

// Module-level caches so re-renders + language toggles don't refetch.
// _members and _projects are filtered to the head's committee at load
// time, so any select-populator that walks them is automatically scoped.
let _members  = [];
let _projects = [];
let _thanks   = [];

const THX_STATUS_KEY = {
  Sent:    'ap.eml.status_sent',
  Pending: 'ap.eml.status_pending',
  Failed:  'ap.eml.status_failed',
};

// ── LOAD ─────────────────────────────────────────────────────────────
// On entry the tab fetches projects + members (scoped) + thanks rows in
// parallel. getMembers/getProjects are global; we filter to the head's
// committee client-side.
export async function loadHeadEmails() {
  await _ensureRoster();
  await _refreshThanks(gv('hd-flt-thx-prj'));
  _populateThanksSelects();
}

async function _ensureRoster() {
  // Refresh roster every tab entry — small payloads, and stale lists
  // would show projects/members that have changed since first load.
  const myCommittee = window.CURRENT_USER?.committee_id;
  const [mRes, pRes] = await Promise.all([
    apiGet('getMembers'),
    apiGet('getProjects'),
  ]);
  _members  = (mRes?.data || []).filter(m => m.status !== 'Inactive' && (!myCommittee || m.committee_id === myCommittee));
  _projects = (pRes?.data || []).filter(p => !myCommittee || p.owning_committee_id === myCommittee);
}

async function _refreshThanks(projectId) {
  const res = await api('thanks.list', projectId ? { project_id: projectId } : {});
  if (!res || !res.success) return;
  _thanks = res.data || [];
  setEl('hd-thx-total',   _thanks.length);
  setEl('hd-thx-sent',    _thanks.filter(r => r.status === 'Sent').length);
  setEl('hd-thx-pending', _thanks.filter(r => r.status === 'Pending').length);
  setEl('hd-thx-failed',  _thanks.filter(r => r.status === 'Failed').length);
  _render();
}

function _render() {
  const tb = document.getElementById('hd-tb-thanks');
  if (!tb) return;
  if (!_thanks.length) {
    tb.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('ap.eml.empty'))}</td></tr>`;
    return;
  }
  tb.innerHTML = _thanks.map(row => {
    const recipient = row.preferred_name || row.full_name || row.recipient_email || '—';
    const stCls   = row.status === 'Sent' ? 't-g' : row.status === 'Failed' ? 't-r' : 't-y';
    const stLabel = THX_STATUS_KEY[row.status] ? t(THX_STATUS_KEY[row.status]) : (row.status || '—');
    return `<tr>
      <td><strong>${esc(recipient)}</strong></td>
      <td style="font-size:.76rem">${esc(row.project_name || row.project_id || '—')}</td>
      <td style="font-size:.75rem;max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(row.subject || '—')}</td>
      <td>${row.hours_included ? '✅' : '—'}</td>
      <td>${tag(stLabel, stCls)}</td>
      <td style="font-size:.71rem;color:var(--tm)">${String(row.sent_at || '').split('T')[0] || '—'}</td>
    </tr>`;
  }).join('');
}

// ── SELECT POPULATION ────────────────────────────────────────────────
// Fill every project + member select on the page with the scoped roster.
// Called after loadHeadEmails completes, AND every time a modal opens
// (in case the head bounced to another tab and added a member).
function _populateThanksSelects() {
  _fillProjectSelect('hd-flt-thx-prj', true);
  _fillProjectSelect('hd-thx-prj',     false);
  _fillProjectSelect('hd-bthx-prj',    false);
  _fillMemberSelect('hd-thx-mbr');
}

function _fillProjectSelect(id, includeAll) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const prev = sel.value;
  const opts = _projects.map(p => `<option value="${esc(p.project_id)}">${esc(p.project_name)}</option>`).join('');
  // Always rebuild instead of appending — caller toggles language and
  // empty-state labels need to reflect the new locale.
  sel.innerHTML = includeAll
    ? `<option value="">${esc(t('ap.eml.filter_all_projects'))}</option>${opts}`
    : `<option value="">${esc(t('ap.prj.choose'))}</option>${opts}`;
  if (prev) sel.value = prev;
}

function _fillMemberSelect(id) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">${esc(t('ap.prj.choose'))}</option>` +
    _members.map(m => `<option value="${esc(m.member_id)}">${esc(m.preferred_name || m.full_name)}</option>`).join('');
  if (prev) sel.value = prev;
}

// ── FILTERS ──────────────────────────────────────────────────────────
export function filterHeadThanks() {
  _refreshThanks(gv('hd-flt-thx-prj'));
}

// ── ACTIONS ──────────────────────────────────────────────────────────
export async function sendHeadThanks() {
  _populateThanksSelects();
  const mid = gv('hd-thx-mbr');
  const m   = _members.find(mb => mb.member_id === mid);
  const body = {
    project_id:      gv('hd-thx-prj'),
    member_id:       mid,
    recipient_email: m ? (m.email || '') : '',
    subject:         gv('hd-thx-sb'),
    message:         gv('hd-thx-bd'),
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
    closeModal('hd-thanks');
    ['hd-thx-sb','hd-thx-bd'].forEach(id => sv(id, ''));
    _refreshThanks(gv('hd-flt-thx-prj'));
  }
}

export async function bulkSendHeadThanks() {
  const pid = gv('hd-bthx-prj');
  if (!pid) { toast(t('ap.eml.err_pick_project'), 'twarn'); return; }
  toast(t('ap.eml.bulk_sending'), 'twarn');
  const r = await api('thanks.bulkSend', {
    project_id: pid,
    subject:    gv('hd-bthx-sb'),
    message:    gv('hd-bthx-msg'),
  });
  if (r && r.success && r.data) {
    const { sent = 0, failed = 0, count = 0 } = r.data;
    toast(t('ap.eml.bulk_result', { sent, count, failed }), failed === 0 ? 'tok' : 'twarn');
    closeModal('hd-bulk-thanks');
    _refreshThanks(gv('hd-flt-thx-prj'));
  }
}

// Called by main.js openModal hook so the picker is fresh every time
// the modal opens (catches changes from other tabs in the same session).
export function onHeadEmailsModalOpen() {
  _populateThanksSelects();
}
