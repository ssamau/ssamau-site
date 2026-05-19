// Opportunities tab — member portal.
//
// Multi-role refactor 2026-05-18 (president's spec):
// Each opportunity is one row. Clicking "اهتمام" opens a pick-role
// modal that lists every role the admin set up + a sticky "أي دور"
// fallback. Submitting calls `interest.submit` with:
//   - opportunity_id  → required for the new flow
//   - role_id         → BIGINT pointing into opportunity_roles. NULL
//                       means "any role — help where most needed"; the
//                       head picks the assignment.
//
// Interest cache: keyed by opportunity_id (not project_id) so the
// "✓ مُسجّل" badge stays correct when a member is interested in two
// different opportunities under the same project — the legacy
// project-keyed cache would have flipped both badges off-and-on
// together. interest.listOwn returns one row per (opportunity, member)
// (per the new partial unique index), so the map below holds one entry
// per opportunity.

import { api, toast, openModal, closeModal, filterTable } from '../../lib/ui.js';
import { esc, fmtDate } from '../../lib/format.js';
import { getSession } from '../../lib/auth.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

// opportunity_id → { role_id: number|null }. Lookup tells us if the
// member has already registered + which role (or "any role") they picked.
const _interestedOpportunities = new Map();
// Set<opportunity_id>. Once the head/admin has assigned the member,
// the row appears here — the render branch swaps the withdraw button
// for a "✅ معتمد" confirmation badge so the member can't self-withdraw
// from a confirmed role. Server-side enforcement lives in
// interest.submit (rejects with err.business.withdraw_after_assigned).
const _assignedOpportunities = new Set();
// Legacy backward-compat (2026-05-18): pre-multi-role members
// expressed interest at the PROJECT level — one interest_requests row
// per (project, member) with opportunity_id IS NULL. Those rows don't
// fit the new opportunity-keyed cache, but losing the visual "✓ مُسجّل"
// marker on those would feel like the site forgot their click. So we
// track them separately + show a "previously expressed" hint on every
// opportunity belonging to a project they expressed legacy interest in.
const _legacyInterestedProjects = new Set();

// Cached last `opportunities.list` response. openPickRoleModal needs
// the full row (incl. roles[]) for the clicked opportunity but the
// table-row markup only carries IDs in dataset attrs — so we stash
// the list each time loadOpportunities() runs and look it up on click
// without a second fetch.
let _lastOpps = [];

// State for the pick-role modal — set in openPickRoleModal,
// consumed by submitPickRole. Single modal at a time, so one ref.
let _pickRoleCtx = null;

export async function loadOpportunities() {
  const tbody = document.getElementById('opps-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('common.loading'))}</td></tr>`;

  // Three parallel fetches: opportunities + own interest history + own
  // confirmed assignments. Assignments determine whether the withdraw
  // button is allowed (it isn't once the head/admin has confirmed).
  const [oppsRes, interestRes, assignRes] = await Promise.all([
    api('opportunities.list'),
    api('interest.listOwn'),
    api('assignments.listOwn'),
  ]);
  if (!oppsRes || !oppsRes.success) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6" style="color:var(--dn)">${esc(t('mp.opps.err_load'))}</td></tr>`;
    return;
  }

  // Rebuild the interest cache. Only count rows tied to an
  // opportunity_id (the new flow); legacy project-level interest rows
  // are ignored here — they don't have a single opportunity to map back
  // to. Withdrawal rows (`interested = false`) are skipped so the
  // badge correctly reflects current state.
  _interestedOpportunities.clear();
  _legacyInterestedProjects.clear();
  _assignedOpportunities.clear();
  if (interestRes && interestRes.success) {
    for (const i of (interestRes.data || [])) {
      const yn = i.interested === true || i.interested === 'TRUE' || i.interested === 'true';
      if (!yn) continue;
      if (i.opportunity_id) {
        _interestedOpportunities.set(i.opportunity_id, {
          role_id: i.role_id ?? null,
        });
      } else if (i.project_id) {
        // Pre-multi-role interest — surface as a soft hint on every
        // opportunity in this project so the member sees their prior
        // click was acknowledged. Doesn't disable the "اهتمام" button —
        // they can still pick a specific role to refine.
        _legacyInterestedProjects.add(i.project_id);
      }
    }
  }
  if (assignRes && assignRes.success) {
    for (const a of (assignRes.data || [])) {
      if (a.opportunity_id) _assignedOpportunities.add(a.opportunity_id);
    }
  }

  const all = oppsRes.data || [];
  _lastOpps = all;
  _applyMemberOppFilters();
}

// In-memory re-render against the cached `_lastOpps`. The filter
// dropdowns + search input call this directly so a filter change
// doesn't re-hit the network (members type fast — refetching on every
// keystroke would be wasteful).
function _applyMemberOppFilters() {
  const tbody = document.getElementById('opps-tbody');
  if (!tbody) return;
  const session = getSession();
  const myCom = session?.committee_id || null;
  const { date: dateFilter, committee: committeeFilter, query } = _currentMemberOppFilters();

  // Compute "today" + "end of week" once for the date filter so we don't
  // re-parse on every row. End-of-week here means end of Saturday by
  // ISO 8601 (Mon=1 … Sun=7 → end_of_week = the next Sunday at 00:00).
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayEnd = new Date(today); todayEnd.setHours(23, 59, 59, 999);
  const dow = (today.getDay() + 6) % 7;  // 0 (Mon) … 6 (Sun)
  const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + (6 - dow)); weekEnd.setHours(23, 59, 59, 999);

  const rows = (_lastOpps || []).filter(o => {
    if (o.status !== 'Open') return false;
    // Committee filter — three modes:
    //   ''     → own committee + open-to-all (default, current behavior)
    //   mine   → own committee only
    //   open   → open-to-all only (committee IS NULL)
    if (committeeFilter === 'mine') {
      if (o.owning_committee_id !== myCom) return false;
    } else if (committeeFilter === 'open') {
      if (o.owning_committee_id) return false;
    } else {
      if (o.owning_committee_id && o.owning_committee_id !== myCom) return false;
    }
    // Date filter — uses the project's event_date when present.
    if (dateFilter) {
      const ts = o.event_date ? Date.parse(o.event_date) : NaN;
      if (dateFilter === 'no_date') {
        if (!Number.isNaN(ts)) return false;
      } else {
        if (Number.isNaN(ts)) return false;
        if (dateFilter === 'upcoming' && ts < today.getTime())    return false;
        if (dateFilter === 'past'     && ts >= today.getTime())   return false;
        if (dateFilter === 'today'    && (ts < today.getTime() || ts > todayEnd.getTime())) return false;
        if (dateFilter === 'this_week'&& (ts < today.getTime() || ts > weekEnd.getTime())) return false;
      }
    }
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6" style="color:var(--tm)">${esc(t('mp.opps.empty'))}</td></tr>`;
    return;
  }

  const committeeOpenLabel = `<span style="color:var(--tm)">${esc(t('mp.opps.committee_all'))}</span>`;
  const hoursUnit          = esc(t('mp.hours.hours_unit'));
  const withdrawLabel      = esc(t('mp.opps.withdraw_btn'));
  const expressLabel       = esc(t('mp.opps.express_btn'));
  const anyRoleBadge       = esc(t('mp.opps.any_role_badge') || 'أي دور');
  tbody.innerHTML = rows.map(o => {
    const roles = Array.isArray(o.roles) ? o.roles : [];
    // First column: the role(s). Multi-role → show count + the first
    // role name; single-role → show the legacy role_name verbatim.
    let roleCell;
    if (roles.length > 1) {
      roleCell = `<div style="font-weight:600">${esc(roles[0].role_name)}</div>
                  <div style="font-size:.7rem;color:var(--tm)">${esc(t('ap.opp.plus_n_more', { n: roles.length - 1 }))}</div>`;
    } else {
      const firstName = (roles[0] && roles[0].role_name) || o.role_name || '—';
      roleCell = `<strong>${esc(firstName)}</strong>`;
    }
    // Total estimated hours across roles for the hours column.
    const totalHours = roles.length
      ? roles.reduce((n, r) => n + (Number(r.estimated_hours) || 0), 0)
      : (Number(o.estimated_hours) || 0);

    // Three-way state for the action cell:
    //   1) ASSIGNED — head/admin already confirmed. Show ✅ "معتمد" badge,
    //      NO withdraw button. Server-side withdraw is rejected with
    //      err.business.withdraw_after_assigned, but we hide the button
    //      so the member doesn't even try. To leave, they ask the head.
    //   2) INTERESTED — opted in but not yet assigned. Show role chip +
    //      withdraw button.
    //   3) NEW — no interest record yet. Show the green "اهتمام" button.
    const isAssigned = _assignedOpportunities.has(o.opportunity_id);
    const expr       = _interestedOpportunities.get(o.opportunity_id);
    let actionCell;
    if (isAssigned) {
      actionCell = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:.25rem">
        <span style="display:inline-block;background:#1A5C2E;color:#fff;padding:.25rem .7rem;border-radius:50px;font-size:.75rem;font-weight:700">
          ${esc(t('mp.opps.assigned_badge') || '✅ معتمد')}
        </span>
        <span style="font-size:.7rem;color:var(--tm)">
          ${esc(t('mp.opps.assigned_hint') || 'للانسحاب تواصل مع رئيس اللجنة')}
        </span>
      </div>`;
    } else if (expr) {
      const pickedRole = expr.role_id ? roles.find(r => Number(r.id) === Number(expr.role_id)) : null;
      const chip = pickedRole
        ? `<span style="display:inline-block;background:#e8f5e9;color:#1A5C2E;padding:.1rem .5rem;border-radius:50px;font-size:.7rem;font-weight:700;margin-bottom:.3rem">${esc(pickedRole.role_name)}</span>`
        : `<span style="display:inline-block;background:#fef3c7;color:#92400e;padding:.1rem .5rem;border-radius:50px;font-size:.7rem;font-weight:700;margin-bottom:.3rem">${anyRoleBadge}</span>`;
      actionCell = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:.25rem">
        ${chip}
        <button class="btn btn-ol btn-sm btn-interest expressed"
                data-action="withdrawInterest"
                data-opportunity="${esc(o.opportunity_id)}"
                data-project="${esc(o.project_id)}">
          ${withdrawLabel}
        </button>
      </div>`;
    } else {
      // Legacy-interest hint: member expressed pre-multi-role interest
      // in this project. Don't bypass the button (they still need to
      // pick a role), but surface a soft pill so they see the system
      // didn't forget their earlier click.
      const legacyHint = _legacyInterestedProjects.has(o.project_id)
        ? `<div style="font-size:.7rem;color:var(--tm);margin-bottom:.25rem">${esc(t('mp.opps.legacy_interest_hint') || 'سبق تسجيل اهتمام بالمشروع — اختر دوراً لتحديده')}</div>`
        : '';
      actionCell = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:.2rem">
        ${legacyHint}
        <button class="btn btn-g btn-sm btn-interest"
                data-action="openPickRoleModal"
                data-opportunity="${esc(o.opportunity_id)}"
                data-project="${esc(o.project_id)}">
          ${expressLabel}
        </button>
      </div>`;
    }
    return `
      <tr>
        <td>${roleCell}</td>
        <td>${esc(o.project_name) || '—'}</td>
        <td>${esc(o.owning_committee_name) || committeeOpenLabel}</td>
        <td>${fmtDate(o.event_date) || '—'}</td>
        <td>${totalHours || 0} ${hoursUnit}</td>
        <td>${actionCell}</td>
      </tr>
    `;
  }).join('');
  // Compose with the text search — re-apply after the filter-driven
  // re-render so a typed query still hides non-matches.
  if (query) filterTable('opps-tbody', query);
}

// Filter state lives in the DOM (no module variable). Date filter
// understands the calendar buckets the member is most likely to need
// (upcoming, today, this week, past, no_date). Committee filter slices
// the default scope (own committee + open-to-all) into either of the
// two components.
function _currentMemberOppFilters() {
  const date      = document.querySelector('[data-action="filterMemberOppsByDate"]')?.value      || '';
  const committee = document.querySelector('[data-action="filterMemberOppsByCommittee"]')?.value || '';
  const query     = document.querySelector('[data-action="filterMemberOppsBySearch"]')?.value?.trim() || '';
  return { date, committee, query };
}

export function filterMemberOppsByDate(_v)      { _applyMemberOppFilters(); }
export function filterMemberOppsByCommittee(_v) { _applyMemberOppFilters(); }
export function filterMemberOppsBySearch(_v)    { _applyMemberOppFilters(); }

// Click handler for the "اهتمام" button. Opens the pick-role modal,
// populates it with the opportunity's roles + a sticky "any role"
// option, and stashes context for submitPickRole to consume.
export function openPickRoleModal(el) {
  const opportunityId = el.dataset.opportunity;
  const projectId     = el.dataset.project;
  // Single source of truth for the opportunity data: opportunities.list's
  // last response. We don't re-fetch — the rows are already in the DOM,
  // and the roles[] array is attached to each row. Lookup by walking
  // the DOM table isn't ideal; pull from the per-button dataset instead.
  // Simpler approach: refetch the opportunity by id from the cached
  // window-level last list. The member tab keeps it in a module
  // variable below.
  const opp = _lastOpps.find(o => o.opportunity_id === opportunityId);
  if (!opp) {
    toast(t('mp.opps.err_load'), 'twarn');
    return;
  }
  _pickRoleCtx = {
    opportunity_id: opportunityId,
    project_id:     projectId,
    roles:          Array.isArray(opp.roles) ? opp.roles : [],
  };
  // Header — project name as the subtitle so the member sees which event.
  const header = document.getElementById('pickrole-project');
  if (header) header.textContent = opp.project_name || '—';

  const list = document.getElementById('pickrole-list');
  if (list) {
    const hoursUnit = esc(t('mp.hours.hours_unit'));
    const fullLabel = esc(t('mp.opps.role_full_badge') || 'ممتلئ');
    // Find the first AVAILABLE role to pre-check. If every role is
    // full, no radio is pre-checked — the "any role" fallback gets
    // the default. roles[] carries the `taken` counter from
    // opportunities.list; combined with headcount_needed it tells us
    // exactly which rows to disable.
    const firstAvailableIdx = _pickRoleCtx.roles.findIndex(r =>
      (Number(r.taken) || 0) < (Number(r.headcount_needed) || 1)
    );
    const rowsHtml = _pickRoleCtx.roles.map((r, i) => {
      const taken     = Number(r.taken) || 0;
      const needed    = Number(r.headcount_needed) || 1;
      const remaining = Math.max(0, needed - taken);
      const isFull    = remaining === 0;
      const checked   = (!isFull && i === firstAvailableIdx) ? 'checked' : '';
      // Full roles get a red "ممتلئ" pill + a disabled radio so the
      // member can't even attempt them. Available roles show the
      // remaining count so they know how close to full it is.
      const stateChip = isFull
        ? `<span style="display:inline-block;background:#fee2e2;color:#b91c1c;padding:.1rem .5rem;border-radius:50px;font-size:.65rem;font-weight:700;margin-inline-start:.4rem">${fullLabel}</span>`
        : `<span style="display:inline-block;background:#e8f5e9;color:#1A5C2E;padding:.1rem .5rem;border-radius:50px;font-size:.65rem;font-weight:700;margin-inline-start:.4rem">${esc(t('mp.opps.role_remaining', { remaining: String(remaining), total: String(needed) }))}</span>`;
      return `
      <label class="fg-check" style="display:flex;gap:.6rem;padding:.6rem .8rem;border:1px solid var(--c-soft);border-radius:8px;cursor:${isFull ? 'not-allowed' : 'pointer'};opacity:${isFull ? '.55' : '1'}">
        <input type="radio" name="pickrole-choice" value="${esc(String(r.id))}" ${checked} ${isFull ? 'disabled' : ''}/>
        <div style="flex:1">
          <div style="font-weight:600">${esc(r.role_name)}${stateChip}</div>
          <div style="font-size:.72rem;color:var(--tm);margin-top:.15rem">
            👥 ${needed} · ⏱️ ${Number(r.estimated_hours) || 0} ${hoursUnit}
            ${r.notes ? ` · ${esc(r.notes)}` : ''}
          </div>
        </div>
      </label>
    `;
    }).join('');
    const anyRoleRow = `
      <label class="fg-check" style="display:flex;gap:.6rem;padding:.6rem .8rem;border:1px dashed var(--c-soft);border-radius:8px;cursor:pointer;background:#fffbeb">
        <input type="radio" name="pickrole-choice" value="__any__" ${_pickRoleCtx.roles.length === 0 ? 'checked' : ''}/>
        <div style="flex:1">
          <div style="font-weight:600">🤝 ${esc(t('mp.opps.any_role_title') || 'أي دور')}</div>
          <div style="font-size:.72rem;color:var(--tm);margin-top:.15rem">${esc(t('mp.opps.any_role_lead') || 'مساعدة حيث تحتاج اللجنة — رئيس اللجنة يحدد المكان المناسب.')}</div>
        </div>
      </label>
    `;
    list.innerHTML = rowsHtml + anyRoleRow;
  }
  // Reset the motivation textarea so a previous submission doesn't
  // leak across opens (especially on the same opportunity).
  const motivationEl = document.getElementById('pickrole-motivation');
  if (motivationEl) motivationEl.value = '';
  openModal('pick-role');
}

export function closePickRoleModal() {
  closeModal('pick-role');
  _pickRoleCtx = null;
}

export async function submitPickRole() {
  if (!_pickRoleCtx) return;
  const session = getSession();
  if (!session?.member_id) {
    toast(t('mp.opps.err_no_session'), 'twarn');
    return;
  }
  const picked = document.querySelector('input[name="pickrole-choice"]:checked');
  if (!picked) {
    toast(t('mp.opps.err_pick_role') || 'اختر دوراً قبل المتابعة', 'twarn');
    return;
  }
  const role_id = picked.value === '__any__' ? null : Number(picked.value);
  // Free-text motivation (president's ask 2026-05-18: "ودي لو فيه
  // بوكس يكتبولنا فيه ليش هو مهتم وايش يقدر يقدم"). Stored in the
  // existing `comment` column on interest_requests — the old
  // auto-generated role-name hint is no longer needed because the
  // server returns `picked_role_name` as a dedicated column now, so
  // the comment slot is freed for the member's actual words.
  const motivation = (document.getElementById('pickrole-motivation')?.value || '').trim();

  const btn = document.getElementById('pickrole-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('mp.opps.registering'); }

  try {
    const res = await api('interest.submit', {
      data: {
        project_id:     _pickRoleCtx.project_id,
        opportunity_id: _pickRoleCtx.opportunity_id,
        role_id,
        interested:     true,
        // Member's own words about why interested + what they can
        // offer. Empty when they leave the textarea blank.
        comment:        motivation || null,
      },
    });
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t('mp.opps.err_submit'), 'twarn');
      return;
    }
    _interestedOpportunities.set(_pickRoleCtx.opportunity_id, { role_id });
    toast(t('mp.opps.success'), 'tok');
    closePickRoleModal();
    loadOpportunities();
  } catch (err) {
    console.error('[submitPickRole]', err);
    toast(t('mp.opps.err_submit'), 'twarn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('mp.opps.pick_role_submit'); }
  }
}

// Withdraw a previously-expressed interest. Server treats role_id NULL
// in the update path as "clear role on withdraw"; the underlying row
// stays so we keep an audit trail of opt-in then opt-out. Server uses
// user.member_id from auth context, so members can only withdraw their
// own interest no matter what data-* attrs the page exposes.
export async function withdrawInterest(_opportunityId, _label, el) {
  const btn = el || document.querySelector(`button[data-opportunity="${_opportunityId}"]`);
  if (!btn) return;
  const projectId      = btn.dataset.project;
  const opportunity_id = btn.dataset.opportunity;
  const session = getSession();
  if (!session?.member_id) {
    toast(t('mp.opps.err_no_session'), 'twarn');
    return;
  }
  btn.disabled = true;
  btn.textContent = t('mp.opps.withdrawing');
  try {
    const res = await api('interest.submit', {
      data: {
        project_id:     projectId,
        opportunity_id,
        // role_id intentionally NOT sent — server preserves whatever
        // role they last picked so the audit trail isn't lost. The
        // `interested: false` flag is what actually withdraws.
        interested:     false,
        comment:        null,
      },
    });
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t('mp.opps.err_withdraw'), 'twarn');
      btn.disabled = false;
      btn.textContent = t('mp.opps.withdraw_btn');
      return;
    }
    _interestedOpportunities.delete(opportunity_id);
    toast(t('mp.opps.success_withdraw'), 'tok');
    loadOpportunities();
  } catch (err) {
    console.error('[withdrawInterest]', err);
    btn.disabled = false;
    btn.textContent = t('mp.opps.withdraw_btn');
  }
}

