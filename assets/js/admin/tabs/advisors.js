// Advisors tab — superadmin-only by RBAC. Plain CRUD over `advisors`.
//
// The renderer reads from DB.advisors (overwritten on every load) and writes
// the table out with inline action handlers that resolve to the editAdvisor
// and confirmDelete functions exposed on window by main.js.

import { DB, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, sv, tag, attrJson } from '../../lib/format.js';
import { api, apiGet, toast, openModal, closeModal, clearForm, filterTable } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';

// Status enum (Active / Inactive) → translation key. Tag color comes
// from STATUS_COLORS which is keyed off the canonical English value.
const STATUS_KEY = {
  Active:   'ap.status.active',
  Inactive: 'ap.status.inactive',
};

// ══════════════════════════════════════════
// ADVISORS
// ══════════════════════════════════════════
export async function loadAdvisors() {
  const data = await apiGet('getAdvisors');
  if (!data || !data.success) return;
  DB.advisors = data.data || [];
  _populateAdvisorRoleOptions();
  applyAdvisorFilters();
}

function _renderAdvisors(items) {
  const tbody = document.getElementById('advisors-tbody');
  if (!tbody) return;
  if (!items.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(t('ap.adv.empty'))}</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map(a => {
    const statusLabel = STATUS_KEY[a.status] ? t(STATUS_KEY[a.status]) : (a.status || '—');
    return `<tr>
      <td><strong>${esc(a.full_name)}</strong></td>
      <td>${esc(a.advisory_role) || '—'}</td>
      <td style="direction:ltr;font-size:.78rem">${esc(a.email) || '—'}</td>
      <td style="direction:ltr;font-size:.78rem">${esc(a.phone) || '—'}</td>
      <td><strong style="color:var(--g)">${a.total_hours || 0}</strong></td>
      <td>${tag(statusLabel, STATUS_COLORS[a.status] || 't-gr')}</td>
      <td>
        <button class="btn-icon edit" data-action="editAdvisor" data-id="${a.advisor_id}">✏️</button>
        <button class="btn-icon del" data-action="confirmDelete" data-type="advisor" data-id="${a.advisor_id}" data-name=${attrJson(a.full_name)}>🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

// Advisory role is a free-text column in the DB — populate the filter
// dropdown from the actual distinct values rather than a hardcoded list
// so a newly-typed role shows up automatically without needing a code
// change. Preserves the currently-selected value across reloads.
function _populateAdvisorRoleOptions() {
  const sel = document.getElementById('adv-filter-role');
  if (!sel) return;
  const current = sel.value;
  const roles = Array.from(new Set(
    (DB.advisors || [])
      .map(a => (a.advisory_role || '').trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b, 'ar'));
  sel.innerHTML = `<option value="" data-i18n="ap.adv.filter_role_all">${esc(t('ap.adv.filter_role_all'))}</option>`
    + roles.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
  if (current && roles.includes(current)) sel.value = current;
}

function _currentAdvisorFilters() {
  const status = document.querySelector('[data-action="filterAdvisorsByStatus"]')?.value || '';
  const role   = document.querySelector('[data-action="filterAdvisorsByRole"]')?.value   || '';
  const query  = document.querySelector('[data-action="filterAdvisorsBySearch"]')?.value?.trim() || '';
  return { status, role, query };
}

function applyAdvisorFilters() {
  const { status, role, query } = _currentAdvisorFilters();
  let filtered = (DB.advisors || []).slice();
  if (status) filtered = filtered.filter(a => a.status === status);
  if (role)   filtered = filtered.filter(a => (a.advisory_role || '') === role);
  _renderAdvisors(filtered);
  if (query) filterTable('advisors-tbody', query);
}

export function filterAdvisorsByStatus(_v) { applyAdvisorFilters(); }
export function filterAdvisorsByRole(_v)   { applyAdvisorFilters(); }
export function filterAdvisorsBySearch(_v) { applyAdvisorFilters(); }

export async function saveAdvisor() {
  const id = gv('adv-edit-id');
  const body = {
    full_name:    gv('adv-full-name'),
    advisory_role:gv('adv-role'),
    email:        gv('adv-email'),
    phone:        gv('adv-phone'),
    notes:        gv('adv-notes'),
    status:       gv('adv-status'),
  };
  if (!body.full_name) { toast(t('ap.adv.err_name_required'), 'twarn'); return; }
  let res;
  if (id) res = await api('updateAdvisor', { id, data: body });
  else     res = await api('createAdvisor', body);
  if (res) { toast(t('ap.adv.success_save')); closeModal('advisor'); clearForm('advisor'); loadAdvisors(); }
}

export function editAdvisor(id) {
  const a = DB.advisors.find(x => x.advisor_id === id);
  if (!a) return;
  sv('adv-edit-id', id);
  sv('adv-full-name', a.full_name); sv('adv-role', a.advisory_role);
  sv('adv-email', a.email); sv('adv-phone', a.phone);
  sv('adv-notes', a.notes); sv('adv-status', a.status);
  document.getElementById('advisor-modal-title').textContent = t('ap.adv.modal_edit');
  openModal('advisor');
}
