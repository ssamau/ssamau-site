// Admin support inbox — superadmin-only view of every submitted
// support ticket. Lists the queue with category + status chips, and a
// detail modal that surfaces full text, repro steps, page URL, user
// agent, viewport, attachment, and four status-change buttons.
//
// Server is the authority on the superadmin gate (support.list /
// updateStatus / getAttachment all require it). Sidebar entry is also
// hidden on boot for non-superadmin admins so non-presidency members
// never see the tab.

import { esc, tag, fmtDate } from '../../lib/format.js';
import { api, toast, openModal, closeModal } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

const CATEGORY_KEY = {
  Bug:      'support.cat_bug',
  Feature:  'support.cat_feature',
  Question: 'support.cat_question',
};
const CATEGORY_CLR = {
  Bug:      't-r',
  Feature:  't-b',
  Question: 't-y',
};
const STATUS_KEY = {
  Open:       'support.status_open',
  InProgress: 'support.status_in_progress',
  Resolved:   'support.status_resolved',
  Closed:     'support.status_closed',
};
const STATUS_CLR = {
  Open:       't-r',
  InProgress: 't-y',
  Resolved:   't-g',
  Closed:     't-gr',
};

let _tickets   = [];
let _activeTkt = null;

export async function loadSupportTickets() {
  const res = await api('support.list', {});
  if (!res || !res.success) return;
  _tickets = res.data || [];
  _renderList();
}

function _renderList() {
  const tbody = document.getElementById('sup-list-tbody');
  if (!tbody) return;
  if (!_tickets.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('support.empty'))}</td></tr>`;
    return;
  }
  tbody.innerHTML = _tickets.map(rec => {
    const catLbl = CATEGORY_KEY[rec.category] ? t(CATEGORY_KEY[rec.category]) : rec.category;
    const stLbl  = STATUS_KEY[rec.status]     ? t(STATUS_KEY[rec.status])     : rec.status;
    const reporter = rec.reporter_name
      ? `<div style="font-weight:600">${esc(rec.reporter_name)}</div>
         ${rec.reporter_access ? `<div style="font-size:.7rem;color:var(--tm)">${esc(rec.reporter_access)}</div>` : ''}`
      : '<span style="color:var(--tm)">—</span>';
    const attachmentIcon = rec.attachment_path ? '📎 ' : '';
    return `<tr>
      <td><code style="font-size:.7rem;color:var(--tm);direction:ltr">${esc(rec.ticket_id)}</code></td>
      <td>${tag(catLbl, CATEGORY_CLR[rec.category] || 't-gr')}</td>
      <td>
        <div style="font-weight:600">${attachmentIcon}${esc(rec.title)}</div>
        <div style="font-size:.72rem;color:var(--tm);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(rec.description.slice(0, 120))}</div>
      </td>
      <td>${reporter}</td>
      <td>${tag(stLbl, STATUS_CLR[rec.status] || 't-gr')}</td>
      <td style="font-size:.72rem;color:var(--tm)">${fmtDate(rec.created_at) || '—'}</td>
      <td><button class="btn-icon" data-action="openSupportTicket" data-id="${esc(rec.ticket_id)}" title="${esc(t('support.row_view_title'))}">👁️</button></td>
    </tr>`;
  }).join('');
}

export async function openSupportTicket(ticketId) {
  _activeTkt = _tickets.find(x => x.ticket_id === ticketId);
  if (!_activeTkt) return;
  const r = _activeTkt;

  // Header section — ticket id + category + status + reporter.
  const catLbl = CATEGORY_KEY[r.category] ? t(CATEGORY_KEY[r.category]) : r.category;
  const stLbl  = STATUS_KEY[r.status]     ? t(STATUS_KEY[r.status])     : r.status;

  const meta = document.getElementById('sup-d-meta');
  if (meta) {
    meta.innerHTML = `
      <div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;margin-bottom:.4rem">
        <code style="font-size:.72rem;background:var(--bg-soft);color:var(--tx);padding:.13rem .4rem;border-radius:4px;direction:ltr;border:1px solid var(--bd)">${esc(r.ticket_id)}</code>
        ${tag(catLbl, CATEGORY_CLR[r.category] || 't-gr')}
        ${tag(stLbl,  STATUS_CLR[r.status]   || 't-gr')}
      </div>
      <div style="font-size:1.05rem;font-weight:700">${esc(r.title)}</div>
      <div style="font-size:.78rem;color:var(--tm);margin-top:.2rem">
        ${esc(r.reporter_name || '—')} ·
        <span style="direction:ltr">${esc(r.reporter_email || '—')}</span> ·
        ${esc(r.reporter_access || '—')} ·
        ${fmtDate(r.created_at) || '—'}
      </div>`;
  }

  // Body section — description + repro + diagnostics + attachment.
  const body = document.getElementById('sup-d-body');
  if (body) {
    const diag = [
      r.page_url   ? `<tr><td style="padding:.2rem 0;color:var(--tm);width:30%">${esc(t('support.page_url'))}</td><td style="padding:.2rem 0;direction:ltr;word-break:break-all;font-size:.75rem">${esc(r.page_url)}</td></tr>` : '',
      r.viewport   ? `<tr><td style="padding:.2rem 0;color:var(--tm)">${esc(t('support.viewport'))}</td><td style="padding:.2rem 0;direction:ltr;font-size:.75rem">${esc(r.viewport)}</td></tr>` : '',
      r.user_agent ? `<tr><td style="padding:.2rem 0;color:var(--tm)">${esc(t('support.user_agent'))}</td><td style="padding:.2rem 0;direction:ltr;font-size:.7rem;color:var(--tm)">${esc(r.user_agent)}</td></tr>` : '',
    ].join('');
    body.innerHTML = `
      <div style="background:var(--bg-soft);border-radius:8px;padding:.75rem 1rem;margin-bottom:.85rem">
        <div style="font-size:.72rem;color:var(--tm);letter-spacing:.05em;text-transform:uppercase;margin-bottom:.35rem">${esc(t('support.description'))}</div>
        <div style="white-space:pre-wrap">${esc(r.description)}</div>
      </div>
      ${r.repro_steps ? `
      <div style="background:var(--gl);border-inline-start:4px solid var(--go);border-radius:8px;padding:.75rem 1rem;margin-bottom:.85rem">
        <div style="font-size:.72rem;color:var(--tm);letter-spacing:.05em;text-transform:uppercase;margin-bottom:.35rem">${esc(t('support.repro_steps'))}</div>
        <div style="white-space:pre-wrap">${esc(r.repro_steps)}</div>
      </div>` : ''}
      ${diag ? `<table style="width:100%;font-size:.82rem;border-collapse:collapse;margin-bottom:.85rem">${diag}</table>` : ''}
      ${r.attachment_path ? `
      <div style="background:var(--bg-soft);border-radius:8px;padding:.75rem 1rem">
        <div style="font-size:.72rem;color:var(--tm);letter-spacing:.05em;text-transform:uppercase;margin-bottom:.4rem">${esc(t('support.attachment'))}</div>
        <div id="sup-d-attachment">${esc(t('common.loading'))}</div>
      </div>` : ''}
      ${r.resolution_note ? `
      <div style="background:var(--gl);border-radius:8px;padding:.75rem 1rem;margin-top:.85rem">
        <div style="font-size:.72rem;color:var(--tm);letter-spacing:.05em;text-transform:uppercase;margin-bottom:.35rem">${esc(t('support.resolution_note'))}</div>
        <div style="white-space:pre-wrap">${esc(r.resolution_note)}</div>
      </div>` : ''}`;
  }

  // Status-change buttons — highlight the current state, dispatcher
  // calls setSupportStatus on click.
  const statusRow = document.getElementById('sup-d-status-row');
  if (statusRow) {
    const all = ['Open','InProgress','Resolved','Closed'];
    statusRow.innerHTML = all.map(s => {
      const active = s === r.status;
      const lbl = STATUS_KEY[s] ? t(STATUS_KEY[s]) : s;
      return `<button class="btn btn-sm ${active ? 'btn-g' : 'btn-ol'}" data-action="setSupportStatus" data-status="${s}">${esc(lbl)}</button>`;
    }).join('');
  }

  openModal('support-detail');

  // Lazy-fetch the attachment signed URL only after the modal is open,
  // so the list-view fetch isn't slowed by N+1 signing calls.
  if (r.attachment_path) {
    const attRes = await api('support.getAttachment', { ticket_id: r.ticket_id });
    const slot = document.getElementById('sup-d-attachment');
    if (!slot) return;
    if (!attRes || !attRes.success || !attRes.data?.url) {
      slot.innerHTML = `<span style="color:var(--tm)">${esc(t('support.attachment_missing'))}</span>`;
      return;
    }
    const url = esc(attRes.data.url);
    slot.innerHTML = `<a href="${url}" target="_blank" rel="noopener">
      <img src="${url}" alt="" style="max-width:100%;max-height:340px;border-radius:6px;border:1px solid var(--bd)"/>
    </a>`;
  }
}

export async function setSupportStatus(status) {
  if (!_activeTkt) return;
  const res = await api('support.updateStatus', {
    ticket_id: _activeTkt.ticket_id,
    status,
  });
  if (!res || !res.success) {
    toast(localizeError(res?.error, res?.errorParams) || t('support.err_status'), 'twarn');
    return;
  }
  toast(t('support.success_status'), 'tok');
  // Refetch + re-open so the chips and active button reflect the new state.
  await loadSupportTickets();
  // Re-resolve from the freshly-loaded list since the cached _activeTkt
  // is stale after the update.
  const updated = _tickets.find(x => x.ticket_id === _activeTkt.ticket_id);
  if (updated) {
    _activeTkt = updated;
    openSupportTicket(updated.ticket_id);
  } else {
    closeModal('support-detail');
  }
}
