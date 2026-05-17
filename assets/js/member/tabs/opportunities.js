// Opportunities tab — member portal (Phase 5c of Branch 4).
//
// Browses open opportunities the member can sign up for. Client-side
// filters the full list returned by `opportunities.list` to:
//   - status === 'Open' (no point showing Filled/Done/Cancelled to a
//     member who'd be wasting time clicking interested)
//   - owning_committee_id === member's committee  OR  IS NULL (the
//     "open to all" case). Members from other committees never see
//     opportunities they couldn't help with anyway.
//
// "Express interest" submits via `interest.submit`, which is per-PROJECT
// (the interest_requests table is keyed by project_id + member_id, not
// opportunity). So a member tapping interested on a specific role gets
// recorded as interested in the parent event; the head reviewing
// interest then assigns them to the right opportunity. We pass the
// opportunity role_name as the comment so the head knows which role
// caught the member's eye.

import { api } from '../../lib/ui.js';
import { esc, fmtDate } from '../../lib/format.js';
import { getSession } from '../../lib/auth.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

// Set of project_ids the member has already expressed interest in.
// Populated FROM SERVER on every load via `interest.listOwn` so the
// "✓ مُسجّل" pill survives reload / navigation / different device.
// Without server backing, the pill was in-memory only — members would
// refresh the page, see the button reset to "🙋 اهتمام", click again,
// see it flip back, and reasonably assume the site is broken.
const _interestedProjects = new Set();

export async function loadOpportunities() {
  const tbody = document.getElementById('opps-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('common.loading'))}</td></tr>`;

  // Two parallel fetches: opportunities + own interest history. Both are
  // small queries; loading them together avoids a waterfall.
  const [oppsRes, interestRes] = await Promise.all([
    api('opportunities.list'),
    api('interest.listOwn'),
  ]);
  if (!oppsRes || !oppsRes.success) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6" style="color:var(--dn)">${esc(t('mp.opps.err_load'))}</td></tr>`;
    return;
  }

  // Rebuild the interested-projects set from server data. Replacing the
  // set (rather than merging) ensures a member who's no longer in the
  // interest_requests table doesn't keep a stale "✓ مُسجّل" badge.
  _interestedProjects.clear();
  if (interestRes && interestRes.success) {
    for (const i of (interestRes.data || [])) {
      // Only count `interested = true` rows. A "no I'm not interested"
      // row shouldn't flip the button to "registered".
      const yn = i.interested === true || i.interested === 'TRUE' || i.interested === 'true';
      if (yn) _interestedProjects.add(i.project_id);
    }
  }

  const all = oppsRes.data || [];
  const session = getSession();
  const myCom = session?.committee_id || null;

  const rows = all.filter(o => {
    if (o.status !== 'Open') return false;
    // Own committee OR open-to-all (null committee = available to any member)
    return !o.owning_committee_id || o.owning_committee_id === myCom;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6" style="color:var(--tm)">${esc(t('mp.opps.empty'))}</td></tr>`;
    return;
  }

  const committeeOpenLabel = `<span style="color:var(--tm)">${esc(t('mp.opps.committee_all'))}</span>`;
  const hoursUnit          = esc(t('mp.hours.hours_unit'));
  const withdrawLabel      = esc(t('mp.opps.withdraw_btn'));
  const expressLabel       = esc(t('mp.opps.express_btn'));
  tbody.innerHTML = rows.map(o => {
    // expressed=true → render the withdraw button (outline, not disabled).
    // Members frequently mis-click and need a way back. Server is fine
    // with interest.submit { interested: false } as the withdraw path —
    // ON CONFLICT updates the same row's `interested` flag.
    const expressed = _interestedProjects.has(o.project_id);
    const actionBtn = expressed
      ? `<button class="btn btn-ol btn-sm btn-interest expressed"
                 data-action="withdrawInterest"
                 data-opportunity="${esc(o.opportunity_id)}"
                 data-project="${esc(o.project_id)}">
           ${withdrawLabel}
         </button>`
      : `<button class="btn btn-g btn-sm btn-interest"
                 data-action="expressInterest"
                 data-opportunity="${esc(o.opportunity_id)}"
                 data-project="${esc(o.project_id)}"
                 data-label="${esc(o.role_name)}">
           ${expressLabel}
         </button>`;
    return `
      <tr>
        <td><strong>${esc(o.role_name) || '—'}</strong></td>
        <td>${esc(o.project_name) || '—'}</td>
        <td>${esc(o.owning_committee_name) || committeeOpenLabel}</td>
        <td>${fmtDate(o.event_date) || '—'}</td>
        <td>${o.estimated_hours || 0} ${hoursUnit}</td>
        <td>${actionBtn}</td>
      </tr>
    `;
  }).join('');
}

// data-action="expressInterest" wiring. main.js's handler extracts
// opportunity_id (we pass project + label through the dataset on the
// button element itself so we have everything we need without a second
// fetch). Submits to interest.submit and updates the per-session cache.
export async function expressInterest(_opportunityId, _label, el) {
  // The caller in main.js passes (opportunity_id, label) but the row's
  // dataset also holds project_id which we need for interest.submit.
  // Re-resolve from the clicked button instead of plumbing it through
  // a third arg — keeps the dispatcher map signature stable.
  // (main.js passes el as the third argument-equivalent via lookup.)
  const btn = el || document.querySelector(`button[data-opportunity="${_opportunityId}"]`);
  if (!btn) return;
  const projectId = btn.dataset.project;
  const label     = btn.dataset.label || _label || '';
  const session = getSession();
  if (!session?.member_id) {
    const { toast } = await import('../../lib/ui.js');
    toast(t('mp.opps.err_no_session'), 'twarn');
    return;
  }

  btn.disabled = true;
  btn.textContent = t('mp.opps.registering');
  try {
    const res = await api('interest.submit', {
      data: {
        project_id: projectId,
        member_id:  session.member_id,
        interested: true,
        comment:    `${t('mp.opps.interest_role_prefix')} ${label}`,
      },
    });
    const { toast } = await import('../../lib/ui.js');
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t('mp.opps.err_submit'), 'twarn');
      btn.disabled = false;
      btn.textContent = t('mp.opps.express_btn');
      return;
    }
    _interestedProjects.add(projectId);
    toast(t('mp.opps.success'), 'tok');
    // Re-render the table so the row's button swaps from "express" to
    // "withdraw" without us needing to mutate the existing button in
    // place. Cheap: just touches a few <tr>s.
    loadOpportunities();
  } catch (err) {
    console.error('[expressInterest]', err);
    btn.disabled = false;
    btn.textContent = t('mp.opps.express_btn');
  }
}

// Withdraw a previously-expressed interest. Same server endpoint
// (`interest.submit`) with `interested: false` — the row is unique on
// (project_id, member_id) so the ON CONFLICT clause flips the flag
// in place. After success we re-render so the button swaps back to
// the "express" state. Server now uses user.member_id from the auth
// context (locked 2026-05-17), so a member can only withdraw their
// own interest no matter what data-* attrs the page exposes.
export async function withdrawInterest(_opportunityId, _label, el) {
  const btn = el || document.querySelector(`button[data-opportunity="${_opportunityId}"]`);
  if (!btn) return;
  const projectId = btn.dataset.project;
  const session = getSession();
  if (!session?.member_id) {
    const { toast } = await import('../../lib/ui.js');
    toast(t('mp.opps.err_no_session'), 'twarn');
    return;
  }

  btn.disabled = true;
  btn.textContent = t('mp.opps.withdrawing');
  try {
    const res = await api('interest.submit', {
      data: {
        project_id: projectId,
        interested: false,
        comment:    null,
      },
    });
    const { toast } = await import('../../lib/ui.js');
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t('mp.opps.err_withdraw'), 'twarn');
      btn.disabled = false;
      btn.textContent = t('mp.opps.withdraw_btn');
      return;
    }
    _interestedProjects.delete(projectId);
    toast(t('mp.opps.success_withdraw'), 'tok');
    loadOpportunities();
  } catch (err) {
    console.error('[withdrawInterest]', err);
    btn.disabled = false;
    btn.textContent = t('mp.opps.withdraw_btn');
  }
}
