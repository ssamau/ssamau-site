// Head's "Other opportunities" tab — opportunities owned by OTHER
// committees + admin-only (null owning_committee_id) ones. Heads can
// participate in any committee's event; they can't manage them from
// here. The existing "Opportunities" tab stays as the head's own
// management view.
//
// Mirrors member/tabs/opportunities.js for the express/withdraw flow.
// Reuses interest.submit on the server (which now uses user.member_id
// from auth context, so a head can only express on behalf of
// themselves — no member_id field is sent from the client).

import { api } from '../../lib/ui.js';
import { esc, fmtDate } from '../../lib/format.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

// Per-load cache of project_ids the head has expressed interest in.
// Populated from server via interest.listOwn so the button state
// survives page refresh + cross-device.
const _interestedProjects = new Set();

export async function loadHeadOtherOpportunities() {
  const tbody = document.getElementById('hd-other-opps-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('common.loading'))}</td></tr>`;

  const [oppsRes, interestRes] = await Promise.all([
    api('opportunities.list'),
    api('interest.listOwn'),
  ]);
  if (!oppsRes || !oppsRes.success) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6" style="color:var(--dn)">${esc(t('mp.opps.err_load'))}</td></tr>`;
    return;
  }

  _interestedProjects.clear();
  if (interestRes && interestRes.success) {
    for (const i of (interestRes.data || [])) {
      const yn = i.interested === true || i.interested === 'TRUE' || i.interested === 'true';
      if (yn) _interestedProjects.add(i.project_id);
    }
  }

  // Filter: status=Open, NOT the head's own committee. Admin-only opps
  // (owning_committee_id IS NULL) are included so the head can volunteer
  // for those too — matches the "open to all" semantics from the member
  // portal but inverted (here we exclude self-committee).
  const myCom = window.CURRENT_USER?.committee_id || null;
  const rows = (oppsRes.data || []).filter(o => {
    if (o.status !== 'Open') return false;
    return !o.owning_committee_id || o.owning_committee_id !== myCom;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6" style="color:var(--tm)">${esc(t('hp.other_opps.empty'))}</td></tr>`;
    return;
  }

  const committeeOpenLabel = `<span style="color:var(--tm)">${esc(t('mp.opps.committee_all'))}</span>`;
  const hoursUnit          = esc(t('mp.hours.hours_unit'));
  const expressLabel       = esc(t('mp.opps.express_btn'));
  const withdrawLabel      = esc(t('mp.opps.withdraw_btn'));
  tbody.innerHTML = rows.map(o => {
    const expressed = _interestedProjects.has(o.project_id);
    const actionBtn = expressed
      ? `<button class="btn btn-ol btn-sm btn-interest expressed"
                 data-action="hd.other.withdraw"
                 data-opportunity="${esc(o.opportunity_id)}"
                 data-project="${esc(o.project_id)}">
           ${withdrawLabel}
         </button>`
      : `<button class="btn btn-g btn-sm btn-interest"
                 data-action="hd.other.express"
                 data-opportunity="${esc(o.opportunity_id)}"
                 data-project="${esc(o.project_id)}"
                 data-label="${esc(o.role_name)}">
           ${expressLabel}
         </button>`;
    return `<tr>
      <td><strong>${esc(o.role_name) || '—'}</strong></td>
      <td>${esc(o.project_name) || '—'}</td>
      <td>${esc(o.owning_committee_name) || committeeOpenLabel}</td>
      <td>${fmtDate(o.event_date) || '—'}</td>
      <td>${o.estimated_hours || 0} ${hoursUnit}</td>
      <td>${actionBtn}</td>
    </tr>`;
  }).join('');
}

// Same handler shape as the member-portal versions but scoped to the
// head's "other opportunities" tab and using the hd.other.* action
// names so the dispatcher routes correctly without colliding with
// the member portal's expressInterest handler.
async function _submitInterest(el, interested, busyLabelKey, successLabelKey, errorLabelKey, fallbackLabelKey, comment) {
  if (!el) return;
  const projectId = el.dataset.project;
  el.disabled = true;
  el.textContent = t(busyLabelKey);
  try {
    const res = await api('interest.submit', {
      data: {
        project_id: projectId,
        interested,
        comment: comment || null,
      },
    });
    const { toast } = await import('../../lib/ui.js');
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t(errorLabelKey), 'twarn');
      el.disabled = false;
      el.textContent = t(fallbackLabelKey);
      return;
    }
    if (interested) _interestedProjects.add(projectId); else _interestedProjects.delete(projectId);
    toast(t(successLabelKey), 'tok');
    loadHeadOtherOpportunities();
  } catch (err) {
    console.error('[head.otherOpps] submit failed:', err);
    el.disabled = false;
    el.textContent = t(fallbackLabelKey);
  }
}

export function expressOtherInterest(el) {
  const label = el?.dataset?.label || '';
  return _submitInterest(
    el, true,
    'mp.opps.registering', 'mp.opps.success', 'mp.opps.err_submit', 'mp.opps.express_btn',
    label ? `${t('mp.opps.interest_role_prefix')} ${label}` : null,
  );
}

export function withdrawOtherInterest(el) {
  return _submitInterest(
    el, false,
    'mp.opps.withdrawing', 'mp.opps.success_withdraw', 'mp.opps.err_withdraw', 'mp.opps.withdraw_btn',
    null,
  );
}
