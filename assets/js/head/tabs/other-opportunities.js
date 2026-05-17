// Head's "Other opportunities" tab — opportunities owned by OTHER
// committees + admin-only (null owning_committee_id) ones. Heads can
// participate in any committee's event; they can't manage them from
// here. The existing "Opportunities" tab stays as the head's own
// management view.
//
// Multi-role refactor 2026-05-18: same pick-role modal flow as the
// member portal. Each opportunity is a single row; "اهتمام" opens the
// role picker (every role + a sticky "أي دور"). Interest is keyed by
// opportunity_id (not project_id) so the head's badge state reflects
// per-opportunity status, not per-project — important when two
// opportunities under the same project should look independent.

import { api, openModal, closeModal } from '../../lib/ui.js';
import { esc, fmtDate } from '../../lib/format.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

// opportunity_id → { role_id: number|null }
const _interestedOpportunities = new Map();
// Pre-multi-role legacy interest (project-level only). Tracked
// separately so the visual "previously expressed" hint still shows on
// opportunities in projects the head registered interest in before
// the schema migration.
const _legacyInterestedProjects = new Set();
// Cached last opportunities.list response so the pick-role modal can
// look up roles[] for the clicked opportunity without a second fetch.
let _lastOpps = [];
// Modal context. Single modal, one ref.
let _pickRoleCtx = null;

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

  _interestedOpportunities.clear();
  _legacyInterestedProjects.clear();
  if (interestRes && interestRes.success) {
    for (const i of (interestRes.data || [])) {
      const yn = i.interested === true || i.interested === 'TRUE' || i.interested === 'true';
      if (!yn) continue;
      if (i.opportunity_id) {
        _interestedOpportunities.set(i.opportunity_id, {
          role_id: i.role_id ?? null,
        });
      } else if (i.project_id) {
        _legacyInterestedProjects.add(i.project_id);
      }
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
  _lastOpps = rows;

  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6" style="color:var(--tm)">${esc(t('hp.other_opps.empty'))}</td></tr>`;
    return;
  }

  const committeeOpenLabel = `<span style="color:var(--tm)">${esc(t('mp.opps.committee_all'))}</span>`;
  const hoursUnit          = esc(t('mp.hours.hours_unit'));
  const expressLabel       = esc(t('mp.opps.express_btn'));
  const withdrawLabel      = esc(t('mp.opps.withdraw_btn'));
  const anyRoleBadge       = esc(t('mp.opps.any_role_badge') || 'أي دور');
  tbody.innerHTML = rows.map(o => {
    const roles = Array.isArray(o.roles) ? o.roles : [];
    let roleCell;
    if (roles.length > 1) {
      roleCell = `<div style="font-weight:600">${esc(roles[0].role_name)}</div>
                  <div style="font-size:.7rem;color:var(--tm)">${esc(t('ap.opp.plus_n_more', { n: roles.length - 1 }))}</div>`;
    } else {
      const firstName = (roles[0] && roles[0].role_name) || o.role_name || '—';
      roleCell = `<strong>${esc(firstName)}</strong>`;
    }
    const totalHours = roles.length
      ? roles.reduce((n, r) => n + (Number(r.estimated_hours) || 0), 0)
      : (Number(o.estimated_hours) || 0);

    const expr = _interestedOpportunities.get(o.opportunity_id);
    let actionCell;
    if (expr) {
      const pickedRole = expr.role_id ? roles.find(r => Number(r.id) === Number(expr.role_id)) : null;
      const chip = pickedRole
        ? `<span style="display:inline-block;background:#e8f5e9;color:#1A5C2E;padding:.1rem .5rem;border-radius:50px;font-size:.7rem;font-weight:700;margin-bottom:.3rem">${esc(pickedRole.role_name)}</span>`
        : `<span style="display:inline-block;background:#fef3c7;color:#92400e;padding:.1rem .5rem;border-radius:50px;font-size:.7rem;font-weight:700;margin-bottom:.3rem">${anyRoleBadge}</span>`;
      actionCell = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:.25rem">
        ${chip}
        <button class="btn btn-ol btn-sm btn-interest expressed"
                data-action="hd.other.withdraw"
                data-opportunity="${esc(o.opportunity_id)}"
                data-project="${esc(o.project_id)}">${withdrawLabel}</button>
      </div>`;
    } else {
      const legacyHint = _legacyInterestedProjects.has(o.project_id)
        ? `<div style="font-size:.7rem;color:var(--tm);margin-bottom:.25rem">${esc(t('mp.opps.legacy_interest_hint') || 'سبق تسجيل اهتمام بالمشروع — اختر دوراً لتحديده')}</div>`
        : '';
      actionCell = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:.2rem">
        ${legacyHint}
        <button class="btn btn-g btn-sm btn-interest"
          data-action="hd.other.openPick"
          data-opportunity="${esc(o.opportunity_id)}"
          data-project="${esc(o.project_id)}">${expressLabel}</button>
      </div>`;
    }
    return `<tr>
      <td>${roleCell}</td>
      <td>${esc(o.project_name) || '—'}</td>
      <td>${esc(o.owning_committee_name) || committeeOpenLabel}</td>
      <td>${fmtDate(o.event_date) || '—'}</td>
      <td>${totalHours || 0} ${hoursUnit}</td>
      <td>${actionCell}</td>
    </tr>`;
  }).join('');
}

export function openHeadOtherPickRole(el) {
  const opportunityId = el.dataset.opportunity;
  const projectId     = el.dataset.project;
  const opp = _lastOpps.find(o => o.opportunity_id === opportunityId);
  if (!opp) return;
  _pickRoleCtx = {
    opportunity_id: opportunityId,
    project_id:     projectId,
    roles:          Array.isArray(opp.roles) ? opp.roles : [],
  };
  const header = document.getElementById('hd-pickrole-project');
  if (header) header.textContent = opp.project_name || '—';
  const list = document.getElementById('hd-pickrole-list');
  if (list) {
    const hoursUnit = esc(t('mp.hours.hours_unit'));
    const rowsHtml = _pickRoleCtx.roles.map((r, i) => `
      <label class="fg-check" style="display:flex;gap:.6rem;padding:.6rem .8rem;border:1px solid var(--c-soft);border-radius:8px;cursor:pointer">
        <input type="radio" name="hd-pickrole-choice" value="${esc(String(r.id))}" ${i === 0 ? 'checked' : ''}/>
        <div style="flex:1">
          <div style="font-weight:600">${esc(r.role_name)}</div>
          <div style="font-size:.72rem;color:var(--tm);margin-top:.15rem">
            👥 ${Number(r.headcount_needed) || 1} · ⏱️ ${Number(r.estimated_hours) || 0} ${hoursUnit}
            ${r.notes ? ` · ${esc(r.notes)}` : ''}
          </div>
        </div>
      </label>
    `).join('');
    const anyRoleRow = `
      <label class="fg-check" style="display:flex;gap:.6rem;padding:.6rem .8rem;border:1px dashed var(--c-soft);border-radius:8px;cursor:pointer;background:#fffbeb">
        <input type="radio" name="hd-pickrole-choice" value="__any__" ${_pickRoleCtx.roles.length === 0 ? 'checked' : ''}/>
        <div style="flex:1">
          <div style="font-weight:600">🤝 ${esc(t('mp.opps.any_role_title') || 'أي دور')}</div>
          <div style="font-size:.72rem;color:var(--tm);margin-top:.15rem">${esc(t('mp.opps.any_role_lead') || 'مساعدة حيث تحتاج اللجنة — رئيس اللجنة يحدد المكان المناسب.')}</div>
        </div>
      </label>
    `;
    list.innerHTML = rowsHtml + anyRoleRow;
  }
  openModal('pick-role');
}

export function closeHeadOtherPickRole() {
  closeModal('pick-role');
  _pickRoleCtx = null;
}

export async function submitHeadOtherPickRole() {
  if (!_pickRoleCtx) return;
  const picked = document.querySelector('input[name="hd-pickrole-choice"]:checked');
  if (!picked) return;
  const role_id = picked.value === '__any__' ? null : Number(picked.value);
  const btn = document.getElementById('hd-pickrole-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('mp.opps.registering'); }
  try {
    const res = await api('interest.submit', {
      data: {
        project_id:     _pickRoleCtx.project_id,
        opportunity_id: _pickRoleCtx.opportunity_id,
        role_id,
        interested:     true,
        comment:        role_id
          ? `${t('mp.opps.interest_role_prefix')} ${
              (_pickRoleCtx.roles.find(r => Number(r.id) === role_id) || {}).role_name || ''
            }`
          : (t('mp.opps.interest_any_role_comment') || 'مهتم بأي دور — مساعدة حيث تحتاج اللجنة'),
      },
    });
    const { toast } = await import('../../lib/ui.js');
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t('mp.opps.err_submit'), 'twarn');
      return;
    }
    _interestedOpportunities.set(_pickRoleCtx.opportunity_id, { role_id });
    toast(t('mp.opps.success'), 'tok');
    closeHeadOtherPickRole();
    loadHeadOtherOpportunities();
  } catch (err) {
    console.error('[head.otherOpps.submitPick]', err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('mp.opps.pick_role_submit'); }
  }
}

export async function withdrawOtherInterest(el) {
  if (!el) return;
  const projectId      = el.dataset.project;
  const opportunity_id = el.dataset.opportunity;
  el.disabled = true;
  el.textContent = t('mp.opps.withdrawing');
  try {
    const res = await api('interest.submit', {
      data: {
        project_id:     projectId,
        opportunity_id,
        interested:     false,
        comment:        null,
      },
    });
    const { toast } = await import('../../lib/ui.js');
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t('mp.opps.err_withdraw'), 'twarn');
      el.disabled = false;
      el.textContent = t('mp.opps.withdraw_btn');
      return;
    }
    _interestedOpportunities.delete(opportunity_id);
    toast(t('mp.opps.success_withdraw'), 'tok');
    loadHeadOtherOpportunities();
  } catch (err) {
    console.error('[head.otherOpps.withdraw]', err);
    el.disabled = false;
    el.textContent = t('mp.opps.withdraw_btn');
  }
}
